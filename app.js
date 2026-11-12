/* ===== SyncWatch — клиент ===== */

// Сайт работает в одном из двух режимов (см. config.js):
//  - адрес сервера не задан — режим без сервера: участники соединяются напрямую (p2p.js);
//  - адрес сервера задан — комнаты ведёт server.js, связь через Socket.IO.
// Сайт, открытый с самого server.js, получает его адрес автоматически.
const SERVER_URL = String(window.SYNCWATCH_SERVER || '').trim().replace(/\/+$/, '');
const P2P_MODE = !SERVER_URL;
// Библиотеки лежат рядом с сайтом. Если нужная не загрузилась, интерфейс всё равно должен открыться
const TRANSPORT_LOADED = P2P_MODE ? !!(window.SyncP2P && window.SyncP2P.createSocket) : typeof io === 'function';

const socket = !TRANSPORT_LOADED
  ? { connected: false, on() {}, emit() {}, disconnect() {} }
  : P2P_MODE
    ? window.SyncP2P.createSocket({ peer: window.SYNCWATCH_PEER || undefined })
    : io(SERVER_URL);

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
let embed = null;           // встроенный плеер Rutube или VK Видео (см. раздел «Rutube и VK Видео»)
let hls = null;             // проигрыватель потоков HLS (см. раздел «Потоки HLS»)

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
    const isLink = currentVideo.type === 'link';
    s3.className = 'step-pill done';
    s3.innerHTML = '<span class="step-check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg></span> ' + (isLink ? 'Ссылка выбрана' : 'Видео выбрано');
    hint.textContent = isLink
      ? 'Ссылка на сайт видна всем участникам — каждый открывает её в своём браузере'
      : 'Нажмите «Воспроизвести» под плеером — у всех участников видео начнётся одновременно';
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

// ===== Определение типа ссылки =====
// youtube, vimeo, rutube, vk — встроенные плееры этих сервисов; direct — видеофайл или поток HLS,
// его показывает сам браузер;
// link — страница любого другого сайта: в комнате видна ссылка, открывает её каждый у себя в браузере.

// Расширения файлов, которые браузер воспроизводит как видео или звук
const MEDIA_EXT = /\.(mp4|m4v|webm|mov|ogv|mkv|avi|m3u8|mp3|m4a|ogg|oga|wav|flac|aac|opus)$/i;

// Годятся только адреса http и https
function parseHttpUrl(url) {
  try {
    const u = new URL(url);
    // знак % в имени сайта остаётся только от недопустимых символов, например от пробела
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname && !u.hostname.includes('%') ? u : null;
  } catch (e) {
    return null;
  }
}

