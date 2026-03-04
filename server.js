const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { createClient } = require('redis');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "https://mk-tactics.ru", // исправлено
    methods: ["GET", "POST"]
  },
  pingInterval: 20000,
  pingTimeout: 10000
});

app.use(express.static(path.join(__dirname, 'public')));

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redisClient = createClient({ url: redisUrl });

redisClient.on('error', (err) => {
  console.error('Redis Client Error', err);
});

redisClient.connect();

// === ФУНКЦИИ ДЛЯ РАБОТЫ С ОТДЕЛЬНЫМИ КОМНАТАМИ ===

async function getRoom(roomId) {
  const data = await redisClient.get(`room:${roomId}`);
  return data ? JSON.parse(data) : null;
}

async function saveRoom(roomId, roomData) {
  await redisClient.set(`room:${roomId}`, JSON.stringify(roomData));
}

// === ЗАГРУЗКА СПИСКА ВСЕХ КОМНАТ (опционально) ===
async function getAllRooms() {
  const roomKeys = await redisClient.keys('room:*');
  const roomPromises = roomKeys.map(key => redisClient.get(key));
  const roomDataList = await Promise.all(roomPromises);
  const result = {};
  roomKeys.forEach((key, index) => {
    const roomId = key.replace('room:', '');
    result[roomId] = JSON.parse(roomDataList[index]);
  });
  return result;
}

// === ЭНДПОИНТЫ ДЛЯ ОТЛАДКИ ===

