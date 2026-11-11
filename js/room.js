/* Комната совместного просмотра: сокеты, плеер, чат, реакции. */

import {
  COLORS, makeId, getIdentity, saveIdentity, randomColor, initials, avatar,
  toast, copyText, formatClock, formatMessageTime, plural, debounce, clamp,
  escapeHtml,
} from './common.js';
import { CinemaPlayer } from './player.js';
import { parseSource } from './sources.js';

/* -------------------------------------------------------------- элементы */
const $ = (id) => document.getElementById(id);

const els = {
  codeValue: $('room-code-value'),
  copyCode: $('copy-code'),
  connection: $('connection'),
  connectionText: $('connection-text'),
  inviteBtn: $('invite-btn'),
  addVideoBtn: $('add-video-btn'),

  playerShell: $('player-shell'),
  playerStage: $('player-stage'),
  playerOverlay: $('player-overlay'),
  reactionsLayer: $('reactions-layer'),
  playerLoader: $('player-loader'),
  loaderText: $('loader-text'),
  syncBadge: $('sync-badge'),
  syncBadgeText: $('sync-badge-text'),
  playerBanner: $('player-banner'),
  unmuteBtn: $('unmute-btn'),
  fullscreenBtn: $('fullscreen-btn'),

  emptyState: $('empty-state'),
  emptyWaiting: $('empty-waiting'),
  emptyTitle: $('empty-title'),
  emptyText: $('empty-text'),
  emptyForm: $('empty-form'),
  emptyInput: $('empty-input'),
  emptySubmit: $('empty-submit'),
  emptyHint: $('empty-hint'),

  roomTitle: $('room-title'),
  sourceChip: $('source-chip'),
  hostLabel: $('host-label'),
  driftLabel: $('drift-label'),
  resyncBtn: $('resync-btn'),
  renameBtn: $('rename-btn'),
  modeToggle: $('mode-toggle'),

  tabChat: $('tab-chat'),
  tabPeople: $('tab-people'),
  panelChat: $('panel-chat'),
  panelPeople: $('panel-people'),
  peopleCount: $('people-count'),
  messages: $('messages'),
  typing: $('typing'),
  typingText: $('typing-text'),
  composer: $('composer'),
  messageInput: $('message-input'),
  sendBtn: $('send-btn'),
  quickReactions: $('quick-reactions'),
  peopleList: $('people-list'),
  modeHint: $('mode-hint'),

  nameModal: $('name-modal'),
  nameForm: $('name-form'),
  nameInput: $('name-input'),
  nameSubmit: $('name-submit'),
  colorRow: $('color-row'),

  inviteModal: $('invite-modal'),
  inviteLink: $('invite-link'),
  copyLinkBtn: $('copy-link'),
  inviteCode: $('invite-code'),
  shareNative: $('share-native'),

  sourceModal: $('source-modal'),
  sourceForm: $('source-form'),
  sourceInput: $('source-input'),
  sourceDetect: $('source-detect'),
  sourceDetectText: $('source-detect-text'),
  sourceSubmit: $('source-submit'),

  renameModal: $('rename-modal'),
  renameForm: $('rename-form'),
  renameInput: $('rename-input'),

  fatal: $('fatal'),
  fatalTitle: $('fatal-title'),
  fatalText: $('fatal-text'),
  toastLayer: $('toast-layer'),
};

/* -------------------------------------------------------------- состояние */
let socket = null;
let roomId = null;
let myId = null;
let myName = '';
let myColor = 'amber';
let currentRoom = null; // {id,title,mode,hostId,source,createdAt}
let playback = { playing: false, time: 0, serverNow: 0, by: '' };
let serverOffset = 0; // ms: оценочное смещение серверных часов относительно локальных
let rtt = 0;
let canControl = false;
let player = null;
let pingTimer = null;
let typingTimer = null;
let sourceDetectDebounce = null;

/* -------------------------------------------------------------- комната из URL */
function roomIdFromUrl() {
  const m = location.pathname.match(/\/r\/([a-z0-9]{6})/);
  if (m) return m[1];
  const qs = new URLSearchParams(location.search);
  const j = qs.get('join');
  return /^[a-z0-9]{6}$/.test(j || '') ? j : null;
}

