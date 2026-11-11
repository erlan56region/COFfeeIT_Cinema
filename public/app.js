/* ===== SyncWatch — клиент ===== */
const socket = io();

// Безопасное хранилище: в песочнице/приватном режиме localStorage может быть недоступен
const store = (() => {
  const memory = {};
  let ok = true;
  try {
    const probe = '__wp_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
  } catch (e) {
    ok = false;
  }
  return {
    get(key) {
      if (ok) { try { return window.localStorage.getItem(key); } catch (e) { ok = false; } }
      return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
    },
    set(key, value) {
      if (ok) { try { window.localStorage.setItem(key, value); return; } catch (e) { ok = false; } }
      memory[key] = String(value);
    }
  };
})();

// Состояние
let myName = store.get('wp_name') || '';
let myColor = store.get('wp_color') || '#4f46e5';
let roomId = null;
let currentVideo = null;
let ytPlayer = null;
let ytReady = false;
let vimeoPlayer = null;
let ytApiTried = false;
let isPlaying = false;
let duration = 0;
let suppressEvents = false;
let pendingVideo = null;
let usersCountNow = 1;

// Аватар — инициал имени
function initialFor(name) {
  const n = String(name || '?').trim();
  return (n[0] || '?').toUpperCase();
}
function greetFor(name) {
  return 'Здравствуйте';
}

// Элементы
const $ = (id) => document.getElementById(id);
const lobby = $('lobby'), appEl = $('app');
const nameInput = $('nameInput'), roomInput = $('roomInput');
const urlInput = $('urlInput');
const htmlVideo = $('htmlVideo');
const ytContainer = $('ytContainer');
const videoSlot = $('videoSlot');
const videoFallback = $('videoFallback');
const emptyState = $('emptyState');
const seekBar = $('seekBar'), volBar = $('volBar');
const curTimeEl = $('curTime'), durTimeEl = $('durTime');

// Инициализация лобби
nameInput.value = myName;
document.querySelectorAll('.color-dot').forEach(btn => {
  if (btn.dataset.color === myColor) { document.querySelectorAll('.color-dot').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); }
  btn.addEventListener('click', () => {
    document.querySelectorAll('.color-dot').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    myColor = btn.dataset.color;
    store.set('wp_color', myColor);
  });
});