app.get('/admin/dump-redis', async (req, res) => {
  try {
    const allRooms = await getAllRooms();
    res.json(allRooms);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/load-redis', express.json({ limit: '50mb' }), async (req, res) => {
  console.log('Получен запрос на загрузку состояния в Redis');
  try {
    let newState = req.body;

    for (const roomId in newState) {
      const room = newState[roomId];
      if (room.maps) {
        for (const mapName in room.maps) {
          const map = room.maps[mapName];
          if (Array.isArray(map)) {
            room.maps[mapName] = { objects: map };
            console.log(`Карта "${mapName}" в комнате "${roomId}" преобразована в новый формат`);
          }
        }
      }
    }

    console.log('Новое состояние (после преобразования):', JSON.stringify(newState).substring(0, 100) + '...');

    // === СОХРАНИТЬ КАЖДУЮ КОМНАТУ ОТДЕЛЬНО ===
    for (const roomId in newState) {
      await saveRoom(roomId, newState[roomId]);
    }

    console.log('Состояния комнат успешно сохранены в Redis');
    res.json({ success: true });
  } catch (e) {
    console.error('Ошибка при загрузке состояния в Redis:', e);
    res.status(500).json({ error: e.message });
  }
});

const availableMaps = [
  'Греция.png',
  'Ледяные острова.png',
  'Огненная земля.png',
  'Петля.png',
  'Путь воина.png',
  'Север.png',
  'Северные воды.jpeg',
  'Зона крушения Альфа.png'
];

io.on('connection', (socket) => {
  console.log('Подключение клиента:', socket.id); // ← ИСПРАВЛЕНО
  socket.on('get-available-maps', () => {
    socket.emit('available-maps', availableMaps);
  });

  socket.on('join-room', async ({ roomId, userName, password }) => {
    socket.join(roomId);

    let room = await getRoom(roomId);

    if (!room) {
      room = { maps: {}, users: {}, currentMap: 'Греция.png', password: password || '' };
      console.log(`Комната создана: ${roomId}`);
    } else {
      if (room.password && room.password !== password) {
        socket.emit('wrong-password');
        return;
      }
    }

    let currentMap = room.currentMap;
    if (!room.maps[currentMap]?.objects?.length) {
      console.log(`currentMap "${currentMap}" пуста или не существует, ищем карту с объектами...`);
      for (const mapName in room.maps) {
        const map = room.maps[mapName];
        if (map.objects && Array.isArray(map.objects) && map.objects.length > 0) {
          currentMap = mapName;
          room.currentMap = mapName;
          console.log(`[ROOM: ${roomId}] Текущая карта изменена на: ${mapName}`);
          break;
        }
      }
    }

    if (!room.maps[currentMap]) {
      room.maps[currentMap] = { objects: [] };
    }

    room.users[socket.id] = { id: socket.id, name: userName || `User ${Object.keys(room.users).length + 1}` };

    socket.roomId = roomId;
    socket.currentMap = currentMap;

    console.log(`Пользователь ${socket.id} (${userName}) зашёл в комнату ${roomId}`);

    socket.to(roomId).emit('user-joined', room.users[socket.id]);
    socket.emit('room-data', {
      objects: room.maps[currentMap].objects,
      currentMap: currentMap,
      users: Object.values(room.users)
    });

    try {
      await saveRoom(roomId, room);
      console.log(`[ROOM: ${roomId}] Состояние комнаты сохранено в Redis (join-room)`);
    } catch (e) {
      console.error(`[ROOM: ${roomId}] Ошибка при сохранении состояния в Redis (join-room):`, e);
    }
  });

socket.on('add-object', async (data) => {
  const roomId = socket.roomId;
  const map = socket.currentMap;
  if (roomId) {
    let room = await getRoom(roomId);
    if (room && room.maps[map]) {
      if (data.rotation === undefined) data.rotation = 0;

      room.maps[map].objects.push(data);
      socket.to(roomId).emit('object-added', data);

      try {
        await saveRoom(roomId, room);
        console.log(`[ROOM: ${roomId}] Состояние комнаты сохранено в Redis (add-object)`);
      } catch (e) {
        console.error(`[ROOM: ${roomId}] Ошибка при сохранении состояния в Redis (add-object):`, e);
      }
    }
  }
});

socket.on('update-object', async (data) => {
  console.log('Получено update-object:', data);

  const roomId = socket.roomId;
  const map = socket.currentMap;
  if (roomId) {
    let room = await getRoom(roomId);
    if (room && room.maps[map]) {
      const obj = room.maps[map].objects.find(o => o.id === data.id);
      if (obj) {
        obj.x = data.x;
        obj.y = data.y;
        if (data.label !== undefined) obj.label = data.label;
        if (data.rotation !== undefined) obj.rotation = data.rotation;

        socket.to(roomId).emit('object-updated', data);
        socket.emit('object-updated', data);

        try {
          await saveRoom(roomId, room);
          console.log(`[ROOM: ${roomId}] Состояние комнаты сохранено в Redis (update-object)`);
        } catch (e) {
          console.error(`[ROOM: ${roomId}] Ошибка при сохранении состояния в Redis (update-object):`, e);
        }
      } else {
        console.log('Объект не найден при update-object:', data.id);
      }
    } else {
        console.log('Комната или карта не найдены при update-object');
    }
  }
});

  socket.on('change-map', async (data) => {
    const roomId = socket.roomId;
    if (roomId) {
      console.log(`[ROOM: ${roomId}] Смена карты на: ${data.map}`);
      let room = await getRoom(roomId);
      if (room) {
        if (!room.maps[data.map]) {
          room.maps[data.map] = { objects: [] };
        }
        room.currentMap = data.map;
        socket.currentMap = data.map;

        socket.emit('map-changed', data);
        socket.to(roomId).emit('map-changed', data);

        try {
          await saveRoom(roomId, room);
          console.log(`[ROOM: ${roomId}] Состояние комнаты сохранено в Redis (change-map)`);
        } catch (e) {
          console.error(`[ROOM: ${roomId}] Ошибка при сохранении состояния в Redis (change-map):`, e);
        }
      }
    }
  });

  socket.on('get-map-objects', async (data) => {
    const roomId = socket.roomId;
    if (roomId) {
      let room = await getRoom(roomId);
      if (room && room.maps[data.map]) {
        socket.emit('map-objects', {
          map: data.map,
          objects: room.maps[data.map].objects
        });
      }
    }
  });

  socket.on('click-effect', (data) => {
    const roomId = socket.roomId;
    if (roomId) {
      socket.to(roomId).emit('click-effect', data);
    }
  });

  socket.on('drag-end-effect', (data) => {
    const roomId = socket.roomId;
    if (roomId) {
      socket.to(roomId).emit('drag-end-effect', data);
    }
  });

  socket.on('drop-effect', (data) => {
    const roomId = socket.roomId;
    if (roomId) {
      socket.to(roomId).emit('drop-effect', data);
    }
  });

  socket.on('disconnect', async () => {
    const roomId = socket.roomId;
    if (roomId) {
      console.log(`[ROOM: ${roomId}] Пользователь ${socket.id} отключился`);
      let room = await getRoom(roomId);
      if (room) {
        delete room.users[socket.id];
        socket.to(roomId).emit('user-left', socket.id);
        console.log(`Пользователь ${socket.id} покинул комнату ${roomId}`);

        try {
          await saveRoom(roomId, room);
          console.log(`[ROOM: ${roomId}] Состояние комнаты сохранено в Redis (disconnect)`);
        } catch (e) {
          console.error(`[ROOM: ${roomId}] Ошибка при сохранении состояния в Redis (disconnect):`, e);
        }
      }
    }
  });

  socket.on('remove-object', async (data) => {
    const roomId = socket.roomId;
    const map = socket.currentMap;
    if (roomId) {
      let room = await getRoom(roomId);
      if (room && room.maps[map]) {
        const index = room.maps[map].objects.findIndex(o => o.id === data.id);
        if (index !== -1) {
          room.maps[map].objects.splice(index, 1);

          socket.to(roomId).emit('object-removed', { id: data.id });

          try {
            await saveRoom(roomId, room);
            console.log(`[ROOM: ${roomId}] Объект удалён и состояние сохранено в Redis`);
          } catch (e) {
            console.error('Ошибка при сохранении в Redis:', e);
          }
        }
      }
    }
  });
});

app.get('/ping', async (req, res) => {
  try {
    const allRooms = await getAllRooms();
    const hasActiveRooms = Object.keys(allRooms).some(roomId => {
      return allRooms[roomId].users && Object.keys(allRooms[roomId].users).length > 0;
    });

    if (hasActiveRooms) {
      console.log('Ping received, active rooms detected.');
      res.status(200).send('OK - Active rooms');
    } else {
      console.log('Ping received, no active rooms.');
      res.status(200).send('OK - No active rooms');
    }
  } catch (e) {
    console.error('Ошибка при проверке активных комнат:', e);
    res.status(500).send('Internal Server Error');
  }
});

const PORT = process.env.PORT || 80;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

process.on('SIGINT', async () => {
  console.log('Сохраняем состояние перед завершением...');
  await redisClient.quit();
  process.exit(0);
});

async function clearUsersOnStartup() {
  try {
    const roomKeys = await redisClient.keys('room:*');
    if (roomKeys.length === 0) {
      console.log('Комнаты не найдены, очистка не требуется');
      return;
    }

    for (const key of roomKeys) {
      const roomData = await redisClient.get(key);
      if (roomData) {
        let room = JSON.parse(roomData);
        if (room.users) {
          room.users = {};
          await redisClient.set(key, JSON.stringify(room));
          console.log(`Пользователи в комнате ${key.replace('room:', '')} очищены`);
        }
      }
    }
  } catch (e) {
    console.error('Ошибка при очистке пользователей:', e);
  }
}

clearUsersOnStartup();