/* -------------------------------------------------------------- часы/дрейф */
function pingClock() {
  if (!socket) return;
  const t = performance.now();
  socket.emit('ping:clock', { t }, (ack) => {
    if (!ack) return;
    const roundTrip = performance.now() - t;
    rtt = roundTrip;
    serverOffset = ack.serverNow + roundTrip / 2 - Date.now();
  });
}

function adjustedTime(snap) {
  // вермя на сервере прямо сейчас с учётом измеренной задержки сети
  const now = Date.now() + serverOffset;
  const elapsed = (now - snap.serverNow) / 1000;
  return snap.playing ? Math.max(0, snap.time + elapsed) : Math.max(0, snap.time);
}

function driftSeconds(snap) {
  const local = player ? player.getTime() : 0;
  return Math.abs(local - adjustedTime(snap));
}

/* -------------------------------------------------------------- подключение */
function setConnection(state) {
  const c = els.connection;
  const t = els.connectionText;
  c.className = 'connection';
  if (state === 'online') {
    c.classList.add('is-online');
    t.textContent = 'Онлайн';
  } else if (state === 'waiting') {
    c.classList.add('is-waiting');
    t.textContent = 'Подключение…';
  } else {
    c.classList.add('is-offline');
    t.textContent = 'Нет связи';
  }
}

function connect() {
  socket = io();

  socket.on('connect', () => setConnection('online'));
  socket.on('disconnect', () => setConnection('offline'));
  socket.on('reconnect_attempt', () => setConnection('waiting'));
  socket.on('reconnect', () => setConnection('online'));
  socket.on('connect_error', () => setConnection('offline'));

  socket.on('notice', (payload) => {
    toast(payload && payload.text ? payload.text : 'Ошибка сети.', payload && payload.type === 'error' ? 'error' : 'info');
  });

  /*_join_ */
  const identity = getIdentity();
  myId = identity.id;
  myName = identity.name;
  myColor = identity.color || randomColor();

  if (!myName) {
    openNameModal();
    setConnection('waiting');
    return;
  }
  joinRoom();
}

function joinRoom() {
  if (!roomId) {
    showFatal('Комната не задана', 'Откройте комнату по ссылке с кодом из шести символов.');
    return;
  }
  els.codeValue.textContent = roomId;

  socket.emit('room:join', { roomId, user: { id: myId, name: myName, color: myColor } }, (ack) => {
    if (ack && ack.ok) return;
    showFatal(
      'Комната не найдена',
      ack && ack.error === 'room_full'
        ? 'В комнате уже 60 человек — попробуйте позже.'
        : 'Возможно, ссылка устарела или комната закрылась.',
    );
  });

  socket.on('room:state', handleRoomState);
  socket.on('source', handleSource);
  socket.on('playback', handlePlayback);
  socket.on('presence', handlePresence);
  socket.on('room:meta', handleRoomMeta);
  socket.on('chat', handleChat);
  socket.on('typing', handleTyping);
  socket.on('reaction', handleReaction);
  socket.on('tick', handlePlayback);
}

/* -------------------------------------------------------------- рендер комнаты */
function handleRoomState(state) {
  currentRoom = state.room;
  playback = state.playback;
  renderRoomMeta(currentRoom, state.serverNow);
  renderUsers(state.users);
  renderMessages(state.messages);

  if (currentRoom.source) showSource(currentRoom.source);
  else showEmpty();

  updateControlFlags();
  applyPlayback(playback, true);
  startPing();
  setConnection('online');
  els.inviteBtn.disabled = false;
  els.addVideoBtn.disabled = false;
}

function handleSource(payload) {
  const room = payload && payload.room;
  if (!room) return;
  currentRoom = { ...currentRoom, ...room };
  playback = { playing: false, time: 0, serverNow: Date.now(), by: '' };
  renderRoomMeta(currentRoom);
  if (currentRoom.source) showSource(currentRoom.source);
  else showEmpty();
  applyPlayback(playback, true);
}

function handlePlayback(snap) {
  playback = snap;
  applyPlayback(snap);
  updateSyncBadge(snap);
}

function handlePresence({ users, hostId, mode }) {
  currentRoom = { ...currentRoom, hostId, mode };
  renderUsers(users);
  updateControlFlags();
  renderRoomMeta(currentRoom);
}

function handleRoomMeta({ mode, hostId, title }) {
  if (currentRoom) {
    currentRoom.mode = mode;
    currentRoom.hostId = hostId;
    if (title) currentRoom.title = title;
  }
  renderRoomMeta(currentRoom);
  updateControlFlags();
}