const urlParams = new URLSearchParams(location.search);
if (urlParams.get('room')) roomInput.value = urlParams.get('room').toUpperCase();

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// Индикатор шагов: 1 комната, 2 участники, 3 видео
function updateSteps() {
  const s1 = $('step1'), s2 = $('step2'), s3 = $('step3'), hint = $('stepsHint');
  if (!s1) return;
  s1.className = 'step-pill done';
  s1.innerHTML = '<span class="step-check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg></span> Комната создана';
  if (usersCountNow > 1) {
    s2.className = 'step-pill done';
    s2.innerHTML = '<span class="step-check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg></span> Участники подключены';
  } else {
    s2.className = 'step-pill current';
    s2.innerHTML = '<span class="step-num">2</span> Пригласите участников';
  }
  if (currentVideo) {
    s3.className = 'step-pill done';
    s3.innerHTML = '<span class="step-check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg></span> Видео выбрано';
    hint.textContent = 'Нажмите «Воспроизвести» под плеером — у всех участников видео начнётся одновременно';
  } else if (usersCountNow > 1) {
    s3.className = 'step-pill current';
    s3.innerHTML = '<span class="step-num">3</span> Вставьте ссылку';
    hint.textContent = 'Вставьте ссылку на видео в поле ниже и нажмите «Смотреть»';
  } else {
    s3.className = 'step-pill';
    s3.innerHTML = '<span class="step-num">3</span> Вставьте ссылку';
    hint.textContent = 'Нажмите на код комнаты в шапке, чтобы скопировать ссылку-приглашение';
  }
}
function pulsePasteBox() {
  const box = $('pasteBox');
  if (!box) return;
  box.classList.remove('pulse');
  void box.offsetWidth;
  box.classList.add('pulse');
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : m;
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ===== Определение типа видео =====
function detectVideo(url) {
  url = (url || '').trim();
  if (!url) return null;
  const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  if (ytMatch) return { type: 'youtube', id: ytMatch[1], url, title: 'Видео с YouTube' };
  const vimeoMatch = url.match(/vimeo\.com\/(\d+)/);
  if (vimeoMatch) return { type: 'vimeo', id: vimeoMatch[1], url, title: 'Видео с Vimeo' };
  if (/\.(mp4|webm|mov|m4v|ogv)(\?.*)?$/i.test(url) || url.includes('googlevideo') || url.includes('.m3u8')) {
    const name = decodeURIComponent(url.split('/').pop().split('?')[0].replace(/\.(mp4|webm|mov|m4v|ogv)$/i, '').replace(/[-_]/g, ' ')) || 'Видео';
    return { type: 'direct', url, title: name };
  }
  if (/^https?:\/\//i.test(url)) return { type: 'direct', url, title: 'Видео по ссылке' };
  return null;
}

// ===== Плеер: единый интерфейс =====
let vimeoTime = 0;
function getTime() {
  if (!currentVideo) return 0;
  if (currentVideo.type === 'youtube') {
    if (ytPlayer && ytReady && typeof ytPlayer.getCurrentTime === 'function') {
      try { return ytPlayer.getCurrentTime() || 0; } catch(e) { return 0; }
    }
    return 0;
  }
  if (currentVideo.type === 'vimeo') return vimeoTime || 0;
  if (currentVideo.type === 'direct') return htmlVideo.currentTime || 0;
  return 0;
}
function getDuration() {
  if (!currentVideo) return 0;
  if (currentVideo.type === 'youtube') {
    if (ytPlayer && ytReady && typeof ytPlayer.getDuration === 'function') {
      try { return ytPlayer.getDuration() || 0; } catch(e) { return 0; }
    }
    return 0;
  }
  if (currentVideo.type === 'vimeo') return vimeoDuration || 0;
  if (currentVideo.type === 'direct') return htmlVideo.duration || 0;
  return 0;
}
let vimeoDuration = 0;
const ICON_PLAY = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5-11-6.5Z"/></svg>';
const ICON_PAUSE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
function doPlay(time) {
  if (!currentVideo) return;
  suppressEvents = true;
  if (currentVideo.type === 'youtube' && ytPlayer && ytReady) {
    if (typeof time === 'number') ytPlayer.seekTo(time, true);
    ytPlayer.playVideo();
  } else if (currentVideo.type === 'vimeo' && vimeoPlayer) {
    if (typeof time === 'number') vimeoPlayer.setCurrentTime(time).catch(()=>{});
    vimeoPlayer.play().catch(()=>{});
  } else if (currentVideo.type === 'direct') {
    if (typeof time === 'number') htmlVideo.currentTime = time;
    htmlVideo.play().catch(()=>{});
  }
  isPlaying = true;
  updatePlayBtn();
  setTimeout(() => suppressEvents = false, 300);
}
function doPause(time) {
  if (!currentVideo) return;
  suppressEvents = true;
  if (currentVideo.type === 'youtube' && ytPlayer && ytReady) {
    if (typeof time === 'number') ytPlayer.seekTo(time, true);
    ytPlayer.pauseVideo();
  } else if (currentVideo.type === 'vimeo' && vimeoPlayer) {
    if (typeof time === 'number') vimeoPlayer.setCurrentTime(time).catch(()=>{});
    vimeoPlayer.pause().catch(()=>{});
  } else if (currentVideo.type === 'direct') {
    if (typeof time === 'number') htmlVideo.currentTime = time;
    htmlVideo.pause();
  }
  isPlaying = false;
  updatePlayBtn();
  setTimeout(() => suppressEvents = false, 300);
}
function doSeek(time) {
  if (!currentVideo) return;
  if (currentVideo.type === 'youtube' && ytPlayer && ytReady) ytPlayer.seekTo(time, true);
  else if (currentVideo.type === 'vimeo' && vimeoPlayer) vimeoPlayer.setCurrentTime(time).catch(()=>{});
  else if (currentVideo.type === 'direct') htmlVideo.currentTime = time;
}
function updatePlayBtn() {
  $('playPauseBtn').innerHTML = isPlaying ? ICON_PAUSE : ICON_PLAY;
  $('bigPlay').classList.toggle('hidden', isPlaying || !currentVideo);
}

// ===== Загрузка видео =====
function clearPlayers() {
  if (ytPlayer) {
    try { ytPlayer.destroy(); } catch(e) {}
    ytPlayer = null;
  }
  ytReady = false;
  if (vimeoPlayer) {
    try { vimeoPlayer.destroy(); } catch(e) {}
    vimeoPlayer = null;
  }
  vimeoTime = 0;
  vimeoDuration = 0;
  htmlVideo.pause();
  htmlVideo.removeAttribute('src');
  htmlVideo.load();
}

function showFallback(video, reason) {
  videoFallback.classList.remove('hidden');
  videoSlot.classList.remove('hidden');
  const link = escapeHtml(video.url || '');
  videoFallback.innerHTML = `
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5.5M12 16.5h.01"/></svg>
    <h3>Не удалось воспроизвести видео</h3>
    <p>${reason || 'Файл недоступен по этой ссылке или формат не поддерживается браузером.'}</p>
    <div class="fb-actions">
      <a class="fb-link" href="${link}" target="_blank" rel="noopener">Открыть видео в новой вкладке</a>
    </div>`;
}
function hideFallback() {
  videoFallback.classList.add('hidden');
  videoFallback.innerHTML = '';
}

function loadVideo(video, autoplay) {
  currentVideo = video;
  isPlaying = false;
  duration = 0;
  emptyState.classList.add('hidden');
  $('npTitle').textContent = video.title || video.url;
  $('npBy').textContent = video.addedByName ? `— выбрал ${video.addedByName}` : '';
  hideFallback();
  videoSlot.classList.remove('hidden');

  if (video.type === 'youtube') {
    if (vimeoPlayer) { try { vimeoPlayer.destroy(); } catch(e){} vimeoPlayer = null; }
    htmlVideo.pause();
    htmlVideo.classList.add('hidden');
    ytContainer.classList.remove('hidden');

    if (!video.id) { showFallback(video, 'Не удалось определить идентификатор видео в ссылке.'); updatePlayBtn(); return; }

    if (typeof YT !== 'undefined' && YT.Player) {
      if (ytPlayer && ytReady) {
        try { ytPlayer.loadVideoById(video.id); } catch(e) { createYTPlayer(video.id); }
      } else {
        createYTPlayer(video.id);
      }
    } else {
      // API ещё не загрузилось — запоминаем и создадим плеер, как только оно будет готово
      pendingVideo = video;
      ensureYTApi();
      showLoadingPlaceholder();
    }
  } else if (video.type === 'vimeo') {
    if (ytPlayer) { try { ytPlayer.destroy(); } catch(e){} ytPlayer = null; ytReady = false; }
    htmlVideo.pause();
    htmlVideo.classList.add('hidden');
    ytContainer.classList.remove('hidden');
    ytContainer.innerHTML = '<div id="vimeoHolder" style="width:100%;height:100%"></div>';
    if (!video.id) { showFallback(video, 'Не удалось определить идентификатор видео Vimeo.'); updatePlayBtn(); return; }
    if (typeof Vimeo !== 'undefined' && Vimeo.Player) {
      createVimeoPlayer(video.id);
    } else {
      pendingVideo = video;
      ensureVimeoApi();
      showLoadingPlaceholder();
    }
  } else {
    if (ytPlayer) { try { ytPlayer.destroy(); } catch(e){} ytPlayer = null; ytReady = false; }
    if (vimeoPlayer) { try { vimeoPlayer.destroy(); } catch(e){} vimeoPlayer = null; }
    ytContainer.classList.add('hidden');
    htmlVideo.classList.remove('hidden');
    htmlVideo.src = video.url;
    htmlVideo.load();
    // если файл не ответил за 12 секунд — показываем понятное сообщение
    clearTimeout(window._directTimer);
    window._directTimer = setTimeout(() => {
      if (currentVideo === video && htmlVideo.readyState === 0) {
        showFallback(video, 'Видео не загружается. Возможно, ссылка устарела или сервер блокирует прямое воспроизведение.');
      }
    }, 12000);
  }
  updatePlayBtn();
  updateSteps();
  if (autoplay) setTimeout(() => { doPlay(0); socket.emit('play', { time: 0 }); }, 700);
}

function showLoadingPlaceholder() {
  videoFallback.classList.remove('hidden');
  videoFallback.innerHTML = '<p style="color:#94a3b8">Загружаем плеер…</p>';
}

function ensureYTApi() {
  if (typeof YT !== 'undefined' && YT.Player) return;
  if (ytApiTried) return;
  ytApiTried = true;
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  tag.onerror = () => {
    if (pendingVideo && pendingVideo.type === 'youtube') showFallback(pendingVideo, 'Не удалось загрузить плеер YouTube. Проверьте соединение с интернетом.');
  };
  document.head.appendChild(tag);
}

const VIMEO_JS = 'https://player.vimeo.com/api/player.js';
function ensureVimeoApi() {
  if (typeof Vimeo !== 'undefined' && Vimeo.Player) return;
  const tag = document.createElement('script');
  tag.src = VIMEO_JS;
  tag.onload = () => {
    if (pendingVideo && pendingVideo.type === 'vimeo') {
      createVimeoPlayer(pendingVideo.id);
      pendingVideo = null;
    }
  };
  tag.onerror = () => {
    if (pendingVideo && pendingVideo.type === 'vimeo') showFallback(pendingVideo, 'Не удалось загрузить плеер Vimeo. Проверьте соединение с интернетом.');
  };
  document.head.appendChild(tag);
}

function createVimeoPlayer(id) {
  try {
    vimeoPlayer = new Vimeo.Player('vimeoHolder', {
      id: Number(id),
      autoplay: false,
      title: false,
      byline: false,
      portrait: false
    });
    vimeoPlayer.on('loaded', (data) => { vimeoDuration = (data && data.duration) || 0; hideFallback(); });
    vimeoPlayer.on('timeupdate', (data) => { vimeoTime = (data && data.seconds) || 0; });
    vimeoPlayer.on('play', () => {
      if (suppressEvents) return;
      isPlaying = true; updatePlayBtn();
      socket.emit('play', { time: vimeoTime });
    });
    vimeoPlayer.on('pause', () => {
      if (suppressEvents) return;
      isPlaying = false; updatePlayBtn();
      socket.emit('pause', { time: vimeoTime });
    });
    vimeoPlayer.on('ended', () => {
      isPlaying = false; updatePlayBtn();
      socket.emit('queue_next');
    });
    vimeoPlayer.on('seeked', (data) => {
      vimeoTime = (data && data.seconds) || vimeoTime;
      if (suppressEvents) return;
      socket.emit('seek', { time: vimeoTime });
    });
    vimeoPlayer.on('error', () => {
      showFallback(currentVideo, 'Vimeo не разрешает встроенное воспроизведение этого видео.');
    });
    hideFallback();
  } catch (e) {
    showFallback(currentVideo, 'Не удалось создать плеер Vimeo.');
  }
}

function createYTPlayer(videoId) {
  ytContainer.innerHTML = '<div id="ytPlayer"></div>';
  ytReady = false;
  try {
    ytPlayer = new YT.Player('ytPlayer', {
      width: '100%', height: '100%',
      videoId: videoId || '',
      playerVars: { autoplay: 0, rel: 0, modestbranding: 1, playsinline: 1, origin: location.origin },
      events: {
        onReady: (e) => {
          ytReady = true;
          hideFallback();
          try { duration = e.target.getDuration() || 0; } catch(err) {}
          if (pendingVideo && pendingVideo.type === 'youtube' && pendingVideo.id !== videoId) {
            try { e.target.loadVideoById(pendingVideo.id); } catch(err) {}
          }
          pendingVideo = null;
          if (isPlaying) { try { e.target.playVideo(); } catch(err) {} }
        },
        onStateChange: (e) => {
          if (suppressEvents) return;
          if (e.data === YT.PlayerState.PLAYING) {
            isPlaying = true; updatePlayBtn();
            socket.emit('play', { time: getTime() });
          } else if (e.data === YT.PlayerState.PAUSED) {
            isPlaying = false; updatePlayBtn();
            socket.emit('pause', { time: getTime() });
          } else if (e.data === YT.PlayerState.ENDED) {
            isPlaying = false; updatePlayBtn();
            socket.emit('queue_next');
          }
        },
        onError: () => {
          showFallback(currentVideo, 'YouTube не разрешает встроенное воспроизведение этого видео (автор ограничил показ на сторонних сайтах).');
        }
      }
    });
  } catch (e) {
    showFallback(currentVideo, 'Не удалось создать плеер YouTube.');
  }
}

window.onYouTubeIframeAPIReady = function() {
  if (pendingVideo && pendingVideo.type === 'youtube') {
    createYTPlayer(pendingVideo.id);
  } else if (currentVideo && currentVideo.type === 'youtube') {
    createYTPlayer(currentVideo.id);
  }
};

htmlVideo.addEventListener('play', () => {
  if (suppressEvents) return;
  isPlaying = true; updatePlayBtn();
  socket.emit('play', { time: htmlVideo.currentTime });
});
htmlVideo.addEventListener('pause', () => {
  if (suppressEvents) return;
  isPlaying = false; updatePlayBtn();
  socket.emit('pause', { time: htmlVideo.currentTime });
});
htmlVideo.addEventListener('loadedmetadata', () => { hideFallback(); duration = htmlVideo.duration || 0; });
htmlVideo.addEventListener('ended', () => { isPlaying = false; updatePlayBtn(); socket.emit('queue_next'); });
htmlVideo.addEventListener('seeked', () => {
  if (suppressEvents) return;
  socket.emit('seek', { time: htmlVideo.currentTime });
});
htmlVideo.addEventListener('error', () => {
  if (!currentVideo || currentVideo.type !== 'direct') return;
  const code = htmlVideo.error && htmlVideo.error.code;
  const reason = code === 4
    ? 'Браузер не может воспроизвести этот файл: формат не поддерживается или ссылка недоступна. Попробуйте прямую ссылку на MP4 или видео с YouTube.'
    : 'Не удалось загрузить видео по ссылке. Проверьте, что ссылка открывается в браузере.';
  showFallback(currentVideo, reason);
});

// ===== Отправка видео =====
function submitUrl(toQueue) {
  const raw = urlInput.value.trim();
  if (!raw) { toast('Вставьте ссылку в поле выше'); pulsePasteBox(); urlInput.focus(); return; }
  const v = detectVideo(raw);
  if (!v) { toast('Не удалось распознать ссылку. Вставьте ссылку с YouTube, Vimeo или на видео (MP4)'); pulsePasteBox(); return; }
  if (toQueue) {
    socket.emit('queue_add', { url: v.url, type: v.type, title: v.title });
    toast('Добавлено в очередь');
  } else {
    socket.emit('set_video', { url: v.url, type: v.type, title: v.title });
    toast('Видео загружается у всех участников');
  }
  urlInput.value = '';
}
$('loadBtn').addEventListener('click', () => submitUrl(false));
$('queueBtn').addEventListener('click', () => submitUrl(true));
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitUrl(false); });

