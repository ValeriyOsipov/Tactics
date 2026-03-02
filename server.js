const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { createClient } = require('redis');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, 'public')));

// === Подключение к Redis ===
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redisClient = createClient({ url: redisUrl });

redisClient.on('error', (err) => {
  console.error('Redis Client Error', err);
});

redisClient.connect();

// === Функция для загрузки состояния из Redis ===
async function loadState() {
  try {
    const data = await redisClient.get('rooms');
    if (data) {
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Ошибка при загрузке состояния из Redis:', e);
  }
  return {};
}

// === Загружаем состояние при запуске ===
let rooms = {};

redisClient.get('rooms').then(data => {
  if (data) {
    rooms = JSON.parse(data);
    console.log('Состояние комнат загружено из Redis');
  } else {
    console.log('Состояние комнат отсутствует в Redis, начинаем с пустого');
  }
}).catch(err => {
  console.error('Ошибка при загрузке состояния:', err);
});

// === НЕБЕЗОПАСНЫЕ ЭНДПОИНТЫ ДЛЯ ОТЛАДКИ ===
// ВНИМАНИЕ: Не используй в продакшене без аутентификации!

app.get('/admin/dump-redis', async (req, res) => {
  try {
    const data = await redisClient.get('rooms');
    res.json(data ? JSON.parse(data) : {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/load-redis', express.json({ limit: '50mb' }), async (req, res) => {
  console.log('Получен запрос на загрузку состояния в Redis');
  try {
    let newState = req.body;

    // === ИСПРАВЛЕНИЕ: Преобразуем старый формат в новый ===
    for (const roomId in newState) {
      const room = newState[roomId];
      if (room.maps) {
        for (const mapName in room.maps) {
          const map = room.maps[mapName];
          if (Array.isArray(map)) {
            // Это старый формат: maps[mapName] = [...]
            room.maps[mapName] = { objects: map };
            console.log(`Карта "${mapName}" в комнате "${roomId}" преобразована в новый формат`);
          }
        }
      }
    }

    console.log('Новое состояние (после преобразования):', JSON.stringify(newState).substring(0, 100) + '...');

    // Обновляем и Redis, и память
    await redisClient.set('rooms', JSON.stringify(newState));
    rooms = newState; // Обновляем память

    console.log('Состояние успешно сохранено в Redis и обновлено в памяти');
    res.json({ success: true });
  } catch (e) {
    console.error('Ошибка при загрузке состояния в Redis:', e);
    res.status(500).json({ error: e.message });
  }
});

// Список карт
const availableMaps = [
  'Греция.jpeg',
  'Ледяные острова.png',
  'Огненная земля.png',
  'Петля.png',
  'Путь воина.png',
  'Север.png',
  'Северные воды.jpeg',
  'Зона крушения Альфа.png'
];

io.on('connection', (socket) => {
  socket.on('get-available-maps', () => {
    socket.emit('available-maps', availableMaps);
  });

  socket.on('join-room', async ({ roomId, userName }) => {
    socket.join(roomId);

    // === ЧИТАЕМ rooms ИЗ REDIS ===
    try {
      const redisData = await redisClient.get('rooms');
      if (redisData) {
        rooms = JSON.parse(redisData);
        console.log('rooms обновлён из Redis');
      }
    } catch (e) {
      console.error('Ошибка при чтении rooms из Redis:', e);
    }

    // === УБЕДИМСЯ, ЧТО КОМНАТА ЕСТЬ ===
    if (!rooms[roomId]) {
      rooms[roomId] = { maps: {}, users: {}, currentMap: 'Греция.jpeg' };
      console.log(`Комната создана: ${roomId}`);
    }

    // === ИСПРАВЛЕНИЕ: Если на currentMap нет объектов, ищи карту с объектами ===
    let currentMap = rooms[roomId].currentMap;
    if (!rooms[roomId].maps[currentMap]?.objects?.length) {
      console.log(`currentMap "${currentMap}" пуста или не существует, ищем карту с объектами...`);
      // Ищем карту с объектами
      for (const mapName in rooms[roomId].maps) {
        const map = rooms[roomId].maps[mapName];
        if (map.objects && Array.isArray(map.objects) && map.objects.length > 0) {
          currentMap = mapName;
          rooms[roomId].currentMap = mapName; // Обновляем currentMap
          console.log(`Текущая карта изменена на: ${mapName}`);
          break;
        }
      }
    }

    // === ИСПРАВЛЕНИЕ: Убедимся, что карта существует ===
    if (!rooms[roomId].maps[currentMap]) {
      rooms[roomId].maps[currentMap] = { objects: [] };
    }

    rooms[roomId].users[socket.id] = { id: socket.id, name: userName || `User ${Object.keys(rooms[roomId].users).length + 1}` };

    socket.roomId = roomId;
    socket.currentMap = currentMap; // Обновляем currentMap у сокета

    console.log(`Пользователь ${socket.id} зашёл в комнату ${roomId}`);
    console.log(`Объекты на карте "${currentMap}":`, rooms[roomId].maps[currentMap].objects);

    socket.to(roomId).emit('user-joined', rooms[roomId].users[socket.id]);
    socket.emit('room-data', {
      objects: rooms[roomId].maps[currentMap].objects,
      currentMap: currentMap,
      users: Object.values(rooms[roomId].users)
    });

    // === Сохраняем сразу ===
    try {
      redisClient.set('rooms', JSON.stringify(rooms));
      console.log('Состояние комнат сохранено в Redis (join-room)');
    } catch (e) {
      console.error('Ошибка при сохранении состояния в Redis (join-room):', e);
    }
  });

  socket.on('add-object', (data) => {
    const roomId = socket.roomId;
    const map = socket.currentMap; // === ВАЖНО: использовать текущую карту сокета ===
    if (roomId && rooms[roomId] && rooms[roomId].maps[map]) {
      rooms[roomId].maps[map].objects.push(data);
      socket.to(roomId).emit('object-added', data);

      // === Сохраняем сразу ===
      try {
        redisClient.set('rooms', JSON.stringify(rooms));
        console.log('Состояние комнат сохранено в Redis (add-object)');
      } catch (e) {
        console.error('Ошибка при сохранении состояния в Redis (add-object):', e);
      }
    }
  });

  socket.on('update-object', (data) => {
    const roomId = socket.roomId;
    const map = socket.currentMap; // === ВАЖНО: использовать текущую карту сокета ===
    if (rooms[roomId] && rooms[roomId].maps[map]) {
      const obj = rooms[roomId].maps[map].objects.find(o => o.id === data.id);
      if (obj) {
        obj.x = data.x;
        obj.y = data.y;
        if (data.label !== undefined) obj.label = data.label;

        // === ОТПРАВИТЬ ВСЕМ ===
        socket.to(roomId).emit('object-updated', data);

        // === СОХРАНИТЬ В REDIS ===
        try {
          redisClient.set('rooms', JSON.stringify(rooms));
          console.log('Состояние комнат сохранено в Redis (update-object)');
        } catch (e) {
          console.error('Ошибка при сохранении состояния в Redis (update-object):', e);
        }
      }
    }
  });

  socket.on('change-map', (data) => {
    const roomId = socket.roomId;
    if (rooms[roomId]) {
      if (!rooms[roomId].maps[data.map]) {
        rooms[roomId].maps[data.map] = { objects: [] };
      }
      rooms[roomId].currentMap = data.map;
      socket.currentMap = data.map; // === ВАЖНО: обновить у сокета ===

      socket.emit('map-changed', data);
      socket.to(roomId).emit('map-changed', data);

      // === Сохраняем сразу ===
      try {
        redisClient.set('rooms', JSON.stringify(rooms));
        console.log('Состояние комнат сохранено в Redis (change-map)');
      } catch (e) {
        console.error('Ошибка при сохранении состояния в Redis (change-map):', e);
      }
    }
  });

  socket.on('get-map-objects', (data) => {
    const roomId = socket.roomId;
    if (rooms[roomId] && rooms[roomId].maps[data.map]) {
      socket.emit('map-objects', {
        map: data.map,
        objects: rooms[roomId].maps[data.map].objects
      });
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

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      delete rooms[roomId].users[socket.id];
      socket.to(roomId).emit('user-left', socket.id);
      console.log(`Пользователь ${socket.id} покинул комнату ${roomId}`);

      // === Сохраняем сразу ===
      try {
        redisClient.set('rooms', JSON.stringify(rooms));
        console.log('Состояние комнат сохранено в Redis (disconnect)');
      } catch (e) {
        console.error('Ошибка при сохранении состояния в Redis (disconnect):', e);
      }
    }
  });

  socket.on('remove-object', (data) => {
  const roomId = socket.roomId;
  const map = socket.currentMap;
  if (rooms[roomId] && rooms[roomId].maps[map]) {
    const index = rooms[roomId].maps[map].objects.findIndex(o => o.id === data.id);
    if (index !== -1) {
      rooms[roomId].maps[map].objects.splice(index, 1);

      // === Отправить всем ===
      socket.to(roomId).emit('object-removed', { id: data.id });

      // === Сохранить в Redis ===
      try {
        redisClient.set('rooms', JSON.stringify(rooms));
        console.log('Объект удалён и состояние сохранено в Redis');
      } catch (e) {
        console.error('Ошибка при сохранении в Redis:', e);
      }
    }
  }
});
  
});

// === Keep-alive endpoint ===
app.get('/ping', (req, res) => {
  // Проверяем, есть ли активные комнаты
  const hasActiveRooms = Object.keys(rooms).some(roomId => {
    return rooms[roomId].users && Object.keys(rooms[roomId].users).length > 0;
  });

  if (hasActiveRooms) {
    console.log('Ping received, active rooms detected.');
    res.status(200).send('OK - Active rooms');
  } else {
    console.log('Ping received, no active rooms.');
    res.status(200).send('OK - No active rooms');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// === Сохраняем состояние при завершении работы ===
process.on('SIGINT', () => {
  console.log('Сохраняем состояние перед завершением...');
  redisClient.set('rooms', JSON.stringify(rooms));
  redisClient.quit();
  process.exit(0);
});