function updateControlFlags() {
  canControl = currentRoom ? (currentRoom.mode === 'all' || currentRoom.hostId === myId) : false;
  els.resyncBtn.disabled = !canControl;
  els.addVideoBtn.disabled = !canControl;
  els.renameBtn.hidden = currentRoom ? currentRoom.hostId !== myId : true;
  els.modeToggle.hidden = currentRoom ? currentRoom.hostId !== myId : true;
  els.emptyForm.disabled = !canControl;
  els.emptySubmit.disabled = !canControl;
  if (!canControl) {
    els.emptyInput.placeholder = 'Видео выбирает хост';
  } else {
    els.emptyInput.placeholder = 'https://youtube.com/watch?v=…';
  }
  if (els.modeToggle && !els.modeToggle.hidden) {
    [...els.modeToggle.querySelectorAll('button')].forEach((b) => {
      b.classList.toggle('is-active', b.dataset.mode === currentRoom.mode);
    });
  }
  els.modeHint.textContent = currentRoom
    ? currentRoom.mode === 'all'
      ? 'Управлять просмотром может каждый'
      : `Управляет ${currentRoom.hostId === myId ? 'вы' : 'хост'}`
    : '';
}

function renderRoomMeta(room, serverNow) {
  if (!room) return;
  els.roomTitle.textContent = room.title || 'Кинорум';
  document.title = `${room.title || 'Кинорум'} — COFfeeIT Cinema`;

  const source = room.source;
  if (source) {
    const info = parseSource(source.url);
    els.sourceChip.innerHTML = `<svg><use href="#i-film"/></svg> ${escapeHtml(source.title || info.label || 'видео')}`;
    els.sourceChip.hidden = false;
  } else {
    els.sourceChip.hidden = true;
  }
  // хост-подпись обновляется renderUsers()
}

function showEmpty() {
  const hasSource = Boolean(currentRoom && currentRoom.source);
  els.playerOverlay.hidden = false;
  els.emptyState.hidden = false;
  els.emptyWaiting.hidden = true;
  if (hasSource) {
    // такого не бывает, но страховка
    els.emptyState.hidden = true;
    els.emptyWaiting.hidden = false;
  }
  if (!canControl) {
    els.emptyState.hidden = true;
    els.emptyWaiting.hidden = false;
    els.emptyTitle.textContent = 'Хост выбирает видео';
    els.emptyText.textContent = 'Как только хост включит фильм, плеер появится у всех.';
  } else {
    els.emptyState.hidden = false;
    els.emptyWaiting.hidden = true;
    els.emptyTitle.textContent = 'Здесь начнётся ваш сеанс';
    els.emptyText.textContent = 'Вставьте ссылку на видео — и все в комнате увидят его одновременно.';
  }
  if (player) {
    player.destroy();
    player = null;
  }
  els.playerShell.classList.remove('has-player');
}

function showSource(source) {
  els.playerOverlay.hidden = true;
  els.emptyState.hidden = true;
  els.emptyWaiting.hidden = true;
  els.playerShell.classList.add('has-player');

  const info = parseSource(source.url);
  const label = source.title || info.label || 'видео';
  els.sourceChip.innerHTML = `<svg><use href="#i-film"/></svg> ${escapeHtml(label)}`;
  els.sourceChip.hidden = false;

  if (!player) {
    player = new CinemaPlayer(els.playerStage, {
      onReady: ({ duration }) => {
        els.playerLoader.hidden = true;
        applyPlayback(playback, true);
      },
      onProgress: ({ time }) => {
        // локальные часы плеера — подсвечиваем дрейф
        if (playback.playing) {
          const d = driftSeconds(playback);
          updateSyncBadge({ ...playback, drift: d });
        }
      },
      onAction: (action) => {
        // пользователь ткнул в плеер sendiri
        if (!canControl) {
          applyPlayback(playback, true);
          return;
        }
        if (action.type === 'play') socket.emit('playback:play', { time: action.time });
        else if (action.type === 'pause') socket.emit('playback:pause', { time: action.time });
        else if (action.type === 'seek') socket.emit('playback:seek', { time: action.time, playing: action.playing });
      },
      onError: (msg) => {
        toast(msg, 'error');
        showEmpty();
      },
      onBlocked: () => {
        els.playerBanner.hidden = false;
      },
    });
  }
  player.load(source);
  els.playerLoader.hidden = false;
  els.loaderText.textContent = info.syncable ? 'Запускаем плеер…' : 'Открываем страницу видео…';
}