$('pasteFromClipboard').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.trim()) {
      urlInput.value = text.trim();
      toast('Ссылка вставлена. Нажмите «Смотреть»');
      urlInput.focus();
    } else {
      toast('Буфер обмена пуст. Скопируйте ссылку и попробуйте ещё раз');
    }
  } catch (e) {
    toast('Нажмите на поле и выберите «Вставить» из контекстного меню');
    urlInput.focus();
  }
});
document.querySelectorAll('.quick-btn').forEach(b => b.addEventListener('click', () => {
  urlInput.value = b.dataset.url;
  submitUrl(false);
}));

// ===== Управление плеером =====
$('playPauseBtn').addEventListener('click', () => {
  if (!currentVideo) { toast('Сначала вставьте ссылку на видео'); pulsePasteBox(); return; }
  if (isPlaying) { doPause(getTime()); socket.emit('pause', { time: getTime() }); }
  else { doPlay(getTime()); socket.emit('play', { time: getTime() }); }
});
$('bigPlay').addEventListener('click', () => {
  if (!currentVideo) return;
  doPlay(getTime()); socket.emit('play', { time: getTime() });
});
$('back10').addEventListener('click', () => { const t = Math.max(0, getTime() - 10); doSeek(t); socket.emit('seek', { time: t }); });
$('fwd10').addEventListener('click', () => { const t = getTime() + 10; doSeek(t); socket.emit('seek', { time: t }); });
$('fsBtn').addEventListener('click', async () => {
  const el = $('playerWrap');
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  try {
    if (fsEl) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else if (el.requestFullscreen) {
      await el.requestFullscreen();
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    } else if (htmlVideo.webkitEnterFullscreen && currentVideo && currentVideo.type === 'direct') {
      htmlVideo.webkitEnterFullscreen();
    } else {
      toast('Полноэкранный режим недоступен в этом браузере');
    }
  } catch (e) {
    toast('Не удалось открыть полноэкранный режим');
  }
});
function applyVolume() {
  const v = Number(volBar.value) / 100;
  try { htmlVideo.volume = v; } catch(e) {}
  if (ytPlayer && ytReady) { try { ytPlayer.setVolume(Number(volBar.value)); } catch(e) {} }
  if (vimeoPlayer) { try { vimeoPlayer.setVolume(v).catch(()=>{}); } catch(e) {} }
}
volBar.addEventListener('input', applyVolume);
let seeking = false;
seekBar.addEventListener('pointerdown', () => seeking = true);
seekBar.addEventListener('pointerup', () => seeking = false);
seekBar.addEventListener('change', () => {
  const d = getDuration();
  if (!d) return;
  const t = (seekBar.value / 100) * d;
  doSeek(t);
  socket.emit('seek', { time: t });
});