// Название сайта для показа — его домен. Всегда берётся из самого адреса, а не из присланного названия:
// так участник видит, куда на самом деле ведёт ссылка.
function siteName(url) {
  const parsed = parseHttpUrl(url);
  if (!parsed) return 'Сайт';
  let host = parsed.hostname;
  // Домены вроде «кино.рф» браузер отдаёт в служебной записи (xn--…). Показываем их буквами,
  // только если так набран сам адрес и домен верхнего уровня кириллический — иначе буквы могут
  // подделывать латинский адрес.
  if (/(^|\.)xn--/.test(host)) {
    const typed = (/^https?:\/\/([^\/?#]*)/i.exec(url) || [])[1] || '';
    const raw = typed.replace(/^.*@/, '').replace(/:\d*$/, '').toLowerCase();
    const labels = raw.split('.');
    const plain = labels.every((l) => /^[a-z0-9-]+$/.test(l) || /^[а-яё0-9-]+$/.test(l));
    if (plain && /^[а-яё]+$/.test(labels[labels.length - 1])) {
      try { if (new URL('http://' + raw).hostname === host) host = raw; } catch (e) { /* оставляем служебную запись */ }
    }
  }
  return host.replace(/^www\./, '') || 'Сайт';
}

// Название видеофайла — имя файла без расширения
function fileTitle(pathname) {
  let name = pathname.split('/').pop().replace(MEDIA_EXT, '');
  try { name = decodeURIComponent(name); } catch (e) { /* оставляем как есть */ }
  return name.replace(/[-_]+/g, ' ').trim() || 'Видео';
}

// Rutube и VK Видео: из ссылки на страницу видео получаем адрес плеера для вставки на сайт.
// Rutube — https://rutube.ru/info/embed/, VK Видео — https://dev.vk.com/ru/widgets/video
const RUTUBE_HOST = /^(?:www\.|m\.)?rutube\.ru$/i;
const VK_HOST = /^(?:www\.|m\.)?(vk\.com|vk\.ru|vkvideo\.ru)$/i;
const VK_EMBED_HOSTS = ['vk.com', 'vk.ru'];   // сайты, с которых берём плеер VK Видео и его библиотеку: основной и запасной

// rutube.ru/video/<id>/, /video/private/<id>/?p=<ключ>, /shorts/<id>/, /live/video/<id>/, /play/embed/<id>
function rutubeEmbed(parsed) {
  if (!RUTUBE_HOST.test(parsed.hostname)) return null;
  const m = /^\/(?:video\/(?:private\/)?|shorts\/|live\/video\/|play\/embed\/)([0-9a-f]{32})(?:\/|$)/i.exec(parsed.pathname);
  if (!m) return null;
  const id = m[1].toLowerCase();
  // видео с доступом «только по ссылке» открывается с ключом из параметра p
  const key = parsed.searchParams.get('p') || '';
  return { id, src: `https://rutube.ru/play/embed/${id}` + (/^[\w-]{1,80}$/.test(key) ? `/?p=${key}` : '') };
}

// vk.com/video-1_2, vkvideo.ru/video-1_2, vk.com/clip-1_2, …?z=video-1_2, video_ext.php?oid=-1&id=2
function vkEmbed(parsed) {
  if (!VK_HOST.test(parsed.hostname)) return null;
  let oid = '', vid = '', hash = '';
  if (/^\/video_ext\.php$/i.test(parsed.pathname)) {
    oid = parsed.searchParams.get('oid') || '';
    vid = parsed.searchParams.get('id') || '';
    hash = parsed.searchParams.get('hash') || '';
  } else {
    const m = /(?:^|\/)(?:video|clip)(-?\d+)_(\d+)/.exec(parsed.pathname)
      || /(?:^|[^a-z])(?:video|clip)(-?\d+)_(\d+)/i.exec(parsed.searchParams.get('z') || '');
    if (m) { oid = m[1]; vid = m[2]; }
  }
  if (!/^-?\d{1,18}$/.test(oid) || !/^\d{1,18}$/.test(vid)) return null;
  // js_api=1 включает управление плеером со страницы. Видео на vk.com, vk.ru и vkvideo.ru одни и те же,
  // поэтому плеер всегда открываем на vk.com, а vk.ru — запасной адрес (см. connectVk).
  const query = `/video_ext.php?oid=${oid}&id=${vid}&hd=2&js_api=1`
    + (/^[0-9a-z]{4,64}$/i.test(hash) ? `&hash=${hash}` : '');
  return { id: `${oid}_${vid}`, src: `https://${VK_EMBED_HOSTS[0]}${query}`, alt: `https://${VK_EMBED_HOSTS[1]}${query}` };
}

function detectVideo(url) {
  url = (url || '').trim();
  if (!url) return null;
  const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  if (ytMatch) return { type: 'youtube', id: ytMatch[1], url, title: 'Видео с YouTube' };
  const vimeoMatch = url.match(/vimeo\.com\/(\d+)/);
  if (vimeoMatch) return { type: 'vimeo', id: vimeoMatch[1], url, title: 'Видео с Vimeo' };
  const parsed = parseHttpUrl(url);
  if (!parsed) return null;
  const rutube = rutubeEmbed(parsed);
  if (rutube) return { type: 'rutube', id: rutube.id, url, title: 'Видео с Rutube' };
  const vk = vkEmbed(parsed);
  if (vk) return { type: 'vk', id: vk.id, url, title: 'Видео из VK' };
  if (MEDIA_EXT.test(parsed.pathname) || url.includes('googlevideo') || url.includes('.m3u8')) {
    return { type: 'direct', url, title: fileTitle(parsed.pathname) };
  }
  return { type: 'link', url, title: siteName(url) };
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
  if (embed && embed.type === currentVideo.type) return embedPosition(embed);
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
  if (embed && embed.type === currentVideo.type) return embed.duration || 0;
  return 0;
}
let vimeoDuration = 0;
const ICON_PLAY = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5-11-6.5Z"/></svg>';
const ICON_PAUSE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
// Перемотка, которую выполнил сам сайт: своя кнопка или команда от другого участника.
// Плеер сообщает о ней событием seeked. Такое событие дальше не рассылаем — иначе участники
// без конца пересылали бы друг другу одну и ту же перемотку.
let ownSeek = null;
function markOwnSeek(time) {
  if (typeof time !== 'number') return;
  const d = getDuration();
  ownSeek = { time: d > 0 ? Math.min(time, d) : time, at: Date.now(), seen: false };
}
function isOwnSeek(position) {
  if (!ownSeek) return false;
  const age = Date.now() - ownSeek.at;
  const near = Math.abs(position - ownSeek.time) < 1.5;
  if (age < 1000) { if (near) ownSeek.seen = true; return true; }
  // При медленной сети плеер перематывает дольше секунды: его запоздавшее событие пропускаем один раз.
  // Следующая перемотка в то же место — уже действие самого зрителя, её рассылаем.
  const late = !ownSeek.seen && age < 30000 && near;
  ownSeek = null;
  return late;
}
// Пока страница «спит» (свёрнутый браузер на телефоне, сон ноутбука), её таймеры стоят, а видео браузер
// ставит на паузу сам. Проснувшись, плеер сообщает об этой паузе — с позицией, на которой страница уснула.
// Зритель ничего не нажимал, поэтому такие события не рассылаем: иначе просмотр у всех отбросило бы назад.
// Вместо этого запрашиваем текущее состояние комнаты и догоняем остальных.
const WAKE_GAP = 5000;    // ежесекундный таймер молчал дольше — страница спала
const WAKE_QUIET = 2500;  // столько после пробуждения события плеера не рассылаются
let lastTick = Date.now();
let wokeAt = 0;
function justWoke() {
  const now = Date.now();
  if (now - lastTick > WAKE_GAP) {
    wokeAt = now;
    setTimeout(() => { if (roomId) socket.emit('sync_request'); }, 1200);
  }
  lastTick = now;
  return now - wokeAt < WAKE_QUIET;
}
setInterval(justWoke, 1000);
function doPlay(time) {
  if (!currentVideo || currentVideo.type === 'link') return;
  suppressEvents = true;
  markOwnSeek(time);
  if (currentVideo.type === 'youtube' && ytPlayer && ytReady) {
    if (typeof time === 'number') ytPlayer.seekTo(time, true);
    ytPlayer.playVideo();
  } else if (currentVideo.type === 'vimeo' && vimeoPlayer) {
    if (typeof time === 'number') vimeoPlayer.setCurrentTime(time).catch(()=>{});
    vimeoPlayer.play().catch(()=>{});
  } else if (currentVideo.type === 'direct') {
    if (isLiveStream()) catchUpLive();
    else if (typeof time === 'number') htmlVideo.currentTime = time;
    htmlVideo.play().catch(()=>{});
  } else if (embed && embed.type === currentVideo.type) {
    embedCommand(embed, true, time);
  }
  isPlaying = true;
  updatePlayBtn();
  setTimeout(() => suppressEvents = false, 300);
}
function doPause(time) {
  if (!currentVideo || currentVideo.type === 'link') return;
  suppressEvents = true;
  markOwnSeek(time);
  if (currentVideo.type === 'youtube' && ytPlayer && ytReady) {
    if (typeof time === 'number') ytPlayer.seekTo(time, true);
    ytPlayer.pauseVideo();
  } else if (currentVideo.type === 'vimeo' && vimeoPlayer) {
    if (typeof time === 'number') vimeoPlayer.setCurrentTime(time).catch(()=>{});
    vimeoPlayer.pause().catch(()=>{});
  } else if (currentVideo.type === 'direct') {
    if (typeof time === 'number' && !isLiveStream()) htmlVideo.currentTime = time;
    htmlVideo.pause();
  } else if (embed && embed.type === currentVideo.type) {
    embedCommand(embed, false, time);
  }
  isPlaying = false;
  updatePlayBtn();
  setTimeout(() => suppressEvents = false, 300);
}
function doSeek(time) {
  if (!currentVideo || currentVideo.type === 'link' || typeof time !== 'number' || !Number.isFinite(time)) return;
  markOwnSeek(time);
  if (currentVideo.type === 'youtube' && ytPlayer && ytReady) ytPlayer.seekTo(time, true);
  else if (currentVideo.type === 'vimeo' && vimeoPlayer) vimeoPlayer.setCurrentTime(time).catch(()=>{});
  else if (currentVideo.type === 'direct') { if (!isLiveStream()) htmlVideo.currentTime = time; }
  else if (embed && embed.type === currentVideo.type) embedCommand(embed, isPlaying, time);
}
function updatePlayBtn() {
  $('playPauseBtn').innerHTML = isPlaying ? ICON_PAUSE : ICON_PLAY;
  $('bigPlay').classList.toggle('hidden', isPlaying || !currentVideo || currentVideo.type === 'link');
}

// ===== Rutube и VK Видео: встроенные плееры =====
// Оба плеера работают в своём окне (iframe) и общаются со страницей сообщениями. У каждого свои команды
// и события (см. connectRutube и connectVk), остальной код для них общий.
//
// Как это устроено:
// - want — последняя команда комнаты: «идёт с такого-то места» или «стоит на таком-то месте». Плеер
//   выполняет её сразу, а если ещё загружается или показывает рекламу — как только сможет;
// - свою позицию плеер сообщает время от времени, между сообщениями она досчитывается по часам;
// - на каждую команду сайта плеер отвечает событием. Такой отклик узнаём по тому, что он совпадает
//   с отправленной командой. Остальные события — действия зрителя в самом плеере: о них узнают все участники.
const EMBED_NAMES = { rutube: 'Rutube', vk: 'VK Видео' };
const EMBED_ECHO = 2000;         // столько ждём от плеера отклика на команду «играть» или «пауза»
const EMBED_SETTLE = 1200;       // столько плеер может «устраиваться» после перемотки: остановиться и пойти дальше
const EMBED_CATCH_WAIT = 8000;   // столько после перемотки ждём, что плеер сам догонит комнату
const EMBED_READY_WAIT = 20000;  // плеер не ответил за это время — сообщаем зрителю
const EMBED_START_WAIT = 8000;   // видео не началось за это время — подсказываем нажать на сам плеер
const EMBED_AD_MAX = 180000;     // если плеер не сообщил о конце рекламы, через это время считаем её законченной
const EMBED_DEBUG = /[?&]debug\b/.test(location.search);   // «?debug» в адресе сайта — сообщения плееров видны в консоли

function embedLog(...args) {
  if (EMBED_DEBUG) console.log('[плеер]', ...args);
}

// Место, на котором сейчас комната, по её последней команде
function wantTime(want) {
  return Math.max(0, want.playing ? want.time + (Date.now() - want.at) / 1000 : want.time);
}
function embedAdNow(e) {
  return e.ad && Date.now() < e.adUntil;
}
// Позиция по сообщениям самого плеера. На время рекламы видео стоит там, где она его прервала
function embedOwnTime(e) {
  if (embedAdNow(e)) return e.adFrom;
  const t = e.playing ? e.time + (Date.now() - e.at) / 1000 : e.time;
  return e.duration > 0 ? Math.min(t, e.duration) : t;
}
// Позиция для остального кода сайта. Пока плеер загружается или показывает рекламу, своей позиции
// у него нет — тогда это место, на котором сейчас комната.
function embedPosition(e) {
  return !e.ready || !e.at || embedAdNow(e) ? wantTime(e.want) : embedOwnTime(e);
}

function startEmbed(video) {
  const parsed = parseHttpUrl(video.url);
  const info = parsed && (video.type === 'rutube' ? rutubeEmbed(parsed) : vkEmbed(parsed));
  if (!info) { showFallback(video, 'Не удалось определить идентификатор видео в ссылке.'); return; }
  const frame = document.createElement('iframe');
  frame.src = info.src;
  frame.title = 'Плеер ' + EMBED_NAMES[video.type];
  // разрешения — те же, что в коде для вставки у самих сервисов
  frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture; screen-wake-lock; clipboard-write';
  frame.allowFullscreen = true;
  frame.setAttribute('frameborder', '0');
  ytContainer.innerHTML = '';
  ytContainer.appendChild(frame);
  const e = {
    type: video.type,
    frame,
    alt: info.alt || '',     // запасной адрес плеера
    send: null,              // команды конкретного плеера: play, pause, seek, volume
    off: null,               // отключение от плеера
    ready: false,            // плеер загрузился и принимает команды
    playing: false,          // идёт ли видео в самом плеере
    started: false,          // плеер начал воспроизведение после последней команды «играть»
    everPlayed: false,       // видео в этом плеере хотя бы раз шло
    time: 0, at: 0,          // последняя известная позиция и момент, когда она получена
    exact: video.type === 'rutube',  // плеер сообщает время с долями секунды (VK Видео — не всегда)
    duration: 0,
    last: null,              // предыдущее сообщение плеера о времени: { r, at }
    want: { playing: false, time: 0, at: Date.now() },
    mine: null,              // команда «играть», которую дал сам зритель: { want, at }
    expect: [],              // отклики, которых сайт ждёт от плеера на свои команды: { playing, until }
    settleUntil: 0,          // до этого момента плеер занят перемоткой
    ownSeek: null,           // перемотка, которую запросил сайт: { time, at, until }
    sent: null,              // перемотка зрителя, о которой уже сообщили комнате: { time, at }
    check: 0,                // сколько раз ещё можно повторить перемотку, если плеер её не выполнил
    checkTime: 0, checkAt: 0,
    resuming: false,         // после команды сайта ждём, когда видео снова пойдёт: тогда видно, насколько плеер отстал
    caughtUp: false,         // отставание после перемотки для этой команды уже исправляли
    sought: 0,               // момент, когда плеер сообщил о перемотке
    caughtAt: 0,             // момент последнего «догоняния» комнаты
    ad: false, adUntil: 0, adFrom: 0, adAt: 0,
    ended: false, failed: false, hinted: false, troubled: false,
    readyTimer: null, startTimer: null, pauseTimer: null
  };
  embed = e;
  if (e.type === 'rutube') connectRutube(e); else connectVk(e);
  e.readyTimer = setTimeout(() => { if (embed === e && !e.ready) embedTrouble(e); }, EMBED_READY_WAIT);
}

function destroyEmbed() {
  const e = embed;
  if (!e) return;
  embed = null;
  clearTimeout(e.readyTimer);
  clearTimeout(e.startTimer);
  clearTimeout(e.pauseTimer);
  if (e.off) { try { e.off(); } catch (err) { /* плеер уже отключён */ } }
  e.frame.remove();
}

// Плеер не отвечает. Само окно плеера не закрываем: возможно, видео в нём всё-таки можно смотреть
function embedTrouble(e) {
  if (e.troubled) return;
  const name = EMBED_NAMES[e.type];
  e.troubled = true;
  $('controlsHint').textContent = `Плеер ${name} не отвечает на команды сайта: возможно, он не загрузился или его блокирует расширение браузера. Общие кнопки для этого видео пока не работают.`;
  toast(`Плеер ${name} не отвечает. Проверьте, открывается ли это видео на сайте ${name}`);
}

// ----- Команды сайта плееру -----
// playing — видео идёт или стоит; time — с какого места (если не задано, с текущего)
function embedCommand(e, playing, time) {
  const seek = typeof time === 'number' && Number.isFinite(time);
  // Сверка с комнатой (раз в 15 секунд) может повторить команду, которую плеер ещё выполняет: после перемотки
  // он подгружал видео, отстал и вот-вот догонит комнату сам (см. embedTimeReport). Ещё одна перемотка
  // на то же место только отбросила бы его назад.
  if (seek && playing && e.want.playing && e.ready && e.resuming && Date.now() - e.checkAt < EMBED_CATCH_WAIT
      && Math.abs(time - wantTime(e.want)) < 1) return;
  e.want = { playing, time: seek ? Math.max(0, time) : embedPosition(e), at: Date.now() };
  e.caughtUp = false;
  if (playing) e.ended = false;
  clearTimeout(e.pauseTimer);
  applyWant(e, seek);
}

function applyWant(e, seek) {
  if (!e.ready) return;                 // плеер ещё загружается: команда будет выполнена в embedReady
  const want = e.want;
  const t = wantTime(want);
  const finished = e.duration > 0 && t >= e.duration - 0.5;
  // Если плеер и так на нужном месте, перемотка не нужна: она только заставила бы его заново загружать
  // видео. На паузе место выставляем точнее — зрители должны видеть один и тот же кадр.
  const near = want.playing ? 0.5 : 0.15;
  if (seek && !finished && Math.abs(embedOwnTime(e) - t) > near) embedSeekTo(e, t, 2);
  if (!want.playing) {
    embedLog('→ пауза');
    embedExpect(e, false);
    e.send.pause();
    return;
  }
  if (finished) return;                 // видео уже закончилось — заново его не запускаем
  if (!e.playing) {
    e.started = false;
    e.resuming = true;
    clearTimeout(e.startTimer);
    e.startTimer = setTimeout(() => embedStartHint(e), EMBED_START_WAIT);
  }
  embedLog('→ воспроизведение');
  embedExpect(e, true);
  e.send.play();
}

// t — куда перемотать; checks — сколько раз можно повторить команду, если плеер её не выполнит;
// assumed — где считать плеер до его первого сообщения (обычно там же, куда перематываем)
function embedSeekTo(e, t, checks, assumed) {
  const now = Date.now();
  embedLog('→ перемотка', t.toFixed(1));
  e.send.seek(t);
  e.time = typeof assumed === 'number' ? assumed : t;
  e.at = now;
  e.last = null;
  e.settleUntil = now + EMBED_SETTLE;
  e.ownSeek = { time: t, at: now, until: now + 30000 };
  e.check = checks;
  e.checkTime = t;
  e.checkAt = now;
  e.resuming = true;
}

// Сайт отправил плееру «играть» или «пауза» и ждёт события-отклика. Если плеер, насколько известно сайту,
// уже в этом состоянии, события не будет — тогда и ждать нечего.
function embedExpect(e, playing) {
  const now = Date.now();
  e.expect = e.expect.filter((x) => x.until > now);
  const current = e.expect.length ? e.expect[e.expect.length - 1].playing : e.playing;
  if (current !== playing) e.expect.push({ playing, until: now + EMBED_ECHO });
}
// Событие плеера — отклик на команду сайта?
function embedEcho(e, playing) {
  const now = Date.now();
  e.expect = e.expect.filter((x) => x.until > now);
  const i = e.expect.findIndex((x) => x.playing === playing);
  if (i < 0) return false;
  e.expect.splice(0, i + 1);
  return true;
}

// Браузер может не дать плееру запуститься без нажатия зрителя (так бывает на телефонах и в Safari)
function embedStartHint(e) {
  if (embed !== e || !e.want.playing || e.playing || e.started || e.failed || e.hinted || e.ended || embedAdNow(e)) return;
  // плеер занят перемоткой или подгрузкой — значит, работает; проверим ещё раз позже
  if (Date.now() < e.settleUntil + 2000) { e.startTimer = setTimeout(() => embedStartHint(e), 4000); return; }
  e.hinted = true;
  toast('Если видео не началось, нажмите на кнопку воспроизведения в самом плеере');
}

// ----- События плеера -----
function embedReady(e) {
  if (e.ready) return;
  e.ready = true;
  clearTimeout(e.readyTimer);
  if (e.troubled) { e.troubled = false; setLinkMode(false); }
  embedLog('плеер готов');
  // команда комнаты могла прийти раньше, чем загрузился плеер
  if (e.want.playing || e.want.time > 0.5) applyWant(e, true);
}

// Плеер сообщил, что видео пошло (playing = true) или остановилось
function embedState(e, playing) {
  const now = Date.now();
  const was = e.playing;
  if (playing !== was) {
    if (!embedAdNow(e)) { e.time = embedOwnTime(e); e.at = now; }
    e.playing = playing;
  }
  if (playing) {
    e.started = true;
    e.everPlayed = true;
    clearTimeout(e.startTimer);
    clearTimeout(e.pauseTimer);
  }
  if (embedAdNow(e)) return;
  const echo = embedEcho(e, playing);
  if (playing === e.want.playing) {
    // Видео пошло без команды сайта, хотя комната давно идёт: зритель сам нажал на плеер, который
    // не смог запуститься. Догоняем комнату.
    if (!echo && playing && !was && now - e.caughtAt > 10000 && Math.abs(embedOwnTime(e) - wantTime(e.want)) > 3) {
      e.caughtAt = now;
      applyWant(e, true);
    }
    return;
  }
  // отклик на команду, которую сайт уже успел сменить следующей
  if (echo) return;
  if (playing) { embedUserState(e, true); return; }
  // плеер так и не начал воспроизведение после команды сайта — это не пауза зрителя
  if (!e.started) return;
  // Пауза в самом плеере. Сообщаем о ней не сразу: при перемотке и подгрузке плеер может ненадолго
  // остановиться и пойти дальше сам.
  clearTimeout(e.pauseTimer);
  e.pauseTimer = setTimeout(() => {
    if (embed === e && !e.playing && e.want.playing && !embedAdNow(e)) embedUserState(e, false);
  }, Math.max(350, e.settleUntil - now + 100));
}

// Зритель нажал воспроизведение или паузу в самом плеере — сообщаем комнате
function embedUserState(e, playing) {
  const now = Date.now();
  const t = embedOwnTime(e);
  e.want = { playing, time: t, at: now };
  if (playing) { e.mine = { want: e.want, at: now }; e.ended = false; }
  isPlaying = playing;
  updatePlayBtn();
  if (!justWoke()) socket.emit(playing ? 'play' : 'pause', { time: t });
}

// Плеер сообщил текущее время видео
function embedTimeReport(e, r, duration) {
  if (duration > 0 && Number.isFinite(duration)) e.duration = duration;
  if (!Number.isFinite(r) || r < 0) return;
  if (e.ad && !embedAdNow(e)) e.ad = false;
  if (e.ad) return;                     // во время рекламы плеер может сообщать её время, а не время видео
  const now = Date.now();
  if (r % 1 !== 0) e.exact = true;
  const slack = e.exact ? 0 : 1;        // плеер, который сообщает целые секунды, может отставать от себя почти на секунду
  const settling = now < e.settleUntil;
  const prev = e.last;
  e.last = { r, at: now };

  // Перемотка: позиция изменилась не так, как шло время. Остановка на подгрузку перемоткой не считается:
  // при ней позиция не уходит назад и не обгоняет часы. Чья это перемотка — зрителя в самом плеере или
  // отклик на команду сайта, — разбирает embedUserSeek.
  if (prev) {
    const moved = r - prev.r;
    const passed = (now - prev.at) / 1000;
    const hinted = e.sought && now - e.sought < 2000;
    const jumped = e.playing
      ? moved < -(1.5 + slack) || moved > passed * 1.25 + 1.5 + slack || (hinted && Math.abs(moved - passed) > 1 + slack)
      : Math.abs(moved) > 0.5 + slack;
    if (jumped) {
      e.sought = 0;
      e.time = r;
      e.at = now;
      embedUserSeek(e, r);
      return;
    }
  }
  // сообщение, отправленное плеером ещё до перемотки, которую только что запросил сайт
  if (settling && e.ownSeek && now - e.ownSeek.at < EMBED_SETTLE && Math.abs(r - e.ownSeek.time) > 3 + slack) return;
  embedAtOwnSeek(e, r, now);

  // Часы. Целые секунды значат «где-то между r и r+1»: поправляем часы, только если они вышли за эти границы
  const own = embedOwnTime(e);
  if (e.exact) { e.time = r; e.at = now; }
  else if (own < r) { e.time = r; e.at = now; }
  else if (own >= r + 1) { e.time = own - r > 2 ? r : r + 0.99; e.at = now; }

  // После перемотки по команде сайта проверяем, что плеер перешёл на нужное место. Некоторые плееры
  // не перематывают видео, которое ещё не начинало идти, — тогда повторяем команду.
  if (!settling && e.check > 0) {
    const since = (now - e.checkAt) / 1000;
    if (r > e.checkTime - 1.5 - slack && r < e.checkTime + since + 1.5 + slack) e.check = 0;
    else { embedSeekTo(e, wantTime(e.want), e.check - 1); return; }
  }
  // Видео после запуска или перемотки снова пошло. Пока плеер подгружал видео, комната шла дальше.
  // Если он отстал больше чем на секунду, перематываем ещё раз — с запасом на такую же задержку,
  // чтобы после неё плеер оказался на общем месте. Делаем это один раз на команду.
  if (e.resuming && !settling && e.check === 0 && prev && r > prev.r) {
    e.resuming = false;
    const room = wantTime(e.want);
    const lag = room - embedOwnTime(e);
    if (e.want.playing && !e.caughtUp && lag > 1 + slack && lag < 15 && !(e.duration > 0 && room + lag > e.duration - 1)) {
      e.caughtUp = true;
      embedSeekTo(e, room + lag, 0, room);
    }
  }
}

// Плеер прямо сообщил о перемотке (VK Видео)
function embedSought(e, t) {
  const now = Date.now();
  if (!Number.isFinite(t) || t < 0 || embedAdNow(e)) return;
  e.time = t;
  e.at = now;
  e.last = { r: t, at: now };
  embedUserSeek(e, t);
}

// Плеер оказался там, куда его отправила последняя перемотка сайта? Тогда это отклик на неё, а не действие
// зрителя. Об одной перемотке плеер может сообщить несколько раз, поэтому после первого отклика принимаем
// их ещё полторы секунды; следующая перемотка в то же место — уже действие зрителя.
function embedAtOwnSeek(e, t, now) {
  const seek = e.ownSeek;
  if (!seek || now > seek.until) return false;
  const slack = e.exact ? 0 : 1;
  const ahead = e.want.playing ? (now - seek.at) / 1000 : 0;   // столько видео могло пройти после перемотки
  if (t < seek.time - 2.5 - slack || t > seek.time + ahead + 2.5 + slack) return false;
  seek.until = Math.min(seek.until, now + 1500);
  return true;
}

// Перемотка в самом плеере — сообщаем комнате
function embedUserSeek(e, t) {
  const now = Date.now();
  const slack = e.exact ? 0 : 1;
  // отклик на перемотку, которую запросил сам сайт: дальше его не рассылаем
  if (embedAtOwnSeek(e, t, now)) return;
  // о той же перемотке зрителя комнате уже сообщили
  if (e.sent && now - e.sent.at < 1500 && Math.abs(t - e.sent.time) < 1.5 + slack) return;
  e.sent = { time: t, at: now };
  e.ownSeek = null;
  e.want = { playing: e.want.playing, time: t, at: now };
  e.check = 0;
  e.settleUntil = now + EMBED_SETTLE;
  if (!justWoke()) socket.emit('seek', { time: t });
}

// Реклама. У каждого зрителя она своя, поэтому на время рекламы плеер живёт отдельно от комнаты,
// а после неё возвращается на общее место.
function embedAd(e, on) {
  const now = Date.now();
  if (on) {
    if (!embedAdNow(e)) {
      e.adFrom = e.at ? embedOwnTime(e) : wantTime(e.want);
      e.adAt = now;
    }
    e.ad = true;
    e.adUntil = now + EMBED_AD_MAX;
    clearTimeout(e.startTimer);
    clearTimeout(e.pauseTimer);
    return;
  }
  if (!e.ad) return;
  e.ad = false;
  e.time = e.adFrom;
  e.at = now;
  e.last = null;
  // Воспроизведение запустил этот зритель, и сразу началась реклама. Чтобы никто не пропустил начало
  // видео, комната продолжает с того места, где видео остановилось на время рекламы.
  if (e.mine && e.mine.want === e.want && e.want.playing && e.adAt - e.mine.at < 5000) {
    e.want = { playing: true, time: e.adFrom, at: now };
    if (!justWoke()) socket.emit('play', { time: e.adFrom });
  }
  e.mine = null;
  applyWant(e, true);
}

// Видео закончилось. sure — плеер сообщил об этом однозначно
function embedEnded(e, sure) {
  if (e.ended || !e.everPlayed || (!sure && embedAdNow(e))) return;
  const now = Date.now();
  let t = embedOwnTime(e);
  if (e.duration > 0 && e.duration - t < 3) t = e.duration;
  e.ended = true;
  e.ad = false;
  e.time = t;
  e.at = now;
  e.playing = false;
  e.want = { playing: false, time: t, at: now };
  clearTimeout(e.startTimer);
  clearTimeout(e.pauseTimer);
  isPlaying = false;
  updatePlayBtn();
  // как и у видеофайла: комната останавливается на конце видео, затем включается следующее из очереди
  if (!justWoke()) socket.emit('pause', { time: t });
  socket.emit('queue_next');
}

// Плеер не смог показать видео. Причину он пишет сам, в своём окне
function embedError(e, data) {
  embedLog('ошибка плеера', data);
  e.failed = true;
  clearTimeout(e.startTimer);
}

// Воспроизведение запустил сам зритель кнопкой сайта (см. embedAd)
function embedMarkMine() {
  if (embed && embed.want.playing) embed.mine = { want: embed.want, at: Date.now() };
}

// ----- Rutube: команды и события передаются сообщениями postMessage -----
// Описание: https://rutube.ru/info/embed/
// Видео прерывают рекламные ролики перед ним, в середине и после (preroll, midroll, postroll).
// Баннеры, оверлеи и реклама на паузе идут поверх плеера и воспроизведению не мешают.
function rutubeAdBreaks(kind) {
  return !/banner|overlay|pause/i.test(String(kind || ''));
}
function connectRutube(e) {
  const origin = 'https://rutube.ru';
  const post = (type, data) => {
    try { e.frame.contentWindow.postMessage(JSON.stringify({ type, data: data || {} }), origin); } catch (err) { /* окно плеера уже закрыто */ }
  };
  e.send = {
    play: () => post('player:play'),
    pause: () => post('player:pause'),
    seek: (time) => post('player:setCurrentTime', { time }),
    volume: (volume) => post('player:setVolume', { volume })
  };
  const onMessage = (event) => {
    if (embed !== e || event.source !== e.frame.contentWindow || event.origin !== origin) return;
    let msg = event.data;
    if (typeof msg === 'string') {
      // среди сообщений плеера есть описание видео на сотни килобайт — такие не разбираем
      if (msg.length > 20000) return;
      try { msg = JSON.parse(msg); } catch (err) { return; }
    }
    if (!msg || typeof msg.type !== 'string') return;
    const data = msg.data && typeof msg.data === 'object' ? msg.data : {};
    if (msg.type !== 'player:currentTime') embedLog('Rutube:', msg.type, data);
    switch (msg.type) {
      case 'player:ready':
        embedReady(e);
        break;
      case 'player:durationChange':
        if (Number(data.duration) > 0) e.duration = Number(data.duration);
        break;
      case 'player:currentTime':
        embedTimeReport(e, Number(data.time), Number(data.duration));
        break;
      case 'player:changeState':
        // названия состояний в разных версиях плеера отличаются: paused / pause, stopped / completed
        if (data.state === 'playing') embedState(e, true);
        else if (data.state === 'paused' || data.state === 'pause') embedState(e, false);
        else if (data.state === 'stopped' || data.state === 'completed') embedEnded(e, false);
        else if (data.state === 'seeking' || data.state === 'seeked') e.sought = Date.now();
        // пока плеер перематывает или подгружает видео, его остановка — не действие зрителя
        if (data.state === 'seeking' || data.state === 'buffering') e.settleUntil = Math.max(e.settleUntil, Date.now() + EMBED_SETTLE);
        break;
      case 'player:playComplete':
        embedEnded(e, true);
        break;
      case 'player:rollState':
        // state: play — реклама началась, complete — закончилась (или её не было)
        if (!rutubeAdBreaks(data.type || data.rollState)) break;
        if (data.state === 'play') embedAd(e, true);
        else if (data.state === 'complete') embedAd(e, false);
        break;
      case 'player:adStart':
        if (rutubeAdBreaks(data.aformat)) embedAd(e, true);
        break;
      case 'player:adEnd':
        if (rutubeAdBreaks(data.aformat)) embedAd(e, false);
        break;
      case 'player:error':
        if (data.fatal !== false) embedError(e, data);
        break;
    }
  };
  window.addEventListener('message', onMessage);
  e.off = () => window.removeEventListener('message', onMessage);
}

// ----- VK Видео: управление через библиотеку videoplayer.js -----
// Описание: https://dev.vk.com/ru/widgets/video
const VK_SDK_PATH = '/js/api/videoplayer.js';
const VK_ASK_MAX = 30;       // столько раз, раз в секунду, спрашиваем плеер, готов ли он
const VK_ALT_WAIT = 9000;    // плеер не ответил за это время — открываем его на запасном адресе
let vkSdkLoading = null;
function loadVkSdk(hosts) {
  if (window.VK && window.VK.VideoPlayer) return Promise.resolve();
  if (!vkSdkLoading) {
    vkSdkLoading = new Promise((resolve, reject) => {
      const attempt = (i) => {
        const tag = document.createElement('script');
        tag.src = `https://${hosts[i]}${VK_SDK_PATH}`;
        const next = () => {
          if (i + 1 < hosts.length) attempt(i + 1);
          else { vkSdkLoading = null; reject(new Error('vk')); }
        };
        tag.onload = () => { if (window.VK && window.VK.VideoPlayer) resolve(); else next(); };
        tag.onerror = next;
        document.head.appendChild(tag);
      };
      attempt(0);
    });
  }
  return vkSdkLoading;
}

function connectVk(e) {
  let player = null;
  let askTimer = null;
  let altTimer = null;
  const attach = () => {
    player = window.VK.VideoPlayer(e.frame);
    const on = (name, handler) => player.on(name, (state) => {
      if (embed !== e) return;
      if (name !== 'timeupdate') embedLog('VK Видео:', name, state);
      handler(state || {});
    });
    on('inited', (state) => { if (Number(state.duration) > 0) e.duration = Number(state.duration); embedReady(e); });
    on('started', () => embedState(e, true));
    on('resumed', () => embedState(e, true));
    on('paused', () => embedState(e, false));
    on('ended', () => embedEnded(e, true));
    on('timeupdate', (state) => embedTimeReport(e, Number(state.time), Number(state.duration)));
    on('seeked', (state) => embedSought(e, Number(state.time)));
    on('adStarted', () => embedAd(e, true));
    on('adCompleted', () => embedAd(e, false));
    on('error', (state) => embedError(e, state));
  };
  loadVkSdk(VK_EMBED_HOSTS).then(() => {
    if (embed !== e) return;            // пока библиотека загружалась, видео сменили
    attach();
    e.send = {
      play: () => player.play(),
      pause: () => player.pause(),
      seek: (time) => player.seek(time),
      volume: (volume) => player.setVolume(volume)
    };
    e.off = () => { clearInterval(askTimer); clearTimeout(altTimer); player.destroy(); };
    // О готовности плеер сообщает в ответ на запрос «init». Библиотека отправляет его один раз — возможно,
    // раньше, чем окно плеера загрузилось, — поэтому повторяем запрос, пока плеер не ответит.
    let asked = 0;
    const ask = () => {
      if (embed !== e || e.ready || ++asked > VK_ASK_MAX) { clearInterval(askTimer); return; }
      try { e.frame.contentWindow.postMessage({ method: 'init' }, '*'); } catch (err) { /* окно плеера уже закрыто */ }
    };
    e.frame.addEventListener('load', ask);
    askTimer = setInterval(ask, 1000);
    // Плеер на основном адресе так и не ответил (например, сайт недоступен в этой сети) — открываем запасной
    altTimer = setTimeout(() => {
      if (embed !== e || e.ready || !e.alt) return;
      embedLog('VK Видео: плеер не ответил, открываем его на запасном адресе');
      player.destroy();
      e.frame.src = e.alt;
      attach();
    }, VK_ALT_WAIT);
  }).catch((err) => {
    embedLog('VK Видео: плеер не подключён', err && err.message);
    if (embed === e) embedTrouble(e);
  });
}

// ===== Потоки HLS (.m3u8) =====
// Safari и часть других браузеров воспроизводят такие потоки сами — для них всё остаётся как было.
// Остальным помогает библиотека hls.js (vendor/hls.min.js); она загружается, только когда понадобилась.
const HLS_LIB = 'vendor/hls.min.js';
const HLS_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegURL'];
const HLS_MESSAGES = {
  lib: 'Не удалось загрузить проигрыватель потоков — файл vendor/hls.min.js. Проверьте, что папка vendor загружена вместе с сайтом.',
  unsupported: 'Этот браузер не умеет воспроизводить потоки HLS. Попробуйте открыть сайт в другом браузере.',
  network: 'Поток не загружается. Возможно, ссылка устарела или сервер не разрешает воспроизведение на других сайтах.',
  media: 'Браузер не может воспроизвести этот поток: формат видео или звука не поддерживается.'
};
let hlsLibLoading = null;
let hlsUrl = null;         // адрес потока, для которого hls.js уже запускали

function isHlsUrl(url) {
  return /\.m3u8(?:[?#&]|$)/i.test(url || '');
}
function browserPlaysHls() {
  return HLS_TYPES.some((type) => htmlVideo.canPlayType(type));
}
function canUseHlsLib() {
  return typeof window.MediaSource !== 'undefined' || typeof window.ManagedMediaSource !== 'undefined';
}

function loadHlsLib() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLibLoading) {
    hlsLibLoading = new Promise((resolve, reject) => {
      const fail = () => { hlsLibLoading = null; reject(new Error('hls')); };
      const tag = document.createElement('script');
      tag.src = HLS_LIB;
      tag.onload = () => { if (window.Hls) resolve(window.Hls); else fail(); };
      tag.onerror = fail;
      document.head.appendChild(tag);
    });
  }
  return hlsLibLoading;
}

function destroyHls() {
  hlsUrl = null;
  if (!hls) return;
  try { hls.destroy(); } catch (e) { /* уже остановлен */ }
  hls = null;
}

// resume — hls.js подхватывает поток, который до этого пытался воспроизвести сам браузер. Комната за это
// время могла уйти вперёд, поэтому после загрузки возвращаем плеер к её состоянию.
function startHls(video, resume) {
  hlsUrl = video.url;
  loadHlsLib().then((Hls) => {
    if (currentVideo !== video) return; // пока библиотека загружалась, видео сменили
    if (!Hls.isSupported()) { showFallback(video, HLS_MESSAGES.unsupported); return; }
    const player = new Hls({ liveDurationInfinity: true });
    let recoveries = 0;
    hls = player;
    if (resume) {
      player.once(Hls.Events.LEVEL_LOADED, () => {
        if (hls !== player || currentVideo !== video) return;
        if (isPlaying) doPlay();
        if (roomId) socket.emit('sync_request');
      });
    }
    player.on(Hls.Events.ERROR, (event, data) => {
      if (hls !== player || !data || !data.fatal) return;
      // сбой декодирования часто проходит после перезапуска — пробуем дважды
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveries < 2) {
        recoveries++;
        player.recoverMediaError();
        return;
      }
      hls = null;
      try { player.destroy(); } catch (e) { /* уже остановлен */ }
      showFallback(video, data.type === Hls.ErrorTypes.NETWORK_ERROR ? HLS_MESSAGES.network : HLS_MESSAGES.media);
    });
    player.loadSource(video.url);
    player.attachMedia(htmlVideo);
  }, () => {
    if (currentVideo === video) showFallback(video, HLS_MESSAGES.lib);
  });
}

// Прямой эфир. Шкала времени у каждого зрителя своя, поэтому общего места просмотра у эфира нет:
// общими остаются запуск и пауза, а запуск возвращает зрителя к тому, что идёт сейчас.
function isLiveStream() {
  return !!currentVideo && currentVideo.type === 'direct' && htmlVideo.duration === Infinity;
}
function catchUpLive() {
  if (!hls || typeof hls.liveSyncPosition !== 'number') return;
  const edge = hls.liveSyncPosition;
  if (edge - htmlVideo.currentTime > 8) {
    markOwnSeek(edge);
    htmlVideo.currentTime = edge;
  }
}
let liveShown = false;
function updateLiveLabel() {
  const live = isLiveStream();
  if (live !== liveShown) {
    liveShown = live;
    seekBar.disabled = live;
    if (live) $('controlsHint').textContent = 'Это прямой эфир: воспроизведение и пауза общие, а перемотки у эфира нет.';
  }
  if (live) {
    seekBar.value = 100;
    curTimeEl.textContent = 'Прямой эфир';
    durTimeEl.textContent = '';
  }
}
function liveNote() {
  if (isLiveStream()) toast('У прямого эфира нет общей перемотки: все смотрят то, что идёт сейчас');
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
  videoFallback.classList.remove('is-link');
  videoFallback.innerHTML = '';
}

// ===== Ссылка на сайт =====
// Страницу другого сайта нельзя показать внутри комнаты: большинство сайтов это запрещают.
// Поэтому вместо плеера все участники видят карточку со ссылкой, а открывает её каждый в своём браузере.
function showLinkCard(video) {
  videoFallback.classList.remove('hidden');
  videoFallback.classList.add('is-link');
  videoFallback.innerHTML = `
    <div class="lc-icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5c2.6 2.7 4 6 4 9.5s-1.4 6.8-4 9.5c-2.6-2.7-4-6-4-9.5s1.4-6.8 4-9.5Z"/></svg></div>
    <span class="lc-caption">Ссылка на сайт</span>
    <h3 class="lc-host"></h3>
    <p class="lc-url"></p>
    <div class="fb-actions">
      <a class="lc-open" target="_blank" rel="noopener noreferrer">Открыть в браузере <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></a>
      <button type="button" class="lc-copy">Скопировать ссылку</button>
    </div>
    <p class="lc-note">Сайт откроется в новой вкладке. Ссылка у всех участников одна, а чат и реакции остаются здесь.</p>`;
  // Адрес подставляем как текст и как свойство ссылки, а не как HTML
  videoFallback.querySelector('.lc-host').textContent = siteName(video.url);
  videoFallback.querySelector('.lc-url').textContent = video.url;
  videoFallback.querySelector('.lc-open').href = video.url;
  videoFallback.querySelector('.lc-copy').addEventListener('click', async () => {
    const copied = await copyText(video.url);
    toast(copied ? 'Ссылка скопирована' : 'Не удалось скопировать. Выделите адрес и скопируйте его вручную');
  });
}

// Для ссылки на сайт общего воспроизведения нет, поэтому кнопки плеера убираем
function setLinkMode(on) {
  $('playerWrap').classList.toggle('is-link', on);
  $('controls').classList.toggle('hidden', on);
  $('controlsHint').textContent = on
    ? 'Ссылку на сайт каждый участник открывает в своём браузере, поэтому общих кнопок воспроизведения для неё нет.'
    : 'Воспроизведение, пауза и перемотка синхронизируются у всех участников.';
  $('npLabel').textContent = on ? 'Общая ссылка:' : 'Сейчас смотрят:';
}

function loadVideo(video, autoplay) {
  currentVideo = video;
  isPlaying = false;
  duration = 0;
  emptyState.classList.add('hidden');
  const isLink = video.type === 'link';
  $('npTitle').textContent = video.title || video.url;
  $('npBy').textContent = video.addedByName ? `— ${isLink ? 'поделился' : 'выбрал'} ${video.addedByName}` : '';
  hideFallback();
  setLinkMode(isLink);
  videoSlot.classList.remove('hidden');
  seekBar.value = 0;
  curTimeEl.textContent = durTimeEl.textContent = fmtTime(0);
  clearTimeout(window._directTimer);
  // плееры прежнего видео, добавленные позже остальных: Rutube / VK Видео и hls.js
  destroyEmbed();
  destroyHls();
  liveShown = false;
  seekBar.disabled = false;

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
  } else if (video.type === 'rutube' || video.type === 'vk') {
    if (ytPlayer) { try { ytPlayer.destroy(); } catch(e){} ytPlayer = null; ytReady = false; }
    if (vimeoPlayer) { try { vimeoPlayer.destroy(); } catch(e){} vimeoPlayer = null; }
    pendingVideo = null;
    // Прежний видеофайл выгружаем без pause(): иначе плеер разослал бы «паузу» с позицией прежнего видео
    htmlVideo.removeAttribute('src');
    htmlVideo.load();
    htmlVideo.classList.add('hidden');
    ytContainer.classList.remove('hidden');
    startEmbed(video);
  } else {
    if (ytPlayer) { try { ytPlayer.destroy(); } catch(e){} ytPlayer = null; ytReady = false; }
    if (vimeoPlayer) { try { vimeoPlayer.destroy(); } catch(e){} vimeoPlayer = null; }
    ytContainer.classList.add('hidden');
    htmlVideo.classList.remove('hidden');
    htmlVideo.dataset.url = video.url;
    if (!isLink && isHlsUrl(video.url) && !browserPlaysHls()) {
      // Поток HLS, который браузер сам не воспроизводит. Прежний источник выгружаем сразу: пока загружается
      // hls.js, его запоздавшие события (например, ошибка загрузки) относились бы уже к новому видео.
      htmlVideo.removeAttribute('src');
      htmlVideo.load();
      startHls(video);
    } else {
      htmlVideo.src = video.url;
      htmlVideo.load();
    }
    if (isLink) {
      // Карточку со ссылкой показываем сразу. Если по адресу окажется видеофайл, браузер его
      // загрузит, и карточку сменит плеер (см. обработчик loadedmetadata).
      showLinkCard(video);
    } else {
      // если файл не ответил за 12 секунд — показываем понятное сообщение
      window._directTimer = setTimeout(() => {
        if (currentVideo === video && htmlVideo.readyState === 0) {
          showFallback(video, 'Видео не загружается. Возможно, ссылка устарела или сервер блокирует прямое воспроизведение.');
        }
      }, 12000);
    }
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
      if (!justWoke()) socket.emit('play', { time: vimeoTime });
    });
    vimeoPlayer.on('pause', () => {
      if (suppressEvents) return;
      isPlaying = false; updatePlayBtn();
      if (!justWoke()) socket.emit('pause', { time: vimeoTime });
    });
    vimeoPlayer.on('ended', () => {
      isPlaying = false; updatePlayBtn();
      socket.emit('queue_next');
    });
    vimeoPlayer.on('seeked', (data) => {
      vimeoTime = (data && data.seconds) || vimeoTime;
      if (suppressEvents || isOwnSeek(vimeoTime) || justWoke()) return;
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
            if (!justWoke()) socket.emit('play', { time: getTime() });
          } else if (e.data === YT.PlayerState.PAUSED) {
            isPlaying = false; updatePlayBtn();
            if (!justWoke()) socket.emit('pause', { time: getTime() });
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
  if (!justWoke()) socket.emit('play', { time: htmlVideo.currentTime });
});
htmlVideo.addEventListener('pause', () => {
  if (suppressEvents) return;
  isPlaying = false; updatePlayBtn();
  if (!justWoke()) socket.emit('pause', { time: htmlVideo.currentTime });
});
htmlVideo.addEventListener('loadedmetadata', () => {
  // событие от прежнего адреса, который уже сменили
  if (!currentVideo || htmlVideo.dataset.url !== currentVideo.url) return;
  hideFallback();
  duration = htmlVideo.duration || 0;
  if (currentVideo.type === 'link') {
    // Адрес выглядел как ссылка на сайт, но браузер смог его воспроизвести — это видеофайл.
    // Показываем плеер и догоняем остальных участников.
    currentVideo.type = 'direct';
    setLinkMode(false);
    updatePlayBtn();
    updateSteps();
    if (roomId) socket.emit('sync_request');
  }
});
htmlVideo.addEventListener('ended', () => { isPlaying = false; updatePlayBtn(); socket.emit('queue_next'); });
htmlVideo.addEventListener('seeked', () => {
  if (suppressEvents || isOwnSeek(htmlVideo.currentTime) || justWoke()) return;
  // у прямого эфира общего места просмотра нет: к текущему месту эфира плеер переходит сам
  if (isLiveStream()) return;
  socket.emit('seek', { time: htmlVideo.currentTime });
});
htmlVideo.addEventListener('error', () => {
  if (!currentVideo || currentVideo.type !== 'direct') return;
  // поток ведёт hls.js: с ошибками он разбирается сам (см. startHls)
  if (hls) return;
  // браузер взялся воспроизвести поток HLS сам, но не смог — пробуем через hls.js
  if (isHlsUrl(currentVideo.url) && hlsUrl !== currentVideo.url && canUseHlsLib()) { startHls(currentVideo, true); return; }
  const code = htmlVideo.error && htmlVideo.error.code;
  const reason = code === 4
    ? 'Браузер не может воспроизвести этот файл: формат не поддерживается или ссылка недоступна. Попробуйте прямую ссылку на MP4 или видео с YouTube.'
    : 'Не удалось загрузить видео по ссылке. Проверьте, что ссылка открывается в браузере.';
  showFallback(currentVideo, reason);
});

// ===== Отправка видео =====
// Адрес, набранный без «https://»: site.ru, www.site.ru/film, сайт.рф
const BARE_ADDRESS = /^[a-z0-9а-яё-]+(\.[a-z0-9а-яё-]+)*\.[a-zа-яё]{2,}(:\d{1,5})?([\/?#]\S*)?$/i;

function submitUrl(toQueue) {
  let raw = urlInput.value.trim();
  if (!raw) { toast('Вставьте ссылку в поле выше'); pulsePasteBox(); urlInput.focus(); return; }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && BARE_ADDRESS.test(raw)) raw = 'https://' + raw;
  const v = detectVideo(raw);
  if (!v) { toast('Не удалось распознать ссылку. Она должна начинаться с https://'); pulsePasteBox(); return; }
  const isLink = v.type === 'link';
  if (toQueue) {
    socket.emit('queue_add', { url: v.url, type: v.type, title: v.title });
    toast(isLink ? 'Ссылка добавлена в очередь' : 'Добавлено в очередь');
  } else {
    socket.emit('set_video', { url: v.url, type: v.type, title: v.title });
    toast(isLink ? 'Ссылка показана всем участникам' : 'Видео загружается у всех участников');
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
// Дополнения к этим кнопкам для плееров Rutube / VK Видео и для прямых эфиров
$('playPauseBtn').addEventListener('click', embedMarkMine);
$('bigPlay').addEventListener('click', embedMarkMine);
$('back10').addEventListener('click', liveNote);
$('fwd10').addEventListener('click', liveNote);
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
  if (embed && embed.ready) { try { embed.send.volume(v); } catch(e) {} }
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
  updateLiveLabel();
}, 250);

setInterval(() => { if (roomId) socket.emit('sync_request'); }, 15000);

// ===== Соединение =====
// На экране входа показываем состояние связи: connecting — подключаемся, online — на связи,
// offline — связь пропала, failed — подключиться нельзя (причина в connectionProblem).
const SLOW_AFTER = P2P_MODE ? 12000 : 75000; // «спящий» сервер просыпается примерно за минуту; если дольше — это уже неполадка
let serverState = 'connecting';
let connectionProblem = null;   // noserver | lib | unsupported
let wasOnline = false;
let waitingSince = Date.now();
let noticeTimer = null;
let slowTimer = null;

const CONNECTION_ERRORS = {
  failed: 'Сейчас создать комнату или войти в неё нельзя — причина указана выше',
  wait: 'Связь ещё не установлена. Подождите несколько секунд и попробуйте ещё раз'
};
const NOTICE_SPINNER = '<span class="spin" aria-hidden="true"></span>';
const NOTICE_WARNING = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5 2.5 20h19L12 3.5Z"/><path d="M12 10v4.5M12 17.3h.01"/></svg>';

function serverNoticeText() {
  if (!TRANSPORT_LOADED || connectionProblem === 'lib') {
    const file = P2P_MODE ? (TRANSPORT_LOADED ? 'vendor/peerjs.min.js' : 'p2p.js') : 'vendor/socket.io.min.js';
    return { warn: true, title: 'Сайт загрузился не полностью', text: `Не найден файл ${file}. Проверьте, что все файлы и папка vendor загружены вместе с сайтом.` };
  }
  if (connectionProblem === 'unsupported') {
    return { warn: true, title: 'Браузер не поддерживает соединение', text: 'Для совместного просмотра нужен современный браузер: Chrome, Яндекс Браузер, Firefox, Safari или Edge. Если сайт открыт внутри другого приложения, откройте ссылку в обычном браузере.' };
  }
  if (connectionProblem === 'noserver') {
    return { warn: true, title: 'Сервер синхронизации не найден', text: `По адресу ${SERVER_URL} нет сервера SyncWatch. Проверьте адрес в файле config.js.` };
  }
  if (Date.now() - waitingSince >= SLOW_AFTER) {
    return P2P_MODE
      ? { warn: true, title: 'Не удаётся установить связь', text: 'Сервис, через который участники находят друг друга, не отвечает. Проверьте интернет и обновите страницу. Если включён VPN или блокировщик, попробуйте без него.' }
      : { warn: true, title: 'Сервер не отвечает', text: `Не удаётся подключиться к ${SERVER_URL}. Попробуйте обновить страницу позже. Владельцу сайта: проверьте адрес в файле config.js и что сервер запущен.` };
  }
  if (serverState === 'offline') {
    return { warn: false, title: 'Связь потеряна', text: 'Пробуем подключиться снова…' };
  }
  return { warn: false, title: 'Подключаемся…', text: P2P_MODE ? 'Обычно это занимает пару секунд.' : 'Если сервер был в режиме сна, первое подключение может занять до минуты.' };
}

function renderServerNotice() {
  const box = $('serverNotice');
  clearTimeout(noticeTimer);
  if (!box) return;
  if (serverState === 'online') { box.classList.add('hidden'); return; }
  const notice = serverNoticeText();
  box.className = notice.warn ? 'server-notice' : 'server-notice is-wait';
  box.innerHTML = (notice.warn ? NOTICE_WARNING : NOTICE_SPINNER) + '<div><b></b><p></p></div>';
  box.querySelector('b').textContent = notice.title;
  box.querySelector('p').textContent = notice.text;
}

function setServerState(state, problem) {
  serverState = state;
  connectionProblem = state === 'failed' ? problem : null;
  clearTimeout(noticeTimer);
  clearTimeout(slowTimer);
  if (state === 'online') {
    wasOnline = true;
    const error = $('lobbyError');
    if (Object.values(CONNECTION_ERRORS).includes(error.textContent)) error.textContent = '';
  }
  if (state === 'connecting' || state === 'offline') {
    waitingSince = Date.now();
    slowTimer = setTimeout(renderServerNotice, SLOW_AFTER + 50);
  }
  // Обычное подключение занимает доли секунды — не мигаем сообщением без необходимости
  if (state === 'connecting') noticeTimer = setTimeout(renderServerNotice, 1200);
  else renderServerNotice();
}

// Перед созданием комнаты и входом в неё проверяем, что связь есть
function serverReady() {
  if (socket.connected) return true;
  renderServerNotice();
  $('lobbyError').textContent = serverState === 'failed' ? CONNECTION_ERRORS.failed : CONNECTION_ERRORS.wait;
  return false;
}

// Индикатор в шапке комнаты: есть ли сейчас связь с остальными участниками
function updateSyncPill() {
  const ok = !!socket.connected;
  $('syncPill').classList.toggle('is-offline', !ok);
  $('syncText').textContent = ok ? 'Синхронизировано' : 'Восстанавливаем связь…';
}

let rejoining = false;
socket.on('connect', () => {
  const again = wasOnline;
  setServerState('online');
  updateSyncPill();
  // Сервер считает участника вышедшим, как только рвётся связь, поэтому после восстановления
  // входим в комнату заново. В режиме без сервера возвращением в комнату занимается p2p.js.
  if (!P2P_MODE && again && roomId) {
    rejoining = true;
    socket.emit('join_room', { roomId, name: myName, color: myColor });
  }
});
socket.on('disconnect', () => {
  if (serverState !== 'failed') setServerState('offline');
  updateSyncPill();
});
socket.on('connect_error', (err) => {
  if (P2P_MODE) {
    // p2p.js сам повторяет попытки; окончательны только эти две причины
    if (err && (err.type === 'lib' || err.type === 'unsupported')) setServerState('failed', err.type);
    else if (serverState === 'connecting') renderServerNotice();
    return;
  }
  // Ответ 404 на первое же подключение: по этому адресу нет сервера Socket.IO —
  // так отвечает обычный хостинг файлов. Повторять попытки бессмысленно.
  const status = err && (typeof err.description === 'number' ? err.description : err.context && err.context.status);
  if (status === 404 && !wasOnline) {
    setServerState('failed', 'noserver');
    socket.disconnect();
    return;
  }
  if (serverState === 'connecting') renderServerNotice();
  if (!appEl.classList.contains('hidden')) toast('Нет соединения с сервером. Проверьте интернет');
});
// Короткие сообщения о состоянии комнаты (режим без сервера)
socket.on('notice', (data) => { if (data && data.text && !appEl.classList.contains('hidden')) toast(data.text); });
// Ход входа в комнату: показываем под кнопками на экране входа
socket.on('lobby_status', (data) => { if (data && data.text && $('lobbyError').dataset.busy === '1') setLobbyBusy(data.text); });

if (TRANSPORT_LOADED) setServerState('connecting');
else setServerState('failed', 'lib');

// Пока идёт создание комнаты или вход, кнопки не нажимаются повторно
let lobbyBusyTimer = null;
function setLobbyBusy(text) {
  const busy = !!text;
  clearTimeout(lobbyBusyTimer);
  $('createBtn').disabled = busy;
  $('joinBtn').disabled = busy;
  const error = $('lobbyError');
  error.classList.toggle('is-info', busy);
  if (busy) {
    error.textContent = text;
    lobbyBusyTimer = setTimeout(() => setLobbyBusy(''), 60000);
  } else if (error.dataset.busy === '1') {
    error.textContent = '';
  }
  error.dataset.busy = busy ? '1' : '';
}

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
  if (!serverReady()) return;
  myName = nameInput.value.trim() || 'Участник';
  store.set('wp_name', myName);
  setLobbyBusy('Создаём комнату…');
  socket.emit('create_room', { name: myName, color: myColor });
});
$('joinBtn').addEventListener('click', () => {
  const code = roomInput.value.trim().toUpperCase();
  if (code.length < 4) { $('lobbyError').textContent = 'Введите код комнаты (6 символов)'; return; }
  if (!serverReady()) return;
  myName = nameInput.value.trim() || 'Участник';
  store.set('wp_name', myName);
  setLobbyBusy('Ищем комнату…');
  socket.emit('join_room', { roomId: code, name: myName, color: myColor });
});
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('createBtn').click(); });
roomInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });

