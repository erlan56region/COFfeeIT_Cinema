'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = ROOT; // статические файлы сайта раздаются из корня ветки (GitHub Pages)
const DATA_DIR = path.join(ROOT, '.data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');

const ROOM_TTL = 24 * 60 * 60 * 1000; // комнаты живут сутки с последней активности
const MAX_USERS = 60;
const MAX_MESSAGES = 150;
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const COLORS = [
  'sunset', 'amber', 'mint', 'ocean', 'violet', 'rose', 'lime', 'sky',
];

/* ------------------------------------------------------------------ */
/* Хранилище комнат                                                    */
/* ------------------------------------------------------------------ */

/** @type {Map<string, any>} */
const rooms = new Map();

function makeId(len = 6) {
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return out;
}

function uniqueRoomId() {
  let id = makeId();
  let guard = 0;
  while (rooms.has(id) && guard < 50) {
    id = makeId();
    guard += 1;
  }
  return id;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeUrl(value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim().slice(0, 2000);
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.href;
  } catch {
    return '';
  }
}

function normalizeSource(input) {
  if (!input || typeof input !== 'object') return null;
  const url = safeUrl(input.url);
  if (!url) return null;
  const kind = cleanText(input.kind, 24) || 'link';
  const title = cleanText(input.title, 140);
  return { url, kind, title };
}

function createRoom({ title = '', source = null } = {}) {
  const now = Date.now();
  const room = {
    id: uniqueRoomId(),
    title: cleanText(title, 80) || 'Кинорум',
    source: normalizeSource(source),
    mode: 'host', // host | all
    hostId: null,
    playback: { playing: false, time: 0, updatedAt: now, by: '' },
    users: new Map(),
    messages: [],
    createdAt: now,
    lastActive: now,
  };
  rooms.set(room.id, room);
  schedulePersist();
  return room;
}

function addSystemMessage(room, text) {
  const message = {
    id: makeId(10),
    system: true,
    text: cleanText(text, 240),
    ts: Date.now(),
  };
  room.messages.push(message);
  if (room.messages.length > MAX_MESSAGES) room.messages.shift();
  return message;
}

function onlineUsers(room) {
  return [...room.users.values()]
    .filter((user) => user.online)
    .map((user) => ({ id: user.id, name: user.name, color: user.color, isHost: user.id === room.hostId }));
}

function serializeUsers(room) {
  return [...room.users.values()]
    .sort((a, b) => {
      if (a.id === room.hostId) return -1;
      if (b.id === room.hostId) return 1;
      return a.joinedAt - b.joinedAt;
    })
    .map((user) => ({
      id: user.id,
      name: user.name,
      color: user.color,
      online: Boolean(user.online),
      isHost: user.id === room.hostId,
    }));
}

function playbackSnapshot(room) {
  const { playing, time, updatedAt } = room.playback;
  const now = Date.now();
  return {
    playing,
    time: playing ? Math.max(0, time + (now - updatedAt) / 1000) : Math.max(0, time),
    serverNow: now,
    by: room.playback.by,
  };
}

function roomState(room) {
  return {
    room: {
      id: room.id,
      title: room.title,
      mode: room.mode,
      hostId: room.hostId,
      source: room.source,
      createdAt: room.createdAt,
    },
    playback: playbackSnapshot(room),
    users: serializeUsers(room),
    messages: room.messages.slice(-100),
    serverNow: Date.now(),
  };
}

function publicRoomInfo(room) {
  return {
    id: room.id,
    title: room.title,
    source: room.source,
    mode: room.mode,
    online: onlineUsers(room).length,
    total: room.users.size,
    createdAt: room.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* Персистентность (переживает перезапуск сервера)                     */
/* ------------------------------------------------------------------ */

let persistTimer = null;

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistRooms();
  }, 700);
}

function persistRooms() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = [...rooms.values()].map((room) => ({
      ...room,
      users: [...room.users.values()].map((user) => ({ ...user, online: false })),
    }));
    fs.writeFileSync(DATA_FILE, JSON.stringify({ savedAt: Date.now(), rooms: payload }));
  } catch (error) {
    console.error('[cinema] не удалось сохранить комнаты:', error.message);
  }
}