setInterval(() => {
  if (!currentVideo || seeking) return;
  const t = getTime(), d = getDuration();
  if (d > 0) {
    duration = d;
    seekBar.value = (t / d) * 100;
    curTimeEl.textContent = fmtTime(t);
    durTimeEl.textContent = fmtTime(d);
  } else {
    curTimeEl.textContent = fmtTime(t);
  }
}, 250);

setInterval(() => { if (roomId) socket.emit('sync_request'); }, 15000);

// ===== Вход / создание комнаты =====
function enterRoom() {
  myName = nameInput.value.trim() || 'Участник';
  store.set('wp_name', myName);
  $('greetingText').textContent = `${greetFor(myName)}, ${myName}`;
  lobby.classList.add('hidden');
  appEl.classList.remove('hidden');
  updateSteps();
  if (!store.get('wp_seen_help')) {
    setTimeout(() => { $('helpModal').classList.remove('hidden'); }, 600);
  }
  setTimeout(() => { if (!currentVideo) pulsePasteBox(); }, 900);
}
$('createBtn').addEventListener('click', () => {
  myName = nameInput.value.trim() || 'Участник';
  store.set('wp_name', myName);
  socket.emit('create_room', { name: myName, color: myColor });
});
$('joinBtn').addEventListener('click', () => {
  const code = roomInput.value.trim().toUpperCase();
  if (code.length < 4) { $('lobbyError').textContent = 'Введите код комнаты (6 символов)'; return; }
  myName = nameInput.value.trim() || 'Участник';
  store.set('wp_name', myName);
  $('lobbyError').textContent = '';
  socket.emit('join_room', { roomId: code, name: myName, color: myColor });
});
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('createBtn').click(); });
roomInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });

