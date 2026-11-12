/* ===== SyncWatch — режим без сервера =====
 *
 * Когда в config.js не указан адрес сервера, комнаты работают напрямую между браузерами
 * участников (технология WebRTC). Найти друг друга участникам помогает бесплатный
 * сервис PeerJS (https://peerjs.com): он только знакомит браузеры между собой,
 * а события просмотра и сообщения чата идут от участника к участнику.
 *
 * Как устроена комната:
 *  - организатор (кто создал комнату) занимает на сервисе PeerJS «адрес комнаты» и
 *    выполняет роль сервера: хранит состояние комнаты и рассылает события остальным;
 *  - остальные подключаются к нему по коду комнаты;
 *  - у каждого участника есть копия состояния. Если организатор вышел, адрес комнаты
 *    занимает следующий участник — комната живёт, пока в ней есть хотя бы один человек.
 *
 * Снаружи модуль выглядит как сокет Socket.IO (on / emit / connected / id), а события
 * те же, что у server.js. Поэтому остальной код сайта одинаков для обоих режимов.
 */
(function (global) {
  'use strict';

  // Сервис PeerJS общий для всех сайтов, поэтому адреса комнат начинаются с префикса
  const ROOM_PREFIX = 'syncwatch-room-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const REACTION_KEYS = ['heart', 'fire', 'laugh', 'wow', 'clap', 'sad', 'party'];
  const VIDEO_TYPES = ['youtube', 'vimeo', 'direct'];
  const DEFAULT_COLOR = '#4f46e5';
  const MAX_MEMBERS = 30;
  const MAX_QUEUE = 50;
  const MAX_MESSAGES = 60;
  // PeerJS передаёт сообщения до 16 КБ. Длинные (история чата, очередь) режем на части
  const PART_CHARS = 2500;
  const MAX_PARTS = 200;

  // Все времена — в миллисекундах
  const DEFAULT_TIMING = {
    signalOpen: 10000,     // ждём ответа сервиса PeerJS
    connect: 12000,        // ждём соединения с организатором при входе
    connectRecover: 7000,  // то же при восстановлении комнаты
    welcome: 6000,         // ждём состояние комнаты после соединения
    joinSearch: 6000,      // сколько ищем комнату (сервис отвечает «такой нет» примерно через 5 с)
    ping: 5000,            // участник → организатор
    hubSilence: 16000,     // организатор молчит дольше — считаем, что связь с ним потеряна
    rep: 8000,             // организатор → участники: копия состояния
    memberSilence: 20000,  // участник молчит дольше — считаем его соединение оборванным
    memberGrace: 12000,    // сколько держим место за участником, у которого оборвалась связь
    returnGrace: 30000,    // после смены организатора ждём возвращения остальных
    claimStagger: 6000,    // очерёдность, в которой участники пробуют стать организатором
    nextGuard: 2500,       // «следующее видео» от нескольких участников сразу считаем одним
    signalRetry: [1000, 2000, 4000, 8000, 15000]
  };

  // ---------- Небольшие помощники ----------
  function randomId(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    let bytes = null;
    if (global.crypto && global.crypto.getRandomValues) {
      bytes = new Uint8Array(length);
      global.crypto.getRandomValues(bytes);
    }
    for (let i = 0; i < length; i++) {
      out += chars[(bytes ? bytes[i] : Math.floor(Math.random() * 256)) % chars.length];
    }
    return out;
  }
  function genCode() {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return code;
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Идентификатор участника получается из его секрета: зная чужой идентификатор
  // (он виден всем в списке участников), занять чужое место нельзя
  async function publicId(secret) {
    const text = 'syncwatch-member:' + secret;
    if (global.crypto && global.crypto.subtle && global.TextEncoder) {
      try {
        const digest = await global.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(digest).slice(0, 10), (b) => b.toString(16).padStart(2, '0')).join('');
      } catch (e) { /* ниже — запасной способ */ }
    }
    // Страница открыта не по https — криптография браузера недоступна
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b);
      h2 ^= h2 >>> 13;
    }
    const hex = (n) => ('0000000' + (n >>> 0).toString(16)).slice(-8);
    return hex(h1) + hex(h2) + 'ffff';
  }

  // ---------- Проверка данных ----------
  // В этом режиме данные приходят из браузеров других участников, поэтому всё входящее
  // проверяется — и у организатора, и у остальных.
  function cleanText(value, max) {
    return (typeof value === 'string' ? value : '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max);
  }
  function cleanName(value) {
    return cleanText(value == null ? '' : String(value), 24).trim() || 'Гость';
  }
  function cleanColor(value) {
    return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : DEFAULT_COLOR;
  }
  function cleanId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : null;
  }
  function cleanCode(value) {
    const code = String(value == null ? '' : value).toUpperCase().trim();
    return /^[A-Z0-9]{4,8}$/.test(code) ? code : null;
  }
  function safeUrl(value) {
    if (typeof value !== 'string') return null;
    const url = value.trim();
    if (!/^https?:\/\//i.test(url) || /[\u0000-\u001f\u007f]/.test(url)) return null;
    return url.slice(0, 2000);
  }
  function finiteNum(value) {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? num : null;
  }
  function cleanVideo(value) {
    if (!value || typeof value !== 'object') return null;
    const url = safeUrl(value.url);
    if (!url) return null;
    return {
      url,
      type: VIDEO_TYPES.includes(value.type) ? value.type : 'direct',
      title: cleanText(value.title, 200) || 'Видео',
      addedBy: cleanId(value.addedBy),
      addedByName: cleanName(value.addedByName)
    };
  }
  function cleanQueue(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list.slice(0, MAX_QUEUE)) {
      const video = cleanVideo(item);
      const id = item && cleanId(item.id);
      if (video && id) out.push({ id, url: video.url, type: video.type, title: video.title, addedByName: video.addedByName });
    }
    return out;
  }
  function cleanUsers(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const user of list.slice(0, MAX_MEMBERS + 5)) {
      const id = user && cleanId(user.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: cleanName(user.name), color: cleanColor(user.color), rank: finiteNum(user.rank) || 0 });
    }
    return out;
  }
  function cleanMessage(value) {
    if (!value || typeof value !== 'object') return null;
    const id = cleanId(value.id);
    const text = cleanText(value.text, 500).trim();
    if (!id || !text) return null;
    return { id, name: cleanName(value.name), color: cleanColor(value.color), text, time: finiteNum(value.time) || Date.now() };
  }
  function cleanMessages(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(-MAX_MESSAGES).map(cleanMessage).filter(Boolean);
  }
  // Состояние комнаты в том виде, в каком его ждёт app.js
  function cleanState(value) {
    const s = value && typeof value === 'object' ? value : {};
    return {
      roomId: cleanCode(s.roomId),
      users: cleanUsers(s.users).map((u) => ({ id: u.id, name: u.name, color: u.color })),
      hostId: cleanId(s.hostId),
      video: cleanVideo(s.video),
      queue: cleanQueue(s.queue),
      playing: !!s.playing,
      position: finiteNum(s.position) || 0,
      startedAt: null,
      messages: cleanMessages(s.messages)
    };
  }
  // Копия состояния, из которой участник может продолжить комнату как организатор
  function cleanReplica(value) {
    const r = value && typeof value === 'object' ? value : {};
    return {
      code: cleanCode(r.code),
      ver: finiteNum(r.ver) || 0,
      rankSeq: finiteNum(r.rankSeq) || 0,
      hostId: cleanId(r.hostId),
      users: cleanUsers(r.users),
      video: cleanVideo(r.video),
      queue: cleanQueue(r.queue),
      playing: !!r.playing,
      position: finiteNum(r.position) || 0
    };
  }
  // События, которые организатор присылает участникам (те же, что рассылает server.js)
  function cleanEvent(name, p) {
    switch (name) {
      case 'users_update':
      case 'sync_state':
        return cleanState(p);
      case 'system_message':
        return { text: cleanText(p && p.text, 300), time: Date.now() };
      case 'video_changed': {
        const video = cleanVideo(p && p.video);
        return video ? { video } : null;
      }
      case 'remote_play':
      case 'remote_pause':
      case 'remote_seek': {
        const time = finiteNum(p && p.time);
        return time === null ? null : { time };
      }
      case 'chat_message':
        return cleanMessage(p);
      case 'reaction':
        return p && REACTION_KEYS.includes(p.emoji) ? { emoji: p.emoji } : null;
      case 'queue_update':
        return cleanQueue(p);
      case 'app_error':
        return { message: cleanText(p && p.message, 300) || 'Произошла ошибка' };
      default:
        return null;
    }
  }

  // ---------- Логика комнаты (то же, что делает server.js) ----------
  // Работает в браузере организатора. out — куда отправлять события:
  // all(event, data), others(exceptId, event, data), to(id, event, data), changed().
  function RoomCore(code, out, timing) {
    this.code = code;
    this.out = out;
    this.timing = timing;
    this.users = new Map(); // id -> { id, name, color, rank }
    this.hostId = null;
    this.video = null;
    this.queue = [];
    this.playing = false;
    this.position = 0;
    this.startedAt = null;
    this.messages = [];
    this.ver = 0;
    this.rankSeq = 0;
    this.lastNextAt = 0;
  }
  RoomCore.prototype.positionNow = function () {
    let position = this.position || 0;
    if (this.playing && this.startedAt) position += (Date.now() - this.startedAt) / 1000;
    return Math.max(0, position);
  };
  RoomCore.prototype.userList = function () {
    return Array.from(this.users.values()).sort((a, b) => a.rank - b.rank);
  };
  RoomCore.prototype.snapshot = function () {
    return {
      roomId: this.code,
      users: this.userList().map((u) => ({ id: u.id, name: u.name, color: u.color })),
      hostId: this.hostId,
      video: this.video,
      queue: this.queue,
      playing: this.playing,
      position: this.positionNow(),
      startedAt: this.startedAt,
      messages: this.messages
    };
  };
  RoomCore.prototype.replica = function () {
    return {
      code: this.code,
      ver: this.ver,
      rankSeq: this.rankSeq,
      hostId: this.hostId,
      users: this.userList(),
      video: this.video,
      queue: this.queue,
      playing: this.playing,
      position: this.positionNow()
    };
  };
  // Продолжить комнату из копии состояния
  RoomCore.prototype.adopt = function (replica, messages) {
    this.ver = Math.max(this.ver, replica.ver);
    this.rankSeq = Math.max(this.rankSeq, replica.rankSeq);
    this.video = replica.video;
    this.queue = replica.queue.slice();
    this.playing = !!(replica.playing && replica.video);
    this.position = replica.position;
    this.startedAt = this.playing ? Date.now() : null;
    if (messages) this.messages = messages.slice(-MAX_MESSAGES);
  };
  RoomCore.prototype.touch = function () {
    this.ver += 1;
    this.out.changed();
  };
  RoomCore.prototype.addUser = function (id, name, color) {
    this.rankSeq += 1;
    this.users.set(id, { id, name, color, rank: this.rankSeq });
    if (!this.hostId) this.hostId = id;
    this.touch();
  };
  RoomCore.prototype.updateUser = function (id, name, color) {
    const user = this.users.get(id);
    if (!user || (user.name === name && user.color === color)) return false;
    user.name = name;
    user.color = color;
    this.touch();
    this.out.all('users_update', this.snapshot());
    return true;
  };
  RoomCore.prototype.announceJoin = function (id, created) {
    const user = this.users.get(id);
    if (!user) return;
    this.out.all('users_update', this.snapshot());
    this.out.all('system_message', { text: `${user.name} ${created ? 'создал комнату' : 'подключился к комнате'}`, time: Date.now() });
  };
  RoomCore.prototype.removeUser = function (id) {
    const user = this.users.get(id);
    if (!user) return;
    this.users.delete(id);
    this.touch();
    this.out.all('users_update', this.snapshot());
    this.out.all('system_message', { text: `${user.name} покинул комнату`, time: Date.now() });
  };
  RoomCore.prototype.setVideo = function (video) {
    this.video = video;
    this.playing = false;
    this.position = 0;
    this.startedAt = null;
    this.touch();
    this.out.all('video_changed', { video: this.video, state: this.snapshot() });
  };
  RoomCore.prototype.handle = function (memberId, event, payload) {
    const user = this.users.get(memberId);
    if (!user) return;
    const data = payload && typeof payload === 'object' ? payload : {};
    switch (event) {
      case 'set_video': {
        const url = safeUrl(data.url);
        if (!url) {
          this.out.to(memberId, 'app_error', { message: 'Некорректная ссылка. Нужна ссылка, начинающаяся с http:// или https://' });
          return;
        }
        const type = VIDEO_TYPES.includes(data.type) ? data.type : 'direct';
        const title = cleanText(String(data.title || 'Видео'), 200) || 'Видео';
        this.setVideo({ url, type, title, addedBy: memberId, addedByName: user.name });
        this.out.all('system_message', { text: `${user.name} добавил видео: ${title}`, time: Date.now() });
        return;
      }
      case 'play': {
        const time = finiteNum(data.time);
        this.playing = true;
        this.position = time !== null ? time : this.position;
        this.startedAt = Date.now();
        this.touch();
        this.out.others(memberId, 'remote_play', { time: this.position, by: user.name });
        return;
      }
      case 'pause': {
        if (this.playing && this.startedAt) this.position += (Date.now() - this.startedAt) / 1000;
        const time = finiteNum(data.time);
        if (time !== null) this.position = time;
        this.playing = false;
        this.startedAt = null;
        this.touch();
        this.out.others(memberId, 'remote_pause', { time: this.position, by: user.name });
        return;
      }
      case 'seek': {
        const time = finiteNum(data.time);
        if (time === null) return;
        this.position = time;
        if (this.playing) this.startedAt = Date.now();
        this.touch();
        this.out.others(memberId, 'remote_seek', { time, by: user.name });
        return;
      }
      case 'sync_request':
        this.out.to(memberId, 'sync_state', this.snapshot());
        return;
      case 'chat_message': {
        const text = cleanText(String(data.text || ''), 500).trim();
        if (!text) return;
        const message = { id: `${Date.now()}_${randomId(6)}`, name: user.name, color: user.color, text, time: Date.now() };
        this.messages.push(message);
        if (this.messages.length > MAX_MESSAGES) this.messages.shift();
        this.out.all('chat_message', message);
        return;
      }
      case 'reaction': {
        if (!REACTION_KEYS.includes(data.emoji)) return;
        // Отправитель показывает свою реакцию сам — ему её не возвращаем
        this.out.others(memberId, 'reaction', { emoji: data.emoji, name: user.name, id: Date.now() + Math.random() });
        return;
      }
      case 'queue_add': {
        const url = safeUrl(data.url);
        if (!url) {
          this.out.to(memberId, 'app_error', { message: 'Некорректная ссылка на видео' });
          return;
        }
        if (this.queue.length >= MAX_QUEUE) {
          this.out.to(memberId, 'app_error', { message: 'Очередь заполнена' });
          return;
        }
        const type = VIDEO_TYPES.includes(data.type) ? data.type : 'direct';
        const title = cleanText(String(data.title || 'Видео'), 200) || 'Видео';
        this.queue.push({ id: `${Date.now()}_${randomId(6)}`, url, type, title, addedByName: user.name });
        this.touch();
        this.out.all('queue_update', this.queue);
        this.out.all('system_message', { text: `${user.name} добавил в очередь: ${title}`, time: Date.now() });
        return;
      }
      case 'queue_remove': {
        const before = this.queue.length;
        this.queue = this.queue.filter((item) => item.id !== data.id);
        if (this.queue.length !== before) this.touch();
        this.out.all('queue_update', this.queue);
        return;
      }
      case 'queue_next': {
        if (this.queue.length === 0) return;
        // Когда видео заканчивается, «следующее» просит каждый участник — переключаем один раз
        if (Date.now() - this.lastNextAt < this.timing.nextGuard) return;
        this.lastNextAt = Date.now();
        const next = this.queue.shift();
        this.setVideo({ url: next.url, type: next.type, title: next.title, addedBy: memberId, addedByName: user.name });
        this.out.all('queue_update', this.queue);
        return;
      }
      default:
    }
  };

  // ---------- Сокет ----------
  function createSocket(options) {
    const opts = options || {};
    const timing = Object.assign({}, DEFAULT_TIMING, opts.timing || {});
    const peerOptions = Object.assign({ debug: 0 }, opts.peer || {});
    const libUrl = opts.lib || 'vendor/peerjs.min.js';

    const handlers = Object.create(null);
    const outbox = [];
    let flushScheduled = false;

    const me = { secret: randomId(32), id: null, name: 'Гость', color: DEFAULT_COLOR };
    const myIdReady = publicId(me.secret).then((id) => { if (!me.id) me.id = id; });

    let PeerCtor = null;
    let lib = 'loading';       // loading | ready | failed | unsupported
    let role = 'idle';         // idle | hub | member | recovering
    let epoch = 0;             // растёт при каждой смене роли: так отменяются начатые ранее действия
    let busy = false;          // идёт создание комнаты или вход
    let closed = false;
    let online = false;        // то, что видит app.js через события connect / disconnect
    let lastError = null;
    const stats = { sent: 0, received: 0 };

    // связь с сервисом PeerJS для экрана входа и для участника
    let clientPeer = null;
    let clientRetry = 0;
    let clientTimer = null;
    const peerUnavailable = new Map(); // адрес комнаты -> обработчик «такой комнаты нет»

    // организатор
    let hubPeer = null;
    let core = null;
    const members = new Map();        // id -> { conn, id, lastSeen, graceTimer }
    const pendingReturn = new Map();  // id -> таймер: ждём возвращения после смены организатора
    let repTimer = null;
    let repScheduled = false;

    // участник
    let hubLink = null;
    let replica = null;
    let replicaAt = 0;
    let history = [];
    let lastHubSeen = 0;
    let pingTimer = null;

    // --- события для app.js (доставляются асинхронно, как у настоящего сокета) ---
    function emitLocal(event, data) {
      outbox.push([event, data]);
      if (flushScheduled) return;
      flushScheduled = true;
      Promise.resolve().then(() => {
        flushScheduled = false;
        const items = outbox.splice(0);
        for (const [name, payload] of items) {
          for (const fn of (handlers[name] || []).slice()) {
            try { fn(payload); } catch (e) { console.error(e); }
          }
        }
      });
    }
    function notice(text) { emitLocal('notice', { text }); }

    function isConnected() {
      if (closed) return false;
      if (role === 'hub') return !!hubPeer && !hubPeer.destroyed;
      if (role === 'member') return !!hubLink && hubLink.conn.open;
      if (role === 'recovering') return false;
      return !!clientPeer && clientPeer.open && !clientPeer.disconnected && !clientPeer.destroyed;
    }
    function refreshOnline() {
      const now = isConnected();
      if (now === online) return;
      online = now;
      emitLocal(now ? 'connect' : 'disconnect');
    }
    function reportError(type, message) {
      lastError = { type, message: String(message || '') };
      emitLocal('connect_error', lastError);
    }

    // --- передача сообщений ---
    function send(conn, message) {
      if (!conn || !conn.open) return false;
      try {
        const text = JSON.stringify(message);
        stats.sent += 1;
        if (text.length <= PART_CHARS) {
          conn.send(message);
          return true;
        }
        const key = randomId(8);
        const total = Math.ceil(text.length / PART_CHARS);
        if (total > MAX_PARTS) return false;
        for (let i = 0; i < total; i++) {
          conn.send({ t: 'part', k: key, i, n: total, d: text.slice(i * PART_CHARS, (i + 1) * PART_CHARS) });
        }
        return true;
      } catch (e) {
        return false;
      }
    }
    // Собирает сообщение из частей. Возвращает готовое сообщение или null
    function unpack(link, raw) {
      if (!raw || typeof raw !== 'object' || typeof raw.t !== 'string') return null;
      if (raw.t !== 'part') return raw;
      const total = Number(raw.n);
      const index = Number(raw.i);
      if (typeof raw.k !== 'string' || typeof raw.d !== 'string' || raw.d.length > PART_CHARS) return null;
      if (!Number.isInteger(total) || !Number.isInteger(index) || total < 2 || total > MAX_PARTS || index < 0 || index >= total) return null;
      if (!link.parts || link.parts.key !== raw.k) link.parts = { key: raw.k, total, items: [], count: 0 };
      const parts = link.parts;
      if (parts.total !== total || parts.items[index] !== undefined) return null;
      parts.items[index] = raw.d;
      parts.count += 1;
      if (parts.count < total) return null;
      link.parts = null;
      try {
        const message = JSON.parse(parts.items.join(''));
        return message && typeof message === 'object' && typeof message.t === 'string' && message.t !== 'part' ? message : null;
      } catch (e) {
        return null;
      }
    }
    function closeConn(conn) {
      try { if (conn) conn.close(); } catch (e) { /* уже закрыто */ }
    }
    function destroyPeer(peer) {
      try { if (peer && !peer.destroyed) peer.destroy(); } catch (e) { /* уже уничтожен */ }
    }
    function retryDelay(attempt) {
      const list = timing.signalRetry;
      return list[Math.min(attempt, list.length - 1)];
    }

    // ---------- Связь с сервисом PeerJS (экран входа и роль участника) ----------
    function startClientPeer() {
      if (closed || lib !== 'ready') return;
      if (clientPeer && !clientPeer.destroyed) return;
      clearTimeout(clientTimer);
      let peer;
      try {
        peer = new PeerCtor('sw-' + randomId(20), peerOptions);
      } catch (e) {
        reportError('network', e && e.message);
        scheduleClientRetry();
        return;
      }
      clientPeer = peer;
      peer.on('open', () => {
        if (clientPeer !== peer) return;
        clientRetry = 0;
        lastError = null;
        refreshOnline();
      });
      peer.on('disconnected', () => {
        if (clientPeer !== peer) return;
        refreshOnline();
        scheduleClientRetry();
      });
      peer.on('close', () => {
        if (clientPeer !== peer) return;
        clientPeer = null;
        refreshOnline();
        scheduleClientRetry();
      });
      peer.on('error', (err) => {
        if (clientPeer !== peer) return;
        const type = err && err.type;
        if (type === 'peer-unavailable') {
          // «такой комнаты нет» — это ответ на попытку входа, а не сбой связи
          const text = String((err && err.message) || '');
          peerUnavailable.forEach((fn, target) => { if (text.indexOf(target) !== -1) fn(); });
          return;
        }
        if (type === 'browser-incompatible') {
          lib = 'unsupported';
          reportError('unsupported', err.message);
          return;
        }
        if (type === 'webrtc') return;
        if (role === 'idle') reportError('network', err && err.message);
      });
    }
    function scheduleClientRetry() {
      if (closed || lib !== 'ready' || role === 'hub') return;
      clearTimeout(clientTimer);
      clientTimer = setTimeout(() => {
        if (closed || role === 'hub') return;
        const peer = clientPeer;
        if (!peer || peer.destroyed) { clientPeer = null; startClientPeer(); return; }
        if (peer.open && !peer.disconnected) return;
        try {
          peer.reconnect();
        } catch (e) {
          destroyPeer(peer);
        }
      }, retryDelay(clientRetry++));
    }
    function stopClientPeer() {
      clearTimeout(clientTimer);
      const peer = clientPeer;
      clientPeer = null;
      destroyPeer(peer);
    }
    // Ждём, пока связь с сервисом установится
    async function waitClientPeer(limit) {
      const until = Date.now() + limit;
      startClientPeer();
      while (!closed && Date.now() < until) {
        const peer = clientPeer;
        if (peer && peer.open && !peer.disconnected && !peer.destroyed) return true;
        await sleep(150);
      }
      return false;
    }

    // ---------- Адрес комнаты ----------
    // Занять адрес комнаты может только один участник — он и становится организатором
    function claim(code) {
      return new Promise((resolve) => {
        let done = false;
        let peer = null;
        const finish = (result) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (result !== 'ok') destroyPeer(peer);
          resolve({ result, peer: result === 'ok' ? peer : null });
        };
        const timer = setTimeout(() => finish('error'), timing.signalOpen);
        try {
          peer = new PeerCtor(ROOM_PREFIX + code, peerOptions);
        } catch (e) {
          finish('error');
          return;
        }
        peer.on('open', () => finish('ok'));
        peer.on('error', (err) => finish(err && err.type === 'unavailable-id' ? 'taken' : 'error'));
      });
    }

    // ---------- Организатор ----------
    const out = {
      all(event, data) {
        emitLocal(event, data);
        broadcast({ t: 'ev', n: event, p: data });
      },
      others(exceptId, event, data) {
        if (exceptId !== me.id) emitLocal(event, data);
        broadcast({ t: 'ev', n: event, p: data }, exceptId);
      },
      to(id, event, data) {
        if (id === me.id) { emitLocal(event, data); return; }
        const link = members.get(id);
        if (link) send(link.conn, { t: 'ev', n: event, p: data });
      },
      changed() {
        if (repScheduled) return;
        repScheduled = true;
        Promise.resolve().then(() => {
          repScheduled = false;
          if (role === 'hub' && core) broadcast({ t: 'rep', rep: core.replica() });
        });
      }
    };
    function broadcast(message, exceptId) {
      members.forEach((link, id) => { if (id !== exceptId) send(link.conn, message); });
    }

    function becomeHub(peer, code, fromReplica) {
      epoch += 1;
      role = 'hub';
      hubPeer = peer;
      stopMember();
      stopClientPeer();
      core = new RoomCore(code, out, timing);

      let retry = 0;
      let retryTimer = null;
      peer.on('connection', (conn) => { if (hubPeer === peer) onMemberConnection(conn); else closeConn(conn); });
      peer.on('open', () => { retry = 0; });
      peer.on('error', (err) => {
        // Пока не было связи, адрес комнаты занял другой участник — уступаем ему
        if (hubPeer === peer && err && err.type === 'unavailable-id') demote();
      });
      peer.on('disconnected', () => {
        if (hubPeer !== peer) return;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          if (hubPeer !== peer || peer.destroyed) return;
          try { peer.reconnect(); } catch (e) { /* повторим при следующем событии */ }
        }, retryDelay(retry++));
      });
      peer.on('close', () => { if (hubPeer === peer) demote(); });

      clearInterval(repTimer);
      repTimer = setInterval(() => {
        if (role !== 'hub' || !core) return;
        broadcast({ t: 'rep', rep: core.replica() });
        const now = Date.now();
        members.forEach((link) => { if (!link.down && now - link.lastSeen > timing.memberSilence) closeConn(link.conn); });
      }, timing.rep);

      if (fromReplica) {
        // Продолжаем комнату: я уже в ней был, прежнего организатора больше нет
        const previousHost = fromReplica.hostId;
        core.adopt(fromReplica, history);
        fromReplica.users.forEach((u) => {
          if (u.id !== previousHost || u.id === me.id) core.users.set(u.id, { id: u.id, name: u.name, color: u.color, rank: u.rank });
        });
        const mine = core.users.get(me.id) || { id: me.id, rank: (core.rankSeq += 1) };
        core.users.set(me.id, { id: me.id, name: me.name, color: me.color, rank: mine.rank });
        core.hostId = me.id;
        core.ver += 1;
        core.users.forEach((u) => {
          if (u.id === me.id) return;
          pendingReturn.set(u.id, setTimeout(() => {
            pendingReturn.delete(u.id);
            if (role === 'hub' && core && !members.has(u.id)) core.removeUser(u.id);
          }, timing.returnGrace));
        });
        const gone = fromReplica.users.find((u) => u.id === previousHost && u.id !== me.id);
        emitLocal('users_update', core.snapshot());
        if (gone) emitLocal('system_message', { text: `${gone.name} покинул комнату`, time: Date.now() });
        notice('Организатор вышел — теперь комнату ведёте вы');
      } else {
        core.addUser(me.id, me.name, me.color);
        core.hostId = me.id;
        emitLocal('room_created', core.snapshot());
        core.announceJoin(me.id, true);
      }
      refreshOnline();
    }

    function teardownHub() {
      clearInterval(repTimer);
      repTimer = null;
      members.forEach((link) => { clearTimeout(link.graceTimer); link.replaced = true; closeConn(link.conn); });
      members.clear();
      pendingReturn.forEach((timer) => clearTimeout(timer));
      pendingReturn.clear();
      const peer = hubPeer;
      hubPeer = null;
      core = null;
      destroyPeer(peer);
    }

    // Адрес комнаты достался другому участнику (или пропал) — возвращаемся обычным участником
    function demote() {
      if (role !== 'hub' || !core) return;
      replica = cleanReplica(core.replica());
      replicaAt = Date.now();
      history = core.messages.slice();
      teardownHub();
      epoch += 1;
      role = 'recovering';
      refreshOnline();
      notice('Связь прервалась. Возвращаемся в комнату…');
      recover();
    }

    function onMemberConnection(conn) {
      const link = { conn, id: null, lastSeen: Date.now(), parts: null, graceTimer: null, down: false, replaced: false, count: 0, countAt: Date.now() };
      const helloTimer = setTimeout(() => { if (!link.id) closeConn(conn); }, timing.welcome + 4000);
      conn.on('data', (raw) => {
        if (role !== 'hub' || !core) return;
        // защита от потока сообщений: лишнее пропускаем, при явном злоупотреблении закрываем соединение
        const now = Date.now();
        if (now - link.countAt > 2000) { link.countAt = now; link.count = 0; }
        link.count += 1;
        if (link.count > 800) { closeConn(conn); return; }
        if (link.count > 200) return;
        const message = unpack(link, raw);
        if (!message) return;
        stats.received += 1;
        link.lastSeen = now;
        if (message.t === 'hello') {
          clearTimeout(helloTimer);
          if (!link.id) onHello(link, message);
          return;
        }
        if (!link.id || members.get(link.id) !== link) return;
        switch (message.t) {
          case 'ev':
            if (typeof message.n === 'string') core.handle(link.id, message.n, message.p);
            break;
          case 'ping':
            send(conn, { t: 'pong' });
            break;
          case 'bye':
            link.replaced = true;
            members.delete(link.id);
            core.removeUser(link.id);
            closeConn(conn);
            break;
          case 'state': {
            // участник прислал более свежее состояние (я стал организатором с отставшей копией)
            const fresh = cleanReplica(message.rep);
            if (fresh.ver > core.ver) {
              const hadVideo = core.video && core.video.url;
              core.adopt(fresh, cleanMessages(message.messages));
              core.touch();
              if ((fresh.video && fresh.video.url) !== hadVideo && core.video) out.all('video_changed', { video: core.video, state: core.snapshot() });
              out.all('queue_update', core.queue);
              out.all('sync_state', core.snapshot());
            }
            break;
          }
          default:
        }
      });
      const down = () => {
        clearTimeout(helloTimer);
        if (!link.id || link.replaced || link.down || members.get(link.id) !== link) return;
        link.down = true;
        link.graceTimer = setTimeout(() => {
          if (members.get(link.id) !== link) return; // участник успел вернуться
          members.delete(link.id);
          if (role === 'hub' && core) core.removeUser(link.id);
        }, timing.memberGrace);
      };
      conn.on('close', down);
      conn.on('error', down);
    }

    async function onHello(link, message) {
      const startedEpoch = epoch;
      const secret = typeof message.secret === 'string' ? message.secret.slice(0, 80) : '';
      if (secret.length < 16) { closeConn(link.conn); return; }
      const id = await publicId(secret);
      if (epoch !== startedEpoch || role !== 'hub' || !core || !link.conn.open || link.id) return;
      if (id === me.id) { closeConn(link.conn); return; }
      const known = core.users.has(id);
      if (!known && core.users.size >= MAX_MEMBERS) {
        send(link.conn, { t: 'reject', message: 'В комнате уже максимальное число участников' });
        setTimeout(() => closeConn(link.conn), 400);
        return;
      }
      const previous = members.get(id);
      if (previous) {
        previous.replaced = true;
        clearTimeout(previous.graceTimer);
        closeConn(previous.conn);
      }
      clearTimeout(pendingReturn.get(id));
      pendingReturn.delete(id);
      link.id = id;
      members.set(id, link);
      const name = cleanName(message.name);
      const color = cleanColor(message.color);
      if (!known) core.addUser(id, name, color);
      send(link.conn, { t: 'welcome', you: id, state: core.snapshot(), rep: core.replica() });
      if (!known) core.announceJoin(id, false);
      else core.updateUser(id, name, color);
      const theirVer = finiteNum(message.ver);
      if (theirVer !== null && theirVer > core.ver) send(link.conn, { t: 'need_state' });
    }

    // ---------- Участник ----------
    // Соединение с организатором. Результат: { ok, link, welcome } или { ok: false, reason, message }
    function connectToHub(code, resume, limit) {
      return new Promise((resolve) => {
        const peer = clientPeer;
        const target = ROOM_PREFIX + code;
        if (!peer || peer.destroyed || peer.disconnected || !peer.open) { resolve({ ok: false, reason: 'no-signal' }); return; }
        const link = { conn: null, parts: null, joined: false, lost: false };
        let done = false;
        let timer = null;
        const finish = (result) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          peerUnavailable.delete(target);
          if (!result.ok) { link.lost = true; closeConn(link.conn); }
          resolve(result);
        };
        timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), limit);
        peerUnavailable.set(target, () => finish({ ok: false, reason: 'not-found' }));
        try {
          link.conn = peer.connect(target, { reliable: true, serialization: 'json' });
        } catch (e) {
          link.conn = null;
        }
        if (!link.conn) { finish({ ok: false, reason: 'no-signal' }); return; }
        link.conn.on('open', () => {
          if (done) return;
          send(link.conn, { t: 'hello', secret: me.secret, name: me.name, color: me.color, resume: !!resume, ver: replica ? replica.ver : 0 });
          clearTimeout(timer);
          timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timing.welcome);
        });
        link.conn.on('data', (raw) => {
          const message = unpack(link, raw);
          if (!message) return;
          stats.received += 1;
          if (link.joined) { onHubMessage(link, message); return; }
          if (message.t === 'welcome') finish({ ok: true, link, welcome: message });
          else if (message.t === 'reject') finish({ ok: false, reason: 'rejected', message: cleanText(message.message, 200) });
        });
        const down = () => {
          if (link.joined) onHubLost(link);
          else finish({ ok: false, reason: 'failed' });
        };
        link.conn.on('close', down);
        link.conn.on('error', down);
      });
    }

    // Вошли в комнату (или вернулись в неё): запоминаем состояние и следим за связью
    function enterMember(result) {
      epoch += 1;
      role = 'member';
      const link = result.link;
      link.joined = true;
      hubLink = link;
      me.id = cleanId(result.welcome.you) || me.id;
      const state = cleanState(result.welcome.state);
      const rep = cleanReplica(result.welcome.rep);
      if (!rep.code) rep.code = state.roomId;
      replica = rep;
      replicaAt = Date.now();
      lastHubSeen = Date.now();
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (role !== 'member' || hubLink !== link) return;
        if (Date.now() - lastHubSeen > timing.hubSilence) { onHubLost(link); return; }
        send(link.conn, { t: 'ping' });
      }, timing.ping);
      refreshOnline();
      return state;
    }
    function stopMember() {
      clearInterval(pingTimer);
      pingTimer = null;
      const link = hubLink;
      hubLink = null;
      if (link) { link.lost = true; closeConn(link.conn); }
    }

    function onHubMessage(link, message) {
      if (hubLink !== link || role !== 'member') return;
      lastHubSeen = Date.now();
      switch (message.t) {
        case 'ev': {
          if (typeof message.n !== 'string') return;
          const data = cleanEvent(message.n, message.p);
          if (data === null) return;
          if (message.n === 'chat_message') rememberMessage(data);
          emitLocal(message.n, data);
          return;
        }
        case 'rep': {
          const rep = cleanReplica(message.rep);
          if (rep.code && replica && rep.code === replica.code) { replica = rep; replicaAt = Date.now(); }
          return;
        }
        case 'need_state':
          send(link.conn, { t: 'state', rep: currentReplica(), messages: history });
          return;
        case 'hub_bye':
          onHubLost(link);
          return;
        default:
      }
    }
    function rememberMessage(message) {
      if (history.some((m) => m.id === message.id)) return;
      history.push(message);
      if (history.length > MAX_MESSAGES) history.shift();
    }
    // Копия состояния с позицией на текущий момент
    function currentReplica() {
      const rep = Object.assign({}, replica);
      if (rep.playing) rep.position += (Date.now() - replicaAt) / 1000;
      return rep;
    }

    function onHubLost(link) {
      if (hubLink !== link || role !== 'member') return;
      stopMember();
      epoch += 1;
      role = 'recovering';
      refreshOnline();
      notice('Связь с организатором потеряна. Восстанавливаем комнату…');
      recover();
    }

    // Возвращаемся в комнату: подключаемся к новому организатору или сами занимаем его место.
    // Очерёдность — по порядку входа в комнату, чтобы организатором стал один участник.
    async function recover() {
      const startedEpoch = epoch;
      const code = replica && replica.code;
      if (!code) return;
      const startedAt = Date.now();
      const order = replica.users.filter((u) => u.id !== replica.hostId || u.id === me.id).sort((a, b) => a.rank - b.rank);
      let turn = order.findIndex((u) => u.id === me.id);
      if (turn === -1 || replica.hostId === me.id) turn = order.length;
      let warned = false;
      while (!closed && epoch === startedEpoch && role === 'recovering') {
        if (lib === 'ready' && Date.now() - startedAt >= turn * timing.claimStagger) {
          const claimed = await claim(code);
          if (closed || epoch !== startedEpoch || role !== 'recovering') { destroyPeer(claimed.peer); return; }
          if (claimed.result === 'ok') {
            const rep = currentReplica();
            becomeHub(claimed.peer, code, rep);
            return;
          }
        }
        if (await waitClientPeer(4000)) {
          if (closed || epoch !== startedEpoch || role !== 'recovering') return;
          const joined = await connectToHub(code, true, timing.connectRecover);
          if (closed || epoch !== startedEpoch || role !== 'recovering') { if (joined.ok) closeConn(joined.link.conn); return; }
          if (joined.ok) {
            resumeMember(joined);
            return;
          }
          if (joined.reason === 'rejected') {
            emitLocal('app_error', { message: joined.message || 'Не удалось вернуться в комнату' });
          }
        }
        if (!warned && Date.now() - startedAt > 45000) {
          warned = true;
          notice('Комната пока не восстановилась. Проверьте интернет — мы продолжаем попытки');
        }
        await sleep(400 + Math.random() * 800);
      }
    }

    // Вернулись в комнату: показываем то, что изменилось за время отсутствия
    function resumeMember(result) {
      const hadVideo = replica && replica.video ? replica.video.url : null;
      const hadHost = replica ? replica.hostId : null;
      const known = new Set(history.map((m) => m.id));
      const state = enterMember(result);
      emitLocal('users_update', state);
      const host = state.users.find((u) => u.id === state.hostId);
      if (host && state.hostId !== hadHost) emitLocal('system_message', { text: `Комнату теперь ведёт ${host.name}`, time: Date.now() });
      emitLocal('queue_update', state.queue);
      state.messages.forEach((m) => {
        if (known.has(m.id)) return;
        rememberMessage(m);
        emitLocal('chat_message', m);
      });
      if (state.video && state.video.url !== hadVideo) {
        emitLocal('video_changed', { video: state.video });
        // плееру нужно время на загрузку — выравниваем позицию чуть позже
        const startedEpoch = epoch;
        [1500, 4000].forEach((delay) => setTimeout(() => {
          if (epoch === startedEpoch && role === 'member' && hubLink) send(hubLink.conn, { t: 'ev', n: 'sync_request' });
        }, delay));
      } else {
        emitLocal('sync_state', state);
      }
      notice('Связь восстановлена');
    }

    // ---------- Создание комнаты и вход ----------
    async function createRoom(payload) {
      if (busy || role !== 'idle' || closed) return;
      busy = true;
      try {
        me.name = cleanName(payload && payload.name);
        me.color = cleanColor(payload && payload.color);
        await myIdReady;
        if (lib !== 'ready') { emitLocal('app_error', { message: 'Соединение ещё не готово. Подождите несколько секунд и попробуйте ещё раз' }); return; }
        for (let attempt = 0; attempt < 5; attempt++) {
          const code = genCode();
          const claimed = await claim(code);
          if (closed) { destroyPeer(claimed.peer); return; }
          if (claimed.result === 'ok') { becomeHub(claimed.peer, code, null); return; }
          if (claimed.result === 'error') break; // «занято» — пробуем другой код, ошибка связи — выходим
        }
        emitLocal('app_error', { message: 'Не удалось создать комнату: нет связи с сервисом соединений. Проверьте интернет и попробуйте ещё раз' });
      } finally {
        busy = false;
      }
    }

    async function joinRoom(payload) {
      if (busy || role !== 'idle' || closed) return;
      busy = true;
      try {
        const code = cleanCode(payload && payload.roomId);
        if (!code) { emitLocal('app_error', { message: 'Комната не найдена. Проверьте код и попробуйте ещё раз.' }); return; }
        me.name = cleanName(payload && payload.name);
        me.color = cleanColor(payload && payload.color);
        const until = Date.now() + timing.joinSearch;
        let reason = 'no-signal';
        do {
          if (!(await waitClientPeer(timing.signalOpen))) { reason = 'no-signal'; break; }
          const joined = await connectToHub(code, false, timing.connect);
          if (closed) return;
          if (joined.ok) {
            history = [];
            const state = enterMember(joined);
            history = state.messages.slice();
            emitLocal('room_joined', state);
            return;
          }
          reason = joined.reason;
          if (reason === 'rejected') { emitLocal('app_error', { message: joined.message || 'Не удалось войти в комнату' }); return; }
          // организатор мог как раз смениться — пробуем ещё немного
          await sleep(700);
        } while (Date.now() < until);
        const text = {
          'no-signal': 'Нет связи с сервисом соединений. Проверьте интернет и попробуйте ещё раз',
          'timeout': 'Комната найдена, но соединиться с её организатором не удалось. Попробуйте ещё раз или подключитесь через другую сеть',
          'failed': 'Комната найдена, но соединиться с её организатором не удалось. Попробуйте ещё раз или подключитесь через другую сеть'
        }[reason] || 'Комната не найдена. Проверьте код: комната существует, пока в ней есть хотя бы один участник.';
        emitLocal('app_error', { message: text });
      } finally {
        busy = false;
      }
    }

    // ---------- Выход ----------
    function leave() {
      if (closed) return;
      closed = true;
      epoch += 1;
      try {
        if (role === 'member' && hubLink) send(hubLink.conn, { t: 'bye' });
        if (role === 'hub') broadcast({ t: 'hub_bye' });
      } catch (e) { /* страница закрывается */ }
      clearInterval(pingTimer);
      clearInterval(repTimer);
      clearTimeout(clientTimer);
      destroyPeer(hubPeer);
      destroyPeer(clientPeer);
      online = false;
    }
    if (global.addEventListener) {
      global.addEventListener('pagehide', leave);
      // страницу вернули кнопкой «Назад» из памяти браузера — соединения уже закрыты, начинаем заново
      global.addEventListener('pageshow', (event) => { if (event.persisted && closed) global.location.reload(); });
    }

    // ---------- Загрузка библиотеки PeerJS ----------
    function loadLibrary() {
      if (typeof global.Peer === 'function') return Promise.resolve();
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = libUrl;
        script.async = true;
        script.onload = () => (typeof global.Peer === 'function' ? resolve() : reject(new Error('PeerJS не загрузился')));
        script.onerror = () => reject(new Error('Не найден файл ' + libUrl));
        document.head.appendChild(script);
      });
    }
    function start() {
      if (typeof global.RTCPeerConnection !== 'function' || typeof global.WebSocket !== 'function') {
        lib = 'unsupported';
        reportError('unsupported', 'WebRTC недоступен');
        return;
      }
      loadLibrary().then(() => {
        if (closed) return;
        PeerCtor = global.Peer;
        lib = 'ready';
        startClientPeer();
      }).catch((err) => {
        lib = 'failed';
        reportError('lib', err && err.message);
      });
    }
    // даём app.js подписаться на события до первых сообщений
    setTimeout(start, 0);

    // ---------- То, что видит app.js ----------
    const ROOM_EVENTS = ['set_video', 'play', 'pause', 'seek', 'sync_request', 'chat_message', 'reaction', 'queue_add', 'queue_remove', 'queue_next'];
    return {
      mode: 'p2p',
      get connected() { return isConnected(); },
      get id() { return me.id; },
      on(event, fn) {
        (handlers[event] || (handlers[event] = [])).push(fn);
        return this;
      },
      off(event, fn) {
        handlers[event] = (handlers[event] || []).filter((item) => item !== fn);
        return this;
      },
      emit(event, payload) {
        if (closed) return this;
        if (event === 'create_room') { createRoom(payload); return this; }
        if (event === 'join_room') { joinRoom(payload); return this; }
        if (!ROOM_EVENTS.includes(event)) return this;
        if (role === 'hub' && core) core.handle(me.id, event, payload);
        else if (role === 'member' && hubLink) send(hubLink.conn, { t: 'ev', n: event, p: payload });
        return this;
      },
      disconnect() { leave(); return this; },
      // для страницы проверки связи и для отладки
      info() {
        return {
          lib,
          role,
          room: role === 'hub' && core ? core.code : (replica && role !== 'idle' ? replica.code : null),
          connected: isConnected(),
          members: role === 'hub' ? members.size : null,
          sent: stats.sent,
          received: stats.received,
          error: lastError
        };
      }
    };
  }

  global.SyncP2P = { createSocket, ROOM_PREFIX };
})(window);