socket.on('room_created', (state) => { setLobbyBusy(''); applyState(state); enterRoom(); welcomeMessage(); toast('Комната создана. Отправьте код участникам'); });
socket.on('room_joined', (state) => {
  setLobbyBusy('');
  if (rejoining) { rejoining = false; resumeRoom(state); toast('Соединение восстановлено'); return; }
  applyState(state); enterRoom(); welcomeMessage(); toast('Вы подключены к комнате');
});
socket.on('app_error', (e) => {
  const message = (e && e.message) || 'Произошла ошибка';
  rejoining = false;
  if (appEl.classList.contains('hidden')) { setLobbyBusy(''); $('lobbyError').textContent = message; }
  else toast(message);
});

// Возвращение в комнату после обрыва связи: обновляем то, что могло измениться за это время
function resumeRoom(state) {
  if (!state) return;
  renderUsers(state.users, state.hostId);
  renderQueue(state.queue || []);
  const v = state.video ? normalizeVideo(state.video) : null;
  if (!v) return;
  if (!currentVideo || currentVideo.url !== v.url) loadVideo(v, false);
  syncToState(state, 0);
}

// Догоняем состояние комнаты, даже если плеер ещё инициализируется
function syncToState(state, attempt) {
  if (!currentVideo || currentVideo.type === 'link') return;
  const ready = state.video && (
    (currentVideo.type === 'direct' && htmlVideo.readyState > 0) ||
    (currentVideo.type === 'youtube' && ytReady) ||
    (currentVideo.type === 'vimeo' && vimeoPlayer) ||
    // плеер Rutube или VK Видео запоминает команду сам и выполняет её, когда загрузится
    (!!embed && embed.type === currentVideo.type)
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
  const detected = detectVideo(video.url);
  if (!detected) return null;
  return {
    type: detected.type,
    id: detected.id,
    url: video.url,
    // у ссылки на сайт название — всегда её настоящий домен
    title: detected.type === 'link' ? detected.title : (video.title || detected.title || 'Видео'),
    addedByName: video.addedByName
  };
}

socket.on('video_changed', ({ video }) => {
  const v = normalizeVideo(video);
  if (!v) return;
  loadVideo(v, false);
  addSystem(v.type === 'link' ? `Общая ссылка: ${v.title}` : `Сейчас смотрят: ${v.title}`);
});

// Пока вместо плеера показана ссылка на сайт, команды плеера не к чему применять. Если по этому
// адресу всё-таки окажется видео, состояние комнаты будет запрошено заново (см. loadedmetadata).
socket.on('remote_play', ({ time }) => {
  if (!currentVideo || currentVideo.type === 'link') return;
  const drift = Math.abs(getTime() - time);
  if (!isPlaying || drift > 2) doPlay(time); else if (drift > 0.5) doSeek(time);
  isPlaying = true; updatePlayBtn();
});
socket.on('remote_pause', ({ time }) => { doPause(time); });
socket.on('remote_seek', ({ time }) => { doSeek(time); });

socket.on('sync_state', (state) => {
  if (!state || !state.video || !currentVideo || currentVideo.type === 'link') return;
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
      <div class="avatar" style="background:${escapeHtml(u.color)}">${escapeHtml(initialFor(u.name))}</div>
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

// Текст сообщения: адреса сайтов становятся ссылками, всё остальное остаётся обычным текстом
function appendLinkedText(node, text) {
  const pattern = /https?:\/\/[^\s<>"']+/gi;
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    // знаки препинания в конце — часть фразы, а не адреса
    let url = match[0].replace(/[.,;:!?»]+$/, '');
    if (url.endsWith(')') && !url.includes('(')) url = url.replace(/\)+$/, '');
    pattern.lastIndex = match.index + url.length;
    if (!parseHttpUrl(url)) continue;
    node.appendChild(document.createTextNode(text.slice(last, match.index)));
    const link = document.createElement('a');
    link.href = url;
    link.textContent = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    node.appendChild(link);
    last = match.index + url.length;
  }
  node.appendChild(document.createTextNode(text.slice(last)));
}

function addChatMessage(msg, scroll = true) {
  const box = $('chatMessages');
  const el = document.createElement('div');
  el.className = 'msg';
  const time = new Date(msg.time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `
    <div class="avatar" style="background:${escapeHtml(msg.color || '#64748b')}">${escapeHtml(initialFor(msg.name))}</div>
    <div class="msg-body">
      <div class="msg-name" style="color:${escapeHtml(msg.color || '#64748b')}">${escapeHtml(msg.name)}</div>
      <div class="msg-text"></div>
      <div class="msg-time">${time}</div>
    </div>`;
  appendLinkedText(el.querySelector('.msg-text'), String(msg.text));
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
    const isLink = (detectVideo(item.url) || {}).type === 'link';
    el.innerHTML = `
      <div style="flex:1;min-width:0">
        <div class="q-title">${escapeHtml(isLink ? siteName(item.url) : item.title)}</div>
        <div class="q-by">${isLink ? 'ссылка на сайт · ' : ''}добавил ${escapeHtml(item.addedByName || '')}</div>
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

// ===== Каталог фильмов =====
// Список фильмов задаётся в файле catalog.js (window.SYNCWATCH_CATALOG). Здесь он проверяется и показывается
// двумя одинаковыми разделами: на экране входа и в комнате. Сами фильмы на сайте не хранятся: в комнату
// фильм попадает так же, как ссылка из поля ввода, — событиями set_video и queue_add.
const CATALOG_PAGE = 24;         // столько карточек показываем сразу, остальные — по кнопке «Показать ещё»
const CATALOG_SEARCH_FROM = 9;   // поиск появляется, когда фильмов не меньше
const CATALOG_MAX = 500;
const SOURCE_NAMES = { youtube: 'YouTube', vimeo: 'Vimeo', rutube: 'Rutube', vk: 'VK Видео', direct: 'Видеофайл' };

function catalogText(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}
// Для поиска: без различия больших и малых букв, «ё» и «е»
function catalogKey(text) {
  return String(text).toLowerCase().replace(/ё/g, 'е');
}
function catalogNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Картинка фильма: адрес в интернете или файл рядом с сайтом (images/film.jpg)
function catalogPoster(value) {
  const src = catalogText(value, 500);
  if (!src) return '';
  if (/^https?:\/\//i.test(src)) return parseHttpUrl(src) ? src : '';
  return /[:\\]/.test(src) || src.startsWith('/') ? '' : src;
}

// Ссылки фильма: каждая проходит ту же проверку, что и ссылка из поля ввода
function catalogLinks(film) {
  const list = Array.isArray(film.links) ? film.links : [film.url];
  const links = [];
  for (const item of list) {
    const given = item && typeof item === 'object' ? item : { url: item };
    let url = catalogText(given.url, 2000);
    if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && BARE_ADDRESS.test(url)) url = 'https://' + url;
    const video = url ? detectVideo(url) : null;
    if (!video) continue;
    // source — где идёт видео; label — подпись на кнопке выбора
    const source = video.type === 'link' ? siteName(video.url) : SOURCE_NAMES[video.type];
    const name = catalogText(given.name, 40);
    const label = !name ? source : catalogKey(name).includes(catalogKey(source)) ? name : `${name} · ${source}`;
    links.push({ video, source, name, label });
    if (links.length === 12) break;
  }
  return links;
}

function readCatalog() {
  const list = Array.isArray(window.SYNCWATCH_CATALOG) ? window.SYNCWATCH_CATALOG : [];
  const films = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const title = catalogText(item.title, 120);
    const links = catalogLinks(item);
    if (!title || !links.length) continue;   // без названия или без рабочей ссылки фильм не показываем
    const year = catalogText(item.year, 9);
    const genre = catalogText(item.genre, 60);
    const director = catalogText(item.director, 120);
    const description = catalogText(item.description, 1200);
    // у ссылок YouTube картинка есть у самого YouTube
    const youtube = links.find((l) => l.video.type === 'youtube' && /^[\w-]{6,20}$/.test(l.video.id || ''));
    films.push({
      title, director, description, links,
      meta: [year, genre].filter(Boolean).join(' · '),
      poster: catalogPoster(item.poster) || (youtube ? `https://i.ytimg.com/vi/${youtube.video.id}/hqdefault.jpg` : ''),
      sources: [...new Set(links.map((l) => l.source))],
      search: catalogKey([title, year, genre, director, description].join(' '))
    });
    if (films.length === CATALOG_MAX) break;
  }
  return films;
}