socket.on('room_created', (state) => { applyState(state); enterRoom(); welcomeMessage(); toast('Комната создана. Отправьте код участникам'); });
socket.on('room_joined', (state) => { applyState(state); enterRoom(); welcomeMessage(); toast('Вы подключены к комнате'); });
socket.on('app_error', (e) => {
  const message = (e && e.message) || 'Произошла ошибка';
  if (appEl.classList.contains('hidden')) $('lobbyError').textContent = message;
  else toast(message);
});
// Системные ошибки соединения
socket.on('connect_error', () => toast('Нет соединения с сервером. Проверьте интернет'));
socket.on('reconnect', () => {
  if (!roomId) return;
  socket.emit('join_room', { roomId, name: myName, color: myColor });
  toast('Соединение восстановлено');
});

// Догоняем состояние комнаты, даже если плеер ещё инициализируется
function syncToState(state, attempt) {
  if (!currentVideo) return;
  const ready = state.video && (
    (currentVideo.type === 'direct' && htmlVideo.readyState > 0) ||
    (currentVideo.type === 'youtube' && ytReady) ||
    (currentVideo.type === 'vimeo' && vimeoPlayer)
  );
  if (!ready && attempt < 20) {
    setTimeout(() => syncToState(state, attempt + 1), 500);
    return;
  }
  if (state.playing) doPlay(state.position);
  else if (typeof state.position === 'number' && state.position > 0) doSeek(state.position);
}