function startPing() {
  stopPing();
  pingClock();
  pingTimer = setInterval(pingClock, 3000);
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function applyPlayback(snap, force = false) {
  if (!player) return;
  const target = adjustedTime(snap);
  const drift = driftSeconds(snap);
  if (!force && drift < 0.15 && snap.playing === playerIsPlaying()) return;
  player.applyState(target, snap.playing);
  updateDriftLabel(drift);
}

function playerIsPlaying() {
  return player && !player.isPaused();
}

function updateSyncBadge(snap) {
  els.syncBadge.hidden = !Boolean(currentRoom && currentRoom.source);
  if (!els.syncBadge.hidden) {
    const d = snap.drift !== undefined ? snap.drift : driftSeconds(snap);
    els.syncBadge.classList.toggle('is-drift', d > 0.8);
    els.syncBadgeText.textContent = d > 0.8 ? 'Синхронизируем…' : 'Синхронизировано';
  }
}

function updateDriftLabel(drift) {
  if (!els.driftLabel) return;
  if (drift > 0.8) {
    els.driftLabel.hidden = false;
    els.driftLabel.textContent = `дрейф ${drift.toFixed(1)} с`;
  } else {
    els.driftLabel.hidden = true;
  }
}

/* -------------------------------------------------------------- пользователи */
function handleChat(message) {
  appendMessage(message);
}

function appendMessage(message) {
  const own = message.userId === myId;
  const system = Boolean(message.system);
  const el = document.createElement('div');
  el.className = `message${own ? ' is-own' : ''}${system ? ' is-system' : ''}`;
  if (system) {
    el.innerHTML = `<div class="system-text">${escapeHtml(message.text || '')}</div>`;
  } else {
    const name = escapeHtml(message.name || 'Гость');
    const time = message.ts ? formatMessageTime(message.ts) : '';
    const color = COLORS.includes(message.color) ? message.color : 'amber';
    el.innerHTML = `
      ${avatar(name, color, 'avatar-sm')}
      <div class="message-body">
        <div class="message-head">
          <span class="message-name">${name}${own ? ' <span class="person-you">вы</span>' : ''}</span>
          <span class="message-time">${time}</span>
        </div>
        <div class="message-text">${escapeHtml(message.text || '')}</div>
      </div>`;
  }
  els.messages.appendChild(el);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderMessages(messages) {
  els.messages.innerHTML = '';
  (messages || []).forEach(appendMessage);
}

function renderUsers(users) {
  els.peopleList.innerHTML = '';
  els.peopleCount.textContent = users ? users.length : 0;
  const hostId = currentRoom ? currentRoom.hostId : null;

  (users || []).forEach((user) => {
    const el = document.createElement('li');
    el.className = `person${user.isHost ? ' is-host' : ''}${!user.online ? ' is-offline' : ''}`;
    const name = escapeHtml(user.name || 'Гость');
    const color = COLORS.includes(user.color) ? user.color : 'amber';
    const isHost = user.id === hostId;
    const isYou = user.id === myId;

    let actionHtml = '';
    if (myId === hostId && !isHost && user.online) {
      actionHtml = `<button class="person-action" type="button" data-make-host="${escapeHtml(user.id)}">сделать хостом</button>`;
    }

    el.innerHTML = `
      ${avatar(name, color)}
      <div class="person-info">
        <div class="person-name">
          ${isHost ? '<svg class="host-crown"><use href="#i-crown"/></svg>' : ''}
          ${name}${isYou ? ' <span class="person-you">вы</span>' : ''}
        </div>
        <div class="person-meta">${isHost && currentRoom && currentRoom.mode === 'all' ? 'хост · все управляют' : isHost ? 'хост' : ''}${user.online ? '' : ' · офлайн'}</div>
      </div>
      ${actionHtml}
    `;
    els.peopleList.appendChild(el);
  });

  // хост-метка в шапке/мета
  const hostUser = users ? users.find((u) => u.id === hostId) : null;
  if (hostUser) {
    els.hostLabel.innerHTML = `Хост: <span style="display:inline">${escapeHtml(hostUser.name)}</span>${
      hostUser.id === myId ? ' <span class="person-you">вы</span>' : ''
    }`;
  } else {
    els.hostLabel.textContent = 'Хост: —';
  }
}

/* -------------------------------------------------------------- чат */
function sendMessage() {
  const text = els.messageInput.value.trim();
  if (!text) return;
  socket.emit('chat:send', { text });
  els.messageInput.value = '';
  resizeTextarea();
  emitTyping(false);
}

els.composer.addEventListener('submit', (ev) => {
  ev.preventDefault();
  sendMessage();
});

els.messageInput.addEventListener('input', () => {
  resizeTextarea();
  emitTyping(true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => emitTyping(false), 1500);
});
els.messageInput.addEventListener('blur', () => emitTyping(false));

function resizeTextarea() {
  els.messageInput.style.height = 'auto';
  els.messageInput.style.height = `${Math.min(112, els.messageInput.scrollHeight)}px`;
}

let typingTimeout = null;
function emitTyping(active) {
  if (!socket) return;
  socket.emit('chat:typing', { active });
}

function handleTyping({ name, active }) {
  if (!active) {
    els.typing.hidden = true;
    els.typingText.textContent = '';
    return;
  }
  els.typingText.textContent = `${escapeHtml(name || '')} печатает…`;
  els.typing.hidden = false;
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => { els.typing.hidden = true; }, 2500);
}

/* -------------------------------------------------------------- реакции */
function spawnReaction(emoji, name, x) {
  const el = document.createElement('div');
  el.className = 'reaction';
  el.style.left = `${clamp(x, 5, 95)}%`;
  el.dataset.name = escapeHtml(name || '');
  el.textContent = emoji;
  els.reactionsLayer.appendChild(el);
  setTimeout(() => el.remove(), 2700);
}

function handleReaction({ emoji, name, x }) {
  spawnReaction(emoji, name, x);
}

els.quickReactions.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-emoji]');
  if (!btn || !socket) return;
  socket.emit('reaction', { emoji: btn.dataset.emoji });
  spawnReaction(btn.dataset.emoji, myName, 50);
  btn.style.transform = 'scale(1.2)';
  setTimeout(() => { btn.style.transform = ''; }, 150);
});