// Картинка фильма. Под ней всегда лежит название: оно видно, пока картинка загружается,
// и остаётся, если картинки нет или она не загрузилась
function catalogPosterNode(film, className) {
  const box = catalogNode('span', className);
  box.appendChild(catalogNode('span', 'film-poster-title', film.title));
  if (!film.poster) { box.classList.add('no-image'); return box; }
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';   // сайту с картинкой незачем знать адрес страницы
  img.addEventListener('load', () => box.classList.add('has-image'), { once: true });
  img.addEventListener('error', () => { img.remove(); box.classList.add('no-image'); }, { once: true });
  img.src = film.poster;
  box.appendChild(img);
  return box;
}

function catalogCard(film) {
  const card = catalogNode('button', 'film-card');
  card.type = 'button';
  card.setAttribute('aria-label', film.meta ? `${film.title}, ${film.meta}` : film.title);
  card.appendChild(catalogPosterNode(film, 'film-poster'));
  const body = catalogNode('span', 'film-body');
  body.appendChild(catalogNode('b', 'film-title', film.title));
  if (film.meta) body.appendChild(catalogNode('span', 'film-meta', film.meta));
  if (film.description) body.appendChild(catalogNode('span', 'film-desc', film.description));
  body.appendChild(catalogNode('span', 'film-sources', film.sources.slice(0, 3).join(' · ')));
  card.appendChild(body);
  card.addEventListener('click', () => openFilm(film, card));
  return card;
}