function applyState(state) {
  if (!state) return;
  roomId = state.roomId;
  $('roomCode').textContent = roomId;
  history.replaceState(null, '', '?room=' + roomId);
  renderUsers(state.users, state.hostId);
  if (state.video) {
    const v = normalizeVideo(state.video);
    if (v) {
      loadVideo(v, false);
      syncToState(state, 0);
    }
  }
  if (Array.isArray(state.messages) && state.messages.length) {
    $('chatMessages').innerHTML = '';
    state.messages.slice(-40).forEach(m => addChatMessage(m, false));
    const box = $('chatMessages');
    box.scrollTop = box.scrollHeight;
  }
  renderQueue(state.queue || []);
}

// ===== Сокет: видео и синхронизация =====
// Из состояния сервера всегда строим объект видео одним способом
function normalizeVideo(video) {
  if (!video || !video.url) return null;
  const detected = detectVideo(video.url) || { type: video.type || 'direct' };
  return {
    type: detected.type,
    id: detected.id,
    url: video.url,
    title: video.title || detected.title || 'Видео',
    addedByName: video.addedByName
  };
}

socket.on('video_changed', ({ video }) => {
  const v = normalizeVideo(video);
  if (!v) return;
  loadVideo(v, false);
  addSystem(`Сейчас смотрят: ${video.title || v.title}`);
});