function loadRooms() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!data || !Array.isArray(data.rooms)) return;
    const now = Date.now();
    for (const raw of data.rooms) {
      if (!raw || typeof raw.id !== 'string' || !/^[a-z0-9]{6}$/.test(raw.id)) continue;
      if (now - (raw.lastActive || raw.createdAt || 0) > ROOM_TTL) continue;
      const users = new Map();
      if (Array.isArray(raw.users)) {
        for (const user of raw.users) {
          if (!user || typeof user.id !== 'string') continue;
          users.set(user.id, {
            id: user.id,
            name: cleanText(user.name, 32) || 'Гость',
            color: COLORS.includes(user.color) ? user.color : 'amber',
            online: false,
            joinedAt: Number(user.joinedAt) || now,
          });
        }
      }
      rooms.set(raw.id, {
        id: raw.id,
        title: cleanText(raw.title, 80) || 'Кинорум',
        source: normalizeSource(raw.source),
        mode: raw.mode === 'all' ? 'all' : 'host',
        hostId: typeof raw.hostId === 'string' ? raw.hostId : null,
        playback: {
          playing: false,
          time: Math.max(0, Number(raw.playback && raw.playback.time) || 0),
          updatedAt: now,
          by: '',
        },
        users,
        messages: Array.isArray(raw.messages)
          ? raw.messages.filter((m) => m && typeof m.text === 'string').slice(-MAX_MESSAGES)
          : [],
        createdAt: Number(raw.createdAt) || now,
        lastActive: now,
      });
    }
  } catch (error) {
    console.error('[cinema] не удалось загрузить комнаты:', error.message);
  }
}

loadRooms();

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 1e6,
});

app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(express.json({ limit: '64kb' }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) });
});

app.post('/api/rooms', (req, res) => {
  const body = req.body || {};
  const source = normalizeSource(body.source);
  const title = cleanText(body.title, 80) || (source && source.title) || 'Кинорум';
  const room = createRoom({ title, source });
  res.status(201).json(publicRoomInfo(room));
});

app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(String(req.params.id).toLowerCase());
  if (!room) return res.status(404).json({ error: 'room_not_found' });
  res.json(publicRoomInfo(room));
});

app.get('/r/:id', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'room.html'));
});

app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    setHeaders(res, filePath) {
      if (/[\\/]vendor[\\/]/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      } else if (/\.(css|js|woff2|svg|jpg|jpeg|png|webp)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=300');
      }
    },
  })
);

app.use((req, res) => {
  if (req.accepts('html')) {
    res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
  } else {
    res.status(404).json({ error: 'not_found' });
  }
});

/* ------------------------------------------------------------------ */
/* Socket.IO                                                           */
/* ------------------------------------------------------------------ */

function emitError(socket, message) {
  socket.emit('notice', { type: 'error', text: message });
}

function getRoomForSocket(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return null;
  const room = rooms.get(roomId);
  if (!room) return null;
  return room;
}

function broadcastPresence(room) {
  io.to(room.id).emit('presence', {
    users: serializeUsers(room),
    hostId: room.hostId,
    mode: room.mode,
  });
}

function broadcastChat(room, message) {
  io.to(room.id).emit('chat', message);
}

function pushChat(room, message) {
  room.messages.push(message);
  if (room.messages.length > MAX_MESSAGES) room.messages.shift();
  broadcastChat(room, message);
}

function canControl(room, uid) {
  return room.mode === 'all' || room.hostId === uid;
}