const catalogFilms = readCatalog();

// Раздел каталога: заголовок, поиск, карточки, «Показать ещё»
function setupCatalog(section, inRoomView) {
  if (!section || !catalogFilms.length) return;   // каталога нет — раздел остаётся скрытым
  const head = catalogNode('div', 'catalog-head');
  const titles = catalogNode('div', 'catalog-titles');
  titles.appendChild(catalogNode('h2', '', 'Фильмы'));
  titles.appendChild(catalogNode('p', '', inRoomView
    ? 'Выберите фильм — он включится у всех участников комнаты.'
    : 'Выберите фильм, создайте комнату и смотрите его вместе с друзьями.'));
  head.appendChild(titles);
  const grid = catalogNode('div', 'catalog-grid');
  const empty = catalogNode('p', 'catalog-empty hidden', 'Ничего не найдено. Попробуйте другое слово.');
  const more = catalogNode('button', 'btn btn-secondary catalog-more hidden', 'Показать ещё');
  more.type = 'button';
  let words = [];
  let shown = CATALOG_PAGE;
  const render = () => {
    const found = words.length ? catalogFilms.filter((film) => words.every((word) => film.search.includes(word))) : catalogFilms;
    grid.textContent = '';
    found.slice(0, shown).forEach((film) => grid.appendChild(catalogCard(film)));
    empty.classList.toggle('hidden', found.length > 0);
    more.classList.toggle('hidden', found.length <= shown);
  };
  if (catalogFilms.length >= CATALOG_SEARCH_FROM) {
    const search = catalogNode('input', 'input catalog-search');
    search.type = 'search';
    search.placeholder = 'Найти фильм';
    search.autocomplete = 'off';
    search.setAttribute('aria-label', 'Найти фильм в каталоге');
    search.addEventListener('input', () => {
      words = catalogKey(search.value).split(/\s+/).filter(Boolean);
      shown = CATALOG_PAGE;
      render();
    });
    head.appendChild(search);
  }
  more.addEventListener('click', () => { shown += CATALOG_PAGE; render(); });
  section.append(head, grid, empty, more);
  render();
  section.classList.remove('hidden');
}