socket.on('remote_play', ({ time }) => {
  if (!currentVideo) return;
  const drift = Math.abs(getTime() - time);
  if (!isPlaying || drift > 2) doPlay(time); else if (drift > 0.5) doSeek(time);
  isPlaying = true; updatePlayBtn();
});
socket.on('remote_pause', ({ time }) => { doPause(time); });
socket.on('remote_seek', ({ time }) => { doSeek(time); });

socket.on('sync_state', (state) => {
  if (!state || !state.video || !currentVideo) return;
  const drift = Math.abs(getTime() - state.position);
  if (drift > 2.5) {
    if (state.playing) doPlay(state.position);
    else doSeek(state.position);
  }
  if (state.playing && !isPlaying) doPlay(state.position);
  if (!state.playing && isPlaying) doPause(state.position);
});

// ===== Пользователи =====
socket.on('users_update', (state) => { if (state) renderUsers(state.users, state.hostId); });

function renderUsers(users, hostId) {
  usersCountNow = users.length;
  $('usersCount').textContent = users.length;
  updateSteps();
  const list = $('usersList');
  list.innerHTML = '';
  users.forEach(u => {
    const row = document.createElement('div');
    row.className = 'user-row';
    const isMe = u.id === socket.id;
    row.innerHTML = `
      <div class="avatar" style="background:${u.color}">${escapeHtml(initialFor(u.name))}</div>
      <span class="u-name">${escapeHtml(u.name)}</span>
      ${u.id === hostId ? '<span class="host-tag">Организатор</span>' : ''}
      ${isMe ? '<span class="you-tag">Вы</span>' : ''}
    `;
    list.appendChild(row);
  });
}

// ===== Чат =====
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function addSystem(text) {
  const box = $('chatMessages');
  const el = document.createElement('div');
  el.className = 'system-msg';
  el.textContent = text;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}
socket.on('system_message', ({ text }) => addSystem(text));

function addChatMessage(msg, scroll = true) {
  const box = $('chatMessages');
  const el = document.createElement('div');
  el.className = 'msg';
  const time = new Date(msg.time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `
    <div class="avatar" style="background:${escapeHtml(msg.color || '#64748b')}">${escapeHtml(initialFor(msg.name))}</div>
    <div class="msg-body">
      <div class="msg-name" style="color:${escapeHtml(msg.color || '#64748b')}">${escapeHtml(msg.name)}</div>
      <div class="msg-text">${escapeHtml(msg.text)}</div>
      <div class="msg-time">${time}</div>
    </div>`;
  box.appendChild(el);
  if (scroll) box.scrollTop = box.scrollHeight;
}
socket.on('chat_message', (msg) => { if (msg) addChatMessage(msg); });

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  socket.emit('chat_message', { text });
  $('chatInput').value = '';
});