/* -------------------------------------------------------------- управление */
els.resyncBtn.addEventListener('click', () => {
  socket.emit('sync:request');
  toast('Синхронизировались с комнатой');
});

els.fullscreenBtn.addEventListener('click', async () => {
  const shell = els.playerShell;
  if (shell.requestFullscreen) await shell.requestFullscreen().catch(() => {});
});

els.unmuteBtn.addEventListener('click', async () => {
  if (!player) return;
  await player.play();
  els.playerBanner.hidden = true;
});

/* пустая форма — oferta хоста */
els.emptyForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (!canControl) return;
  const value = els.emptyInput.value.trim();
  const info = parseSource(value);
  if (!info.url) {
    els.emptyForm.classList.add('is-shaking');
    setTimeout(() => els.emptyForm.classList.remove('is-shaking'), 450);
    toast('Не похоже на ссылку на видео', 'error');
    return;
  }
  setSource({ url: value, kind: info.kind, title: '' });
});

/* модальная форма источника */
let sourceModalInfo = null;
els.sourceInput.addEventListener('input', debounce((ev) => {
  const info = parseSource(ev.target.value.trim());
  sourceModalInfo = info;
  els.sourceDetect.classList.remove('is-valid', 'is-invalid');
  if (!info.url) {
    els.sourceDetectText.textContent = 'YouTube, Vimeo, Rutube, VK, mp4, m3u8 и другие ссылки';
    return;
  }
  els.sourceDetect.classList.add(info.syncable ? 'is-valid' : 'is-invalid');
  els.sourceDetectText.textContent = info.syncable
    ? `Похоже на ${info.label} — проигрывается синхронно для всех`
    : `Похоже на ${info.label} — только чат и реакции (видео каждый смотрит сам)`;
}, 250));

els.sourceForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (!canControl) return;
  const value = els.sourceInput.value.trim();
  const info = parseSource(value);
  if (!info.url) {
    els.sourceForm.classList.add('is-shaking');
    setTimeout(() => els.sourceForm.classList.remove('is-shaking'), 450);
    return;
  }
  closeModal(els.sourceModal);
  setSource({ url: value, kind: info.kind, title: '' });
});