// --- Окно фильма ---
let filmOpen = null;      // { film, link, opener } — фильм в открытом окне и выбранная ссылка
let catalogPick = null;   // фильм, выбранный на экране входа: включится, когда комната будет создана

const inRoomNow = () => !appEl.classList.contains('hidden');

function openFilm(film, opener) {
  // если у фильма есть ссылка на площадке, которую зритель выбирал в прошлый раз, предлагаем её
  const preferred = store.get('wp_catalog_source') || '';
  const link = film.links.find((l) => l.source === preferred) || film.links[0];
  filmOpen = { film, link, opener: opener || null };
  $('filmTitle').textContent = film.title;
  const meta = [film.meta, film.director ? `реж. ${film.director}` : ''].filter(Boolean).join(' · ');
  $('filmMeta').textContent = meta;
  $('filmMeta').classList.toggle('hidden', !meta);
  $('filmDesc').textContent = film.description;
  $('filmDesc').classList.toggle('hidden', !film.description);
  const poster = $('filmPoster');
  poster.textContent = '';
  poster.appendChild(catalogPosterNode(film, 'film-poster film-poster-big'));
  renderFilmLinks();
  const room = inRoomNow();
  $('filmWatch').textContent = room ? 'Смотреть вместе' : 'Создать комнату и смотреть';
  $('filmQueue').classList.toggle('hidden', !room);
  $('filmModal').classList.remove('hidden');
  $('filmWatch').focus();
}