// ===== Реакции =====
// Иконки в аккуратном линейном стиле вместо системных эмодзи
const REACTIONS = {
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 5.6a5.5 5.5 0 0 0-7.8 0L12 6.6l-1-1a5.5 5.5 0 0 0-7.8 7.8L12 22l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg>',
  fire: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2s5 4.5 5 9a5 5 0 0 1-10 0c0-1.5.6-2.8 1.5-3.8C9 8.9 10 10 11 10.5 10.5 7 12 3 12 2Z"/><path d="M8.5 17.5a3.5 3.5 0 0 0 7 0"/></svg>',
  laugh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M7.5 9.5h.01M16.5 9.5h.01"/><path d="M7.5 14a5.5 5.5 0 0 0 9 0"/></svg>',
  wow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M8 9.5h.01M16 9.5h.01"/><ellipse cx="12" cy="15.5" rx="2.2" ry="2.6"/></svg>',
  clap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21a7 7 0 0 1-7-7V9a1.8 1.8 0 0 1 3.6 0v2-4.5a1.8 1.8 0 0 1 3.6 0V11 5.5a1.8 1.8 0 0 1 3.6 0V11"/><path d="M18.8 11.5a1.8 1.8 0 0 1 3.6 0V15a6 6 0 0 1-6 6Z"/></svg>',
  sad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M8 10h.01M16 10h.01"/><path d="M8 17a5 5 0 0 1 8 0"/><path d="M10.5 6.5c.6-1 2.4-1 3 0"/></svg>',
  party: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3Z"/><path d="M18 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z"/></svg>'
};

function spawnReaction(key) {
  const layer = $('reactionLayer');
  const el = document.createElement('div');
  el.className = 'float-emoji';
  el.innerHTML = REACTIONS[key] || '';
  el.style.left = (10 + Math.random() * 80) + '%';
  el.style.color = ['#fca5a5','#fcd34d','#a5b4fc','#6ee7b7','#f9a8d4','#93c5fd'][Math.floor(Math.random()*6)];
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2900);
}
document.querySelectorAll('.react-btn').forEach(b => b.addEventListener('click', () => {
  socket.emit('reaction', { emoji: b.dataset.emoji });
  spawnReaction(b.dataset.emoji);
}));
socket.on('reaction', ({ emoji }) => spawnReaction(emoji));

// ===== Очередь =====
socket.on('queue_update', (queue) => renderQueue(queue));
function renderQueue(queue) {
  const list = $('queueList');
  const badge = $('queueBadge');
  badge.textContent = queue.length;
  badge.classList.toggle('hidden', queue.length === 0);
  if (!queue.length) {
    list.innerHTML = '<p class="muted">Очередь пуста.<br>Добавьте видео кнопкой «В очередь».</p>';
    return;
  }
  list.innerHTML = '';
  queue.forEach(item => {
    const el = document.createElement('div');
    el.className = 'queue-item';
    el.innerHTML = `
      <div style="flex:1;min-width:0">
        <div class="q-title">${escapeHtml(item.title)}</div>
        <div class="q-by">добавил ${escapeHtml(item.addedByName || '')}</div>
      </div>
      <button class="q-remove" title="Убрать" aria-label="Убрать из очереди"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`;
    el.querySelector('.q-remove').addEventListener('click', () => socket.emit('queue_remove', { id: item.id }));
    list.appendChild(el);
  });
}
$('nextBtn').addEventListener('click', () => socket.emit('queue_next'));

// ===== Вкладки =====
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  tab.classList.add('active');
  $('tab-' + tab.dataset.tab).classList.add('active');
}));

// ===== Копирование комнаты / выход =====
// Копирование с запасным способом (Clipboard API доступен не всегда)
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* переходим к запасному способу */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch (e) {
    return false;
  }
}

$('copyRoomBtn').addEventListener('click', async () => {
  if (!roomId) return;
  const link = location.origin + location.pathname + '?room=' + roomId;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'SyncWatch', text: 'Присоединитесь к просмотру видео', url: link });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  const copied = await copyText(link);
  if (copied) {
    toast('Ссылка-приглашение скопирована');
  } else {
    // последний вариант: показываем ссылку в поле ввода, чтобы её можно было скопировать вручную
    urlInput.value = link;
    urlInput.focus();
    urlInput.select();
    toast('Скопируйте ссылку из поля ввода и отправьте участникам');
  }
});
$('leaveBtn').addEventListener('click', () => location.href = location.pathname);

// ===== Справка =====
function closeHelp() {
  $('helpModal').classList.add('hidden');
  store.set('wp_seen_help', '1');
}
$('helpBtn').addEventListener('click', () => $('helpModal').classList.remove('hidden'));
$('helpClose').addEventListener('click', closeHelp);
$('helpOk').addEventListener('click', closeHelp);
$('helpModal').addEventListener('click', (e) => { if (e.target === $('helpModal')) closeHelp(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHelp(); });

// Приветствие в чате после входа в комнату
function welcomeMessage() {
  setTimeout(() => addSystem('Добро пожаловать. Вставьте ссылку выше, чтобы начать просмотр'), 700);
}
