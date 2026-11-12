const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e5
});

// Файлы сайта лежат в корне проекта — оттуда же их раздаёт GitHub Pages.
// Сервер отдаёт только их: server.js, package.json и прочее наружу не попадает.
const SITE_FILES = ['index.html', 'style.css', 'app.js', 'p2p.js'];
const SITE_DIRS = ['images', 'vendor'];

// Сайт, открытый с самого сервера, подключается к нему же — что бы ни было записано
// в файле config.js. Тот файл нужен, когда сайт раздаётся отдельно от сервера (GitHub Pages).
app.get('/config.js', (req, res) => {
  res.type('application/javascript').send('window.SYNCWATCH_SERVER = window.location.origin;\n');
});
SITE_FILES.forEach((file) => {
  app.get(`/${file}`, (req, res) => res.sendFile(path.join(__dirname, file)));
});
SITE_DIRS.forEach((dir) => {
  app.use(`/${dir}`, express.static(path.join(__dirname, dir)));
});
app.use(express.json());

// Хранилище комнат: roomId -> room
const rooms = new Map();

// Допустимые типы реакций (ключи иконок на клиенте)
const REACTION_KEYS = ['heart', 'fire', 'laugh', 'wow', 'clap', 'sad', 'party'];
// link — ссылка на страницу другого сайта: в комнате её видят все, открывает каждый в своём браузере
const VIDEO_TYPES = ['youtube', 'vimeo', 'direct', 'link'];

// Разрешены только настоящие адреса http/https
function safeUrl(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim().slice(0, 2000);
  if (!/^https?:\/\//i.test(url) || /[\u0000-\u001f\u007f]/.test(url)) return null;
  try {
    const host = new URL(url).hostname;
    // знак % в имени сайта остаётся только от недопустимых символов, например от пробела
    if (!host || host.includes('%')) return null;
  } catch (e) {
    return null;
  }
  return url;
}

// Название ссылки на сайт — её домен. Берётся из самого адреса, а не из присланного названия:
// участники должны видеть, куда на самом деле ведёт ссылка
function siteName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || 'Сайт';
  } catch (e) {
    return 'Сайт';
  }
}