function renderFilmLinks() {
  const { film, link } = filmOpen;
  const box = $('filmLinks');
  box.textContent = '';
  box.classList.toggle('hidden', film.links.length < 2);
  if (film.links.length > 1) {
    box.appendChild(catalogNode('span', 'film-links-label', 'Что включить:'));
    film.links.forEach((item) => {
      const button = catalogNode('button', 'film-link' + (item === link ? ' active' : ''), item.label);
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', item === link ? 'true' : 'false');
      button.addEventListener('click', () => {
        filmOpen.link = item;
        // выбор площадки запоминаем, только когда было из чего выбирать
        if (film.sources.length > 1) store.set('wp_catalog_source', item.source);
        renderFilmLinks();
        // кнопки созданы заново: возвращаем фокус на выбранную
        const active = box.querySelector('.film-link.active');
        if (active) active.focus();
      });
      box.appendChild(button);
    });
  }
  const isLink = link.video.type === 'link';
  $('filmNote').textContent = isLink
    ? `Это ссылка на сайт ${link.source}: участники откроют её у себя в браузере, общего плеера у неё нет.`
    : `Источник: ${link.source}. Воспроизведение, пауза и перемотка будут общими для всех участников.`;
}

function closeFilm() {
  if (!filmOpen) return;
  const { opener } = filmOpen;
  filmOpen = null;
  $('filmModal').classList.add('hidden');
  if (opener && opener.isConnected) opener.focus();
}