function setSource(source) {
  els.playerLoader.hidden = false;
  els.loaderText.textContent = 'Переключаем видео…';
  socket.emit('source:set', { source, title: '' });
}

/* -------------------------------------------------------------- модалки */
function openModal(modal) {
  modal.hidden = false;
}

function closeModal(modal) {
  modal.hidden = true;
}

document.addEventListener('click', (ev) => {
  const close = ev.target.closest('[data-close-modal]');
  if (close) {
    const modal = close.closest('.modal');
    if (modal) closeModal(modal);
  }
  if (ev.target.classList.contains('modal')) closeModal(ev.target);
});

/* имя + цвет */
function openNameModal() {
  openModal(els.nameModal);
  els.nameInput.value = myName || '';
  renderColorDots(myColor);
}

function renderColorDots(selected) {
  els.colorRow.innerHTML = '';
  COLORS.forEach((color) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = `color-dot${color === selected ? ' is-active' : ''} color-${color}`;
    dot.setAttribute('aria-pressed', color === selected);
    dot.title = color;
    dot.addEventListener('click', () => {
      myColor = color;
      renderColorDots(color);
    });
    els.colorRow.appendChild(dot);
  });
}

els.nameForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const name = els.nameInput.value.trim();
  if (!name) return;
  myName = name;
  saveIdentity({ id: myId, name: myName, color: myColor });
  closeModal(els.nameModal);
  joinRoom();
});

/* приглашение */
els.inviteBtn.addEventListener('click', () => {
  els.inviteLink.value = `${location.origin}/r/${roomId}`;
  els.inviteCode.textContent = roomId;
  openModal(els.inviteModal);
});

els.copyCode.addEventListener('click', async () => {
  ok = await copyText(roomId);
  toast(ok ? 'Код скопирован' : 'Не удалось скопировать');
});

els.copyLinkBtn.addEventListener('click', async () => {
  const ok = await copyText(els.inviteLink.value);
  toast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать');
});

els.shareNative.addEventListener('click', async () => {
  try {
    await navigator.share({
      title: 'Кинозал COFfeeIT Cinema',
      text: 'Смотрим вместе — переходите по ссылке',
      url: `${location.origin}/r/${roomId}`,
    });
  } catch {
    /* игнорируем: пользователь отменил или API нет */
  }
});

[ 'share-telegram', 'share-whatsapp', 'share-vk' ].forEach((id) => {
  const link = $(id);
  link.addEventListener('click', () => {
    const text = encodeURIComponent('Смотрим вместе в COFfeeIT Cinema');
    const url = encodeURIComponent(`${location.origin}/r/${roomId}`);
    if (id === 'share-telegram') location.href = `https://t.me/share/url?url=${url}&text=${text}`;
    else if (id === 'share-whatsapp') location.href = `https://wa.me/?text=${text}%20${url}`;
    else location.href = `https://vk.com/share.php?url=${url}&title=${text}`;
  });
});

/* переименование (только хост) */
els.renameBtn.addEventListener('click', () => {
  els.renameInput.value = currentRoom ? currentRoom.title : '';
  openModal(els.renameModal);
});

els.renameForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const title = els.renameInput.value.trim();
  if (!title || !socket) return;
  socket.emit('room:rename', { title });
  closeModal(els.renameModal);
});

/* смена хоста */
els.peopleList.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-make-host]');
  if (!btn || !socket) return;
  const uid = btn.dataset.makeHost;
  socket.emit('room:host', { uid });
});

/* вкладки сайдбара */
els.tabChat.addEventListener('click', () => {
  els.tabChat.classList.add('is-active');
  els.tabPeople.classList.remove('is-active');
  els.panelChat.hidden = false;
  els.panelPeople.hidden = true;
});
els.tabPeople.addEventListener('click', () => {
  els.tabPeople.classList.add('is-active');
  els.tabChat.classList.remove('is-active');
  els.panelPeople.hidden = false;
  els.panelChat.hidden = true;
});

/* -------------------------------------------------------------- фатальный экран */
function showFatal(title, text) {
  els.fatal.hidden = false;
  els.fatalTitle.textContent = title;
  els.fatalText.textContent = text;
  els.playerOverlay.hidden = true;
}

/* -------------------------------------------------------------- старт */
roomId = roomIdFromUrl();
if (!roomId) {
  showFatal('Комната не задана', 'Перейдите по ссылке с кодом комнаты (шесть символов).');
} else {
  connect();
}