// Название видео или ссылки, которое показывается участникам
function videoTitle(type, url, title) {
  return type === 'link' ? siteName(url) : String(title || 'Видео').slice(0, 200);
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function getRoomState(room) {
  if (!room) return null;
  let position = room.position || 0;
  if (room.playing && room.startedAt) {
    position = room.position + (Date.now() - room.startedAt) / 1000;
  }
  return {
    roomId: room.id,
    users: Array.from(room.users.values()).map((u) => ({ id: u.id, name: u.name, color: u.color })),
    hostId: room.hostId,
    video: room.video, // { url, type, title, addedBy, addedByName }
    queue: room.queue,
    playing: room.playing,
    position: Math.max(0, position),
    startedAt: room.startedAt,
    messages: room.messages
  };
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let userName = 'Гость';
  let userColor = '#4f46e5';

  function room() {
    return currentRoom ? rooms.get(currentRoom) : null;
  }

  // Создание комнаты
  socket.on('create_room', (payload) => {
    const data = payload || {};
    userName = String(data.name || 'Гость').trim().slice(0, 24) || 'Гость';
    userColor = typeof data.color === 'string' ? data.color.slice(0, 20) : userColor;

    let roomId = genRoomId();
    while (rooms.has(roomId)) roomId = genRoomId();

    const newRoom = {
      id: roomId,
      users: new Map(),
      hostId: socket.id,
      video: null,
      queue: [],
      playing: false,
      position: 0,
      startedAt: null,
      messages: []
    };
    newRoom.users.set(socket.id, { id: socket.id, name: userName, color: userColor });
    rooms.set(roomId, newRoom);
    currentRoom = roomId;
    socket.join(roomId);

    socket.emit('room_created', getRoomState(newRoom));
    io.to(roomId).emit('users_update', getRoomState(newRoom));
    io.to(roomId).emit('system_message', { text: `${userName} создал комнату`, time: Date.now() });
  });

  // Вход в комнату
  socket.on('join_room', (payload) => {
    const data = payload || {};
    const roomId = String(data.roomId || '').toUpperCase().trim();
    const target = rooms.get(roomId);
    if (!target) {
      socket.emit('app_error', { message: 'Комната не найдена. Проверьте код и попробуйте ещё раз.' });
      return;
    }
    userName = String(data.name || 'Гость').trim().slice(0, 24) || 'Гость';
    userColor = typeof data.color === 'string' ? data.color.slice(0, 20) : userColor;

    // Если сокет уже был в другой комнате — аккуратно выходим из неё
    if (currentRoom && currentRoom !== roomId) {
      const previous = rooms.get(currentRoom);
      if (previous) {
        previous.users.delete(socket.id);
        socket.leave(currentRoom);
      }
    }

    target.users.set(socket.id, { id: socket.id, name: userName, color: userColor });
    currentRoom = roomId;
    socket.join(roomId);

    socket.emit('room_joined', getRoomState(target));
    io.to(roomId).emit('users_update', getRoomState(target));
    io.to(roomId).emit('system_message', { text: `${userName} подключился к комнате`, time: Date.now() });
  });

  // Установка видео
  socket.on('set_video', (payload) => {
    const target = room();
    if (!target) return;
    const data = payload || {};
    const url = safeUrl(data.url);
    if (!url) {
      socket.emit('app_error', { message: 'Некорректная ссылка. Нужна ссылка, начинающаяся с http:// или https://' });
      return;
    }
    const type = VIDEO_TYPES.includes(data.type) ? data.type : 'direct';
    const title = videoTitle(type, url, data.title);

    target.video = { url, type, title, addedBy: socket.id, addedByName: userName };
    target.playing = false;
    target.position = 0;
    target.startedAt = null;

    io.to(currentRoom).emit('video_changed', { video: target.video, state: getRoomState(target) });
    io.to(currentRoom).emit('system_message', { text: type === 'link' ? `${userName} поделился ссылкой на сайт` : `${userName} добавил видео: ${title}`, time: Date.now() });
  });

  // Play
  socket.on('play', (payload) => {
    const target = room();
    if (!target) return;
    const time = toFiniteNumber(payload && payload.time);
    target.playing = true;
    target.position = time !== null ? time : target.position;
    target.startedAt = Date.now();
    socket.to(currentRoom).emit('remote_play', { time: target.position, by: userName });
  });

  // Pause
  socket.on('pause', (payload) => {
    const target = room();
    if (!target) return;
    if (target.playing && target.startedAt) {
      target.position += (Date.now() - target.startedAt) / 1000;
    }
    const time = toFiniteNumber(payload && payload.time);
    if (time !== null) target.position = time;
    target.playing = false;
    target.startedAt = null;
    socket.to(currentRoom).emit('remote_pause', { time: target.position, by: userName });
  });

  // Seek
  socket.on('seek', (payload) => {
    const target = room();
    if (!target) return;
    const time = toFiniteNumber(payload && payload.time);
    if (time === null) return;
    target.position = time;
    if (target.playing) target.startedAt = Date.now();
    socket.to(currentRoom).emit('remote_seek', { time, by: userName });
  });

  // Запрос синхронизации (для новых участников и выравнивания)
  socket.on('sync_request', () => {
    const target = room();
    if (!target) return;
    socket.emit('sync_state', getRoomState(target));
  });

  // Чат
  socket.on('chat_message', (payload) => {
    const target = room();
    if (!target) return;
    const text = String((payload && payload.text) || '').slice(0, 500).trim();
    if (!text) return;

    const message = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: userName,
      color: userColor,
      text,
      time: Date.now()
    };
    target.messages.push(message);
    if (target.messages.length > 60) target.messages.shift();
    io.to(currentRoom).emit('chat_message', message);
  });

  // Реакции
  socket.on('reaction', (payload) => {
    if (!currentRoom) return;
    const key = payload && typeof payload.emoji === 'string' ? payload.emoji : '';
    if (!REACTION_KEYS.includes(key)) return;
    io.to(currentRoom).emit('reaction', { emoji: key, name: userName, id: Date.now() + Math.random() });
  });

  // Очередь
  socket.on('queue_add', (payload) => {
    const target = room();
    if (!target) return;
    const data = payload || {};
    const url = safeUrl(data.url);
    if (!url) {
      socket.emit('app_error', { message: 'Некорректная ссылка на видео' });
      return;
    }
    const type = VIDEO_TYPES.includes(data.type) ? data.type : 'direct';
    const title = videoTitle(type, url, data.title);
    const item = { id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, url, type, title, addedByName: userName };

    target.queue.push(item);
    io.to(currentRoom).emit('queue_update', target.queue);
    io.to(currentRoom).emit('system_message', { text: type === 'link' ? `${userName} добавил в очередь ссылку на сайт` : `${userName} добавил в очередь: ${title}`, time: Date.now() });
  });

  socket.on('queue_remove', (payload) => {
    const target = room();
    if (!target) return;
    const id = payload && payload.id;
    target.queue = target.queue.filter((q) => q.id !== id);
    io.to(currentRoom).emit('queue_update', target.queue);
  });

  socket.on('queue_next', () => {
    const target = room();
    if (!target || target.queue.length === 0) return;
    const next = target.queue.shift();
    target.video = { url: next.url, type: next.type, title: next.title, addedBy: socket.id, addedByName: userName };
    target.playing = false;
    target.position = 0;
    target.startedAt = null;
    io.to(currentRoom).emit('video_changed', { video: target.video, state: getRoomState(target) });
    io.to(currentRoom).emit('queue_update', target.queue);
  });

  // Отключение
  socket.on('disconnect', () => {
    const target = room();
    if (!target) return;
    const name = (target.users.get(socket.id) || {}).name || userName;
    target.users.delete(socket.id);

    if (target.users.size === 0) {
      rooms.delete(currentRoom);
      return;
    }
    if (target.hostId === socket.id) {
      target.hostId = target.users.keys().next().value;
    }
    io.to(currentRoom).emit('users_update', getRoomState(target));
    io.to(currentRoom).emit('system_message', { text: `${name} покинул комнату`, time: Date.now() });
  });
});

// Проверка состояния сервера
app.get('/api/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

// Любой несуществующий маршрут возвращает главную страницу (удобно для ссылок ?room=XXXXXX)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`SyncWatch запущен: http://0.0.0.0:${PORT}`);
});