// То, что уходит в комнату: та же запись, что и у ссылки из поля ввода, но с названием фильма
function filmVideo() {
  const { film, link } = filmOpen;
  // у серий и версий к названию добавляется их имя: «Жестокий романс — Серия 1»
  const named = film.links.length > 1 && link.name && catalogKey(link.name) !== catalogKey(link.source);
  return { url: link.video.url, type: link.video.type, title: (film.title + (named ? ` — ${link.name}` : '')).slice(0, 200) };
}

function renderCatalogPick() {
  $('catalogPick').classList.toggle('hidden', !catalogPick);
  $('catalogPickTitle').textContent = catalogPick ? catalogPick.film : '';
}

function watchFilm() {
  if (!filmOpen) return;
  const video = filmVideo();
  if (inRoomNow()) {
    socket.emit('set_video', video);
    toast(video.type === 'link' ? 'Ссылка показана всем участникам' : 'Видео загружается у всех участников');
    filmOpen.opener = null;   // после выбора показываем плеер, а не возвращаемся к карточке
    closeFilm();
    $('playerWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  // На экране входа комнаты ещё нет: запоминаем фильм и создаём комнату
  catalogPick = { video, film: filmOpen.film.title };
  renderCatalogPick();
  filmOpen.opener = null;
  closeFilm();
  $('catalogPick').scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (nameInput.value.trim()) {
    $('createBtn').click();
  } else {
    toast('Введите имя и нажмите «Создать комнату» — фильм включится сразу');
    nameInput.focus({ preventScroll: true });
  }
}

function queueFilm() {
  if (!filmOpen || !inRoomNow()) return;
  const video = filmVideo();
  socket.emit('queue_add', video);
  toast(video.type === 'link' ? 'Ссылка добавлена в очередь' : 'Добавлено в очередь');
  closeFilm();
}

$('filmWatch').addEventListener('click', watchFilm);
$('filmQueue').addEventListener('click', queueFilm);
$('filmClose').addEventListener('click', closeFilm);
$('filmModal').addEventListener('click', (e) => { if (e.target === $('filmModal')) closeFilm(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFilm(); });
// Пока окно открыто, Tab ходит по его кнопкам по кругу и не уходит на страницу под ним
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !filmOpen) return;
  const buttons = [...$('filmModal').querySelectorAll('button')].filter((b) => b.getClientRects().length > 0);
  if (!buttons.length) return;
  const first = buttons[0];
  const last = buttons[buttons.length - 1];
  const current = document.activeElement;
  if (!$('filmModal').contains(current)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  else if (e.shiftKey && current === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && current === last) { e.preventDefault(); first.focus(); }
});
$('catalogPickClear').addEventListener('click', () => { catalogPick = null; renderCatalogPick(); });

// Комната создана — включаем фильм, выбранный на экране входа
socket.on('room_created', () => {
  if (!catalogPick) return;
  const { video } = catalogPick;
  catalogPick = null;
  renderCatalogPick();
  socket.emit('set_video', video);
});
// Вошли в чужую комнату — выбор с экрана входа к ней не относится
socket.on('room_joined', () => { catalogPick = null; renderCatalogPick(); });

setupCatalog($('lobbyCatalog'), false);
setupCatalog($('roomCatalog'), true);
if (catalogFilms.length) {
  $('catalogJump').classList.remove('hidden');
  $('helpCatalog').classList.remove('hidden');
  $('catalogJump').addEventListener('click', () => {
    // шапка комнаты закреплена вверху экрана: прокручиваем так, чтобы она не закрыла заголовок раздела
    const header = document.querySelector('.topbar');
    const top = $('roomCatalog').getBoundingClientRect().top + window.scrollY - (header ? header.offsetHeight : 0) - 14;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  });
}