function rateLimiter(socket, key, max, windowMs) {
  if (!socket.data.limits) socket.data.limits = {};
  const now = Date.now();
  const entry = socket.data.limits[key];
  if (!entry || now - entry.start > windowMs) {
    socket.data.limits[key] = { start: now, count: 1 };
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}

io.on('connection', (socket) => {
  socket.on('room:join', (payload = {}, ack) => {
    try {
      const roomId = String(payload.roomId || '').toLowerCase();
      if (!/^[a-z0-9]{6}$/.test(roomId)) return emitError(socket, 'Некорректный код комнаты.');

      const room = rooms.get(roomId);
      if (!room) {
        if (typeof ack === 'function') ack({ ok: false, error: 'room_not_found' });
        return;
      }

      if (socket.data.roomId && socket.data.roomId !== roomId) {
        socket.leave(socket.data.roomId);
      }

      const rawUser = payload.user || {};
      const uid = cleanText(rawUser.id, 40) || socket.id;
      const name = cleanText(rawUser.name, 32) || 'Гость';
      const color = COLORS.includes(rawUser.color) ? rawUser.color : COLORS[0];

      let user = room.users.get(uid);
      const isNew = !user;
      if (!user) {
        if (room.users.size >= MAX_USERS) {
          if (typeof ack === 'function') ack({ ok: false, error: 'room_full' });
          return;
        }
        user = { id: uid, name, color, online: true, joinedAt: Date.now() };
        room.users.set(uid, user);
      } else {
        user.name = name;
        user.color = color;
        user.online = true;
      }

      if (!room.hostId || !room.users.has(room.hostId)) {
        room.hostId = uid;
      }

      socket.data.roomId = roomId;
      socket.data.uid = uid;
      socket.join(roomId);
      room.lastActive = Date.now();

      if (isNew) {
        addSystemMessage(room, `${name} подключился к просмотру`);
      }

      socket.emit('room:state', roomState(room));
      broadcastPresence(room);
      if (isNew) {
        broadcastChat(room, room.messages[room.messages.length - 1]);
      }
      schedulePersist();
      if (typeof ack === 'function') ack({ ok: true, roomId });
    } catch (error) {
      console.error('[cinema] join error:', error);
      emitError(socket, 'Не удалось войти в комнату.');
    }
  });

  socket.on('source:set', (payload = {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const uid = socket.data.uid;
    if (!canControl(room, uid)) return emitError(socket, 'Сейчас видео меняет только хост.');

    const source = normalizeSource(payload.source);
    if (!source) return emitError(socket, 'Не похоже на ссылку на видео.');
    const title = cleanText(payload.title, 80);

    room.source = source;
    if (title) room.title = title;
    room.playback = { playing: false, time: 0, updatedAt: Date.now(), by: '' };
    room.lastActive = Date.now();

    io.to(room.id).emit('source', { room: { ...roomState(room).room } });
    const author = room.users.get(uid);
    addSystemMessage(room, `${author ? author.name : 'Хост'} включил новое видео${source.title ? `: ${source.title}` : ''}`);
    broadcastChat(room, room.messages[room.messages.length - 1]);
    schedulePersist();
  });

  socket.on('playback:play', (payload = {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const uid = socket.data.uid;
    if (!canControl(room, uid)) {
      return socket.emit('playback', playbackSnapshot(room));
    }
    const time = Math.max(0, Number(payload.time) || 0);
    const user = room.users.get(uid);
    room.playback = { playing: true, time, updatedAt: Date.now(), by: user ? user.name : '' };
    room.lastActive = Date.now();
    io.to(room.id).emit('playback', playbackSnapshot(room));
    schedulePersist();
  });

  socket.on('playback:pause', (payload = {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const uid = socket.data.uid;
    if (!canControl(room, uid)) {
      return socket.emit('playback', playbackSnapshot(room));
    }
    const time = Math.max(0, Number(payload.time) || 0);
    const user = room.users.get(uid);
    room.playback = { playing: false, time, updatedAt: Date.now(), by: user ? user.name : '' };
    room.lastActive = Date.now();
    io.to(room.id).emit('playback', playbackSnapshot(room));
    schedulePersist();
  });

  socket.on('playback:seek', (payload = {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const uid = socket.data.uid;
    if (!canControl(room, uid)) {
      return socket.emit('playback', playbackSnapshot(room));
    }
    const time = Math.max(0, Number(payload.time) || 0);
    room.playback = {
      playing: Boolean(payload.playing),
      time,
      updatedAt: Date.now(),
      by: room.playback.by,
    };
    room.lastActive = Date.now();
    io.to(room.id).emit('playback', playbackSnapshot(room));
    schedulePersist();
  });

  socket.on('sync:request', () => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    socket.emit('playback', playbackSnapshot(room));
    socket.emit('presence', { users: serializeUsers(room), hostId: room.hostId, mode: room.mode });
  });

  socket.on('room:mode', (payload = {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    if (room.hostId !== socket.data.uid) return emitError(socket, 'Менять режим может только хост.');
    room.mode = payload.mode === 'all' ? 'all' : 'host';
    io.to(room.id).emit('room:meta', { mode: room.mode, hostId: room.hostId, title: room.title });
    broadcastPresence(room);
    const text =
      room.mode === 'all'
        ? 'Теперь управлять просмотром может каждый'
        : 'Управление просмотром вернулось хосту';
    addSystemMessage(room, text);
    broadcastChat(room, room.messages[room.messages.length - 1]);
    schedulePersist();
  });

  socket.on('room:rename', (payload = {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    if (room.hostId !== socket.data.uid) return emitError(socket, 'Переименовать комнату может только хост.');
    const title = cleanText(payload.title, 80);
    if (!title) return emitError(socket, 'Название не может быть пустым.');
    room.title = title;
    io.to(room.id).emit('room:meta', { mode: room.mode, hostId: room.hostId, title: room.title });
    schedulePersist();
  });

  socket.on('room:host', (payload = {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    if (room.hostId !== socket.data.uid) return emitError(socket, 'Передать права может только хост.');
    const target = room.users.get(cleanText(payload.uid, 40));
    if (!target) return emitError(socket, 'Такого участника нет в комнате.');
    room.hostId = target.id;
    broadcastPresence(room);
    io.to(room.id).emit('room:meta', { mode: room.mode, hostId: room.hostId, title: room.title });
    addSystemMessage(room, `${target.name} теперь хост комнаты`);
    broadcastChat(room, room.messages[room.messages.length - 1]);
    schedulePersist();
  });

  socket.on('chat:send', (payload = {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    if (!rateLimiter(socket, 'chat', 6, 3000)) {
      return emitError(socket, 'Полегче: слишком много сообщений подряд.');
    }
    const text = cleanText(payload.text, 600);
    if (!text) return;
    const user = room.users.get(socket.data.uid);
    if (!user) return;
    const message = {
      id: makeId(10),
      userId: user.id,
      name: user.name,
      color: user.color,
      text,
      ts: Date.now(),
    };
    room.lastActive = Date.now();
    pushChat(room, message);
    schedulePersist();
  });

  socket.on('chat:typing', (payload = {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const user = room.users.get(socket.data.uid);
    if (!user) return;
    socket.to(room.id).emit('typing', { name: user.name, active: Boolean(payload.active) });
  });

  socket.on('reaction', (payload = {}) => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    if (!rateLimiter(socket, 'reaction', 8, 4000)) return;
    const emoji = cleanText(payload.emoji, 8);
    if (!emoji) return;
    const user = room.users.get(socket.data.uid);
    if (!user) return;
    io.to(room.id).emit('reaction', {
      id: makeId(8),
      emoji,
      name: user.name,
      color: user.color,
      x: 10 + Math.random() * 80,
    });
  });

  socket.on('ping:clock', (payload = {}, ack) => {
    if (typeof ack === 'function') {
      ack({ client: payload.t, serverNow: Date.now() });
    }
  });

  socket.on('disconnect', () => {
    const room = getRoomForSocket(socket);
    if (!room) return;
    const uid = socket.data.uid;
    const stillHere = [...io.sockets.sockets.values()].some(
      (s) => s.data.roomId === room.id && s.data.uid === uid
    );
    if (stillHere) return;

    const user = room.users.get(uid);
    if (user) {
      user.online = false;
      addSystemMessage(room, `${user.name} вышел из комнаты`);
      broadcastChat(room, room.messages[room.messages.length - 1]);
    }

    if (room.hostId === uid) {
      const nextHost = onlineUsers(room)[0];
      if (nextHost) {
        room.hostId = nextHost.id;
        io.to(room.id).emit('room:meta', { mode: room.mode, hostId: room.hostId, title: room.title });
        addSystemMessage(room, `${nextHost.name} теперь хост комнаты`);
        broadcastChat(room, room.messages[room.messages.length - 1]);
      }
    }

    broadcastPresence(room);
    schedulePersist();
  });
});

/* Общий «пульс» — мягко выравнивает дрейф у зрителей */
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.playback.playing) continue;
    if (onlineUsers(room).length < 2) continue;
    io.to(room.id).emit('tick', playbackSnapshot(room));
  }
}, 4000).unref();

/* Уборка старых комнат */
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, room] of rooms) {
    if (now - room.lastActive > ROOM_TTL) {
      rooms.delete(id);
      changed = true;
    }
  }
  if (changed) schedulePersist();
}, 30 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`COFfeeIT Cinema → http://${HOST}:${PORT} (комнат в памяти: ${rooms.size})`);
});

function shutdown() {
  persistRooms();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
