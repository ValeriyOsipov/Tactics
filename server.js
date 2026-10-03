const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const Redis = require('ioredis');
const Redlock = require('redlock');

// === ГЛОБАЛЬНЫЕ ОБРАБОТЧИКИ ОШИБОК ===
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Не завершаем процесс, но логируем
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
  // Лучше не завершать процесс тут, а дать возможность системе перезапустить приложение (pm2, docker, etc.)
  // process.exit(1);
});

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "https://mk-tactics.ru",
    methods: ["GET", "POST"]
  },
  pingInterval: 60000,
  pingTimeout: 30000
});

app.use(express.static(path.join(__dirname, 'public')));

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redisClient = new Redis(redisUrl);

// Кэш активных комнат в оперативной памяти сервера
const activeRooms = new Map();
// Таймеры для отложенного сохранения (debounce)
const saveTimers = new Map();

redisClient.on('error', (err) => {
  console.error('Redis Client Error', err);
});

const redlock = new Redlock([redisClient], {
  driftFactor: 0.01,
  retryCount: 3, // Количество попыток
  retryDelay: 200, // Задержка между попытками в мс
  retryJitter: 200 // Добавить случайности к задержке
});

// Функция для получения комнаты (сначала ищем в кэше, потом в Redis)
async function getRoomCached(roomId) {
  if (activeRooms.has(roomId)) {
    return activeRooms.get(roomId);
  }
  
  // Если нет в кэше, читаем из Redis
  const data = await redisClient.get(`room:${roomId}`);
  let room = data ? JSON.parse(data) : null;

  if (room) {
    // ... (твоя существующая логика миграции формата тактик) ...
    for (const mapName in room.maps) {
      if (Array.isArray(room.maps[mapName])) {
        room.maps[mapName] = { 'Тактика 1': room.maps[mapName] };
      }
      if (Object.keys(room.maps[mapName]).length === 0) {
        room.maps[mapName]['Тактика 1'] = [];
      }
    }
  }

  // Сохраняем в кэш
  if (room) {
    activeRooms.set(roomId, room);
  }
  return room;
}

// Функция отложенного сохранения (Debounce)
function scheduleRoomSave(roomId) {
  // Если таймер уже есть, сбрасываем его
  if (saveTimers.has(roomId)) {
    clearTimeout(saveTimers.get(roomId));
  }

  // Устанавливаем новый таймер на 1000 мс (1 секунда)
  const timer = setTimeout(async () => {
    const room = activeRooms.get(roomId);
    if (room) {
      try {
        // Используем блокировку только при финальной записи
        await withRoomLock(roomId, async () => {
          await redisClient.set(`room:${roomId}`, JSON.stringify(room));
          console.log(`[REDIS] Комната ${roomId} сохранена в Redis (debounce)`);
        });
      } catch (e) {
        console.error(`[REDIS] Ошибка сохранения комнаты ${roomId}:`, e);
        // В случае ошибки можно попробовать удалить из кэша, чтобы при следующем запросе взять из Redis
        activeRooms.delete(roomId);
      }
    }
    saveTimers.delete(roomId);
  }, 1000); // <-- Задержка в 1 секунду. Можно поставить 500 или 2000.

  saveTimers.set(roomId, timer);
}

// === ОБНОВЛЁННАЯ ФУНКЦИЯ БЛОКИРОВКИ ===
async function withRoomLock(roomId, callback) {
  const lockKey = `lock:room:${roomId}`;
  let lock;

  try {
    // <<< ПОПЫТКА ПОЛУЧИТЬ БЛОКИРОВКУ >>>
    lock = await redlock.acquire([lockKey], 1000); // 1000 мс TTL
  } catch (e) {
    // <<< ОБРАБОТКА ОШИБКИ ПОЛУЧЕНИЯ БЛОКИРОВКИ >>>
    if (e.name === 'LockError') {
      console.error(`[REDLOCK] Не удалось получить блокировку для комнаты ${roomId} за 1000мс:`, e.message);
      // Пробрасываем LockError дальше, чтобы вызывающий код мог его обработать
      throw e;
    } else {
      console.error(`[REDLOCK] Неожиданная ошибка при попытке получить блокировку для комнаты ${roomId}:`, e);
      // Пробрасываем ошибку дальше
      throw e;
    }
  }

  // <<< LOCK ПОЛУЧЕН УСПЕШНО >>>
  try {
    // <<< ВЫПОЛНЕНИЕ КОЛБЭКА >>>>
    return await callback();
  } finally {
    // <<< ОСВОБОЖДЕНИЕ БЛОКИРОВКИ >>>
    if (lock) {
      try {
        await redlock.release(lock);
        console.log(`[REDLOCK] Блокировка для комнаты ${roomId} успешно освобождена.`);
      } catch (releaseErr) {
        // <<< ОШИБКА ОСВОБОЖДЕНИЯ >>>
        console.error(`[REDLOCK] Ошибка при освобождении блокировки для комнаты ${roomId}:`, releaseErr.message);
        // Не пробрасываем ошибку освобождения, чтобы не сломать основной поток
      }
    }
  }
}

// === ФУНКЦИИ РАБОТЫ С ROOM ===
async function getRoom(roomId) {
  // <<< НЕТ НЕОБХОДИМОСТИ БЛОКИРОВКИ ПРИ ЧТЕНИИ >>>
  const data = await redisClient.get(`room:${roomId}`);
  let room = data ? JSON.parse(data) : null;

  if (room) {
    for (const mapName in room.maps) {
      if (Array.isArray(room.maps[mapName])) {
        room.maps[mapName] = {
          'Тактика 1': room.maps[mapName]
        };
        console.log(`[ROOM: ${roomId}] Карта "${mapName}" преобразована в формат с тактиками.`);
      }
      if (Object.keys(room.maps[mapName]).length === 0) {
        room.maps[mapName]['Тактика 1'] = [];
      }
    }
  }

  return room;
}

async function saveRoom(roomId, roomData) {
  // <<< НЕТ НЕОБХОДИМОСТИ БЛОКИРОВКИ ПРИ СОХРАНЕНИИ (saveRoom вызывается ВНУТРИ withRoomLock) >>>
  await redisClient.set(`room:${roomId}`, JSON.stringify(roomData));
}

async function getAllRooms() {
  const roomKeys = await scanKeys('room:*');
  const roomPromises = roomKeys.map(key => redisClient.get(key));
  const roomDataList = await Promise.all(roomPromises);
  const result = {};
  roomKeys.forEach((key, index) => {
    const roomId = key.replace('room:', '');
    result[roomId] = JSON.parse(roomDataList[index]);
  });
  return result;
}

// === ФУНКЦИЯ ДЛЯ БЕЗОПАСНОГО ПОИСКА КЛЮЧЕЙ (SCAN ВМЕСТО KEYS) ===
async function scanKeys(pattern) {
  const keys = [];
  let cursor = '0';
  
  do {
    // SCAN возвращает массив [новый_курсор, массив_ключей]
    const [nextCursor, batch] = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  
  return keys;
}

// === ЭНДПОИНТЫ ДЛЯ ОТЛАДКИ ===
app.get('/admin/dump-redis', async (req, res) => {
  try {
    const allRooms = await getAllRooms();
    res.json(allRooms);
  } catch (e) {
    console.error('Ошибка при дампе Redis:', e);
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

    for (const roomId in newState) {
      await saveRoom(roomId, newState[roomId]); // saveRoom НЕ использует блокировку, так как вызывается извне
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
  'Зона крушения Альфа.png',
  'Море надежды.png',
  'Окинава.png',
  'Раскол.png',
  'Слёзы пустыни.png',
  'Сонный Бохайвань.png',
  'Фарерские острова.png',
  'Атлантика.png'
];

io.on('connection', (socket) => {
  console.log('Подключение клиента:', socket.id);

  socket.on('get-available-maps', () => {
    socket.emit('available-maps', availableMaps);
  });

  // --- JOIN ROOM ---
socket.on('join-room', async ({ roomId, userName, userId, password }) => {
  socket.join(roomId);

  try {
    // Используем кэшированную версию
    let room = await getRoomCached(roomId);

    if (!room) {
      room = { maps: {}, users: {}, currentMap: 'Греция.png', currentTactic: 'Тактика 1', password: password || '' };
      room.maps[room.currentMap] = { [room.currentTactic]: [] };
      activeRooms.set(roomId, room); // Добавляем в кэш
      console.log(`[ROOM: ${roomId}] Комната создана`);
    } else {
      if (room.password && room.password !== password) {
        socket.emit('wrong-password');
        return;
      }
    }

    // ... (твоя существующая логика проверки currentMap/currentTactic) ...
    let currentMap = room.currentMap;
    let currentTactic = room.currentTactic;
    if (!room.maps[currentMap] || !room.maps[currentMap][currentTactic]) {
        // ... (твой код инициализации, без изменений) ...
        if (!room.maps[currentMap]) room.maps[currentMap] = {};
        room.maps[currentMap]['Тактика 1'] = [];
        room.currentTactic = 'Тактика 1';
        currentTactic = 'Тактика 1';
    }

    // ... (твоя логика добавления пользователя в room.users) ...
    if (room.users[userId]) {
        room.users[userId].socketId = socket.id;
        if (room.users[userId].name !== userName) room.users[userId].name = userName;
    } else {
        room.users[userId] = { id: userId, name: userName, socketId: socket.id };
    }

    socket.userId = userId;
    socket.currentTactic = currentTactic;
    socket.roomId = roomId;
    socket.currentMap = currentMap;

    socket.emit('room-data', {
      objects: room.maps[currentMap][currentTactic],
      currentMap: currentMap,
      currentTactic: currentTactic,
      tacticsForCurrentMap: Object.keys(room.maps[currentMap]),
      users: Object.values(room.users)
    });

    socket.to(roomId).emit('user-joined', room.users[userId]);

    // Запланировать сохранение (если комната только что создана или изменилась)
    scheduleRoomSave(roomId);

  } catch (err) {
    console.error(`[JOIN-ROOM] Ошибка:`, err);
    socket.emit('error', { message: 'Ошибка при входе в комнату.' });
  }
});

// --- ADD OBJECT (ОПТИМИЗИРОВАННЫЙ) ---
socket.on('add-object', async (data) => {
  const roomId = socket.roomId;
  const map = socket.currentMap;
  const tactic = socket.currentTactic;

  if (!roomId || !map || !tactic) return;

  // 1. Берем комнату ИЗ КЭША В ПАМЯТИ (не из Redis!)
  const room = activeRooms.get(roomId);
  if (!room || !room.maps[map] || !room.maps[map][tactic]) {
    console.error(`[ADD-OBJECT] Комната или тактика не найдена в кэше: ${roomId}`);
    return;
  }

  // 2. Мгновенно добавляем в память
  if (data.rotation === undefined) data.rotation = 0;
  room.maps[map][tactic].push(data);

  // 3. Мгновенно рассылаем всем (включая отправителя, чтобы синхронизировать состояние)
  io.to(roomId).emit('object-added', data);

  // 4. Запускаем отложенное сохранение в Redis
  scheduleRoomSave(roomId);
});

  // --- UPDATE OBJECT ---

socket.on('update-object', async (data) => {
  const roomId = socket.roomId;
  const map = socket.currentMap;
  const tactic = socket.currentTactic;

  if (!roomId || !map || !tactic) return;

  // 1. Берем комнату из быстрого кэша в памяти (без Redis и JSON.parse!)
  const room = activeRooms.get(roomId);
  if (!room || !room.maps[map] || !room.maps[map][tactic]) {
    console.error(`[UPDATE] Комната или тактика не найдена в кэше: ${roomId}`);
    return;
  }

  const obj = room.maps[map][tactic].find(o => o.id === data.id);
  if (!obj) return;

  // 2. Мгновенно обновляем данные в памяти
  if (data.x !== undefined) obj.x = data.x;
  if (data.y !== undefined) obj.y = data.y;
  if (data.label !== undefined) obj.label = data.label;
  if (data.rotation !== undefined) obj.rotation = data.rotation;
  if (data.startX !== undefined) obj.startX = data.startX;
  if (data.startY !== undefined) obj.startY = data.startY;
  if (data.endX !== undefined) obj.endX = data.endX;
  if (data.endY !== undefined) obj.endY = data.endY;

  // Логика обновления кружков (тоже в памяти)
  const isShip = (obj.type.startsWith('l') || obj.type.startsWith('k') || obj.type === 'es');
  if (isShip) {
    room.maps[map][tactic].forEach(otherObj => {
      if (otherObj.type.startsWith('custom-circle-') && otherObj.parentId === obj.id) {
        otherObj.x = obj.x;
        otherObj.y = obj.y;
      }
    });
  }

  // 3. МОМЕНТАЛЬНАЯ рассылка всем клиентам (визуальное обновление)
  io.to(roomId).emit('object-updated', data);
  
  // Рассылаем обновленные кружки, если они двигались
  if (isShip) {
    room.maps[map][tactic].forEach(otherObj => {
      if (otherObj.type.startsWith('custom-circle-') && otherObj.parentId === obj.id) {
        io.to(roomId).emit('object-updated', { id: otherObj.id, x: otherObj.x, y: otherObj.y });
      }
    });
  }

  // 4. Запускаем или сбрасываем таймер сохранения в Redis (Debounce)
  scheduleRoomSave(roomId);
});
  
  // --- GET MAP OBJECTS (не использует блокировку, только чтение) ---
  socket.on('get-map-objects', async (data) => {
    const roomId = socket.roomId;
    if (roomId) {
      try {
        let room = await getRoom(roomId); // <<< Чтение, без блокировки >>>
        if (room && room.maps[data.map]) {
          socket.emit('map-objects', {
            map: data.map,
            objects: room.maps[data.map].objects
          });
        }
      } catch (e) {
        console.error(`[GET-MAP-OBJECTS] Ошибка при получении объектов карты ${data.map} для комнаты ${roomId}:`, e);
        socket.emit('error', { message: 'Ошибка при получении объектов карты.' });
      }
    }
  });

  // --- CHANGE MAP ---
  socket.on('change-map', async (data) => {
    const roomId = socket.roomId;
    if (!roomId) return;

    const room = activeRooms.get(roomId);
    if (!room) {
      console.error(`[CHANGE-MAP] Комната не найдена в кэше: ${roomId}`);
      return;
    }

    if (!room.maps[data.map]) {
      room.maps[data.map] = { 'Тактика 1': [] };
    } else if (Object.keys(room.maps[data.map]).length === 0) {
      room.maps[data.map]['Тактика 1'] = [];
    }

    room.currentMap = data.map;
    const firstTactic = Object.keys(room.maps[data.map])[0];
    room.currentTactic = firstTactic;

    socket.currentMap = data.map;
    socket.currentTactic = firstTactic;

    const socketsInRoom = await io.in(roomId).fetchSockets();
    for (const sock of socketsInRoom) {
      sock.currentMap = data.map;
      sock.currentTactic = firstTactic;
    }

    io.to(roomId).emit('map-changed', {
      map: data.map,
      tacticsList: Object.keys(room.maps[data.map]),
      currentTactic: room.currentTactic
    });

    scheduleRoomSave(roomId);
  });

  // --- ADD VECTOR ---
  socket.on('add-vector', (vectorObj) => {
    const roomId = socket.roomId;
    const map = socket.currentMap;
    const tactic = socket.currentTactic;

    if (!roomId || !map || !tactic) return;
    const room = activeRooms.get(roomId);
    if (!room || !room.maps[map] || !room.maps[map][tactic]) return;

    room.maps[map][tactic].push(vectorObj);
    socket.to(roomId).emit('vector-added', vectorObj);
    scheduleRoomSave(roomId);
  });

  // --- ADD CUSTOM CIRCLE ---
  socket.on('add-custom-circle', (circleObj) => {
    const roomId = socket.roomId;
    const map = socket.currentMap;
    const tactic = socket.currentTactic;

    if (!roomId || !map || !tactic) return;
    const room = activeRooms.get(roomId);
    if (!room || !room.maps[map] || !room.maps[map][tactic]) return;

    room.maps[map][tactic].push(circleObj);
    io.to(roomId).emit('object-added', circleObj);
    scheduleRoomSave(roomId);
  });

  // --- REMOVE ALL CUSTOM CIRCLES ---
  socket.on('remove-all-custom-circles', (data) => {
    const { parentId } = data;
    const roomId = socket.roomId;
    const map = socket.currentMap;
    const tactic = socket.currentTactic;

    if (!roomId || !map || !tactic || !parentId) return;
    const room = activeRooms.get(roomId);
    if (!room || !room.maps[map] || !room.maps[map][tactic]) return;

    const circlesToRemove = room.maps[map][tactic].filter(obj => obj.type.startsWith('custom-circle-') && obj.parentId === parentId);
    room.maps[map][tactic] = room.maps[map][tactic].filter(obj => !(obj.type.startsWith('custom-circle-') && obj.parentId === parentId));

    circlesToRemove.forEach(circle => {
      io.to(roomId).emit('object-removed', { id: circle.id });
    });

    scheduleRoomSave(roomId);
  });

  // --- REMOVE OBJECT ---
  socket.on('remove-object', (data) => {
    const { id: objectIdToRemove } = data;
    const roomId = socket.roomId;
    const map = socket.currentMap;
    const tactic = socket.currentTactic;

    if (!roomId || !map || !tactic || !objectIdToRemove) return;
    const room = activeRooms.get(roomId);
    if (!room || !room.maps[map] || !room.maps[map][tactic]) return;

    const objIndex = room.maps[map][tactic].findIndex(o => o.id === objectIdToRemove);
    if (objIndex !== -1) {
      const objToRemove = room.maps[map][tactic][objIndex];
      room.maps[map][tactic].splice(objIndex, 1);

      const isShip = (objToRemove.type.startsWith('l') || objToRemove.type.startsWith('k') || objToRemove.type === 'es');
      let circlesToRemove = [];
      
      if (isShip) {
        for (let i = room.maps[map][tactic].length - 1; i >= 0; i--) {
          const otherObj = room.maps[map][tactic][i];
          if (otherObj.type.startsWith('custom-circle-') && otherObj.parentId === objToRemove.id) {
            circlesToRemove.push({ id: otherObj.id, index: i });
          }
        }
        for (const circle of circlesToRemove) {
          room.maps[map][tactic].splice(circle.index, 1);
        }
      }

      io.to(roomId).emit('object-removed', { id: objToRemove.id });
      circlesToRemove.forEach(circle => {
        io.to(roomId).emit('object-removed', { id: circle.id });
      });

      scheduleRoomSave(roomId);
    }
  });

  // --- SWITCH TACTIC ---
  socket.on('switch-tactic', async (data) => {
    const { mapName, tacticName } = data;
    const roomId = socket.roomId;
    const currentMap = socket.currentMap;

    if (!roomId || mapName !== currentMap) return;
    const room = activeRooms.get(roomId);
    if (!room || !room.maps[mapName] || !room.maps[mapName][tacticName]) return;

    room.currentTactic = tacticName;

    const socketsInRoom = await io.in(roomId).fetchSockets();
    for (const sock of socketsInRoom) {
      sock.currentTactic = tacticName;
    }

    io.to(roomId).emit('tactic-changed', { map: mapName, tactic: tacticName });
    scheduleRoomSave(roomId);
  });

  // --- ADD TACTIC ---
  socket.on('add-tactic', async (data) => {
    const { mapName, tacticName } = data;
    const roomId = socket.roomId;
    const currentMap = socket.currentMap;

    if (!roomId || mapName !== currentMap || !isValidString(tacticName)) {
      socket.emit('tactic-error', { message: 'Неверное имя тактики или карта.' });
      return;
    }

    const room = activeRooms.get(roomId);
    if (!room || !room.maps[mapName]) return;

    if (!room.maps[mapName][tacticName]) {
      room.maps[mapName][tacticName] = [];
      room.currentTactic = tacticName;
      socket.currentTactic = tacticName;

      const socketsInRoom = await io.in(roomId).fetchSockets();
      for (const sock of socketsInRoom) {
        sock.currentTactic = tacticName;
      }

      io.to(roomId).emit('tactic-added', { map: mapName, tactic: tacticName, tacticsList: Object.keys(room.maps[mapName]) });
      io.to(roomId).emit('tactic-changed', { map: mapName, tactic: tacticName });
      scheduleRoomSave(roomId);
    } else {
      socket.emit('tactic-error', { message: 'Тактика с таким именем уже существует.' });
    }
  });

  // --- REMOVE TACTIC ---
  socket.on('remove-tactic', async (data) => {
    const { mapName, tacticName } = data;
    const roomId = socket.roomId;
    const currentMap = socket.currentMap;

    if (!roomId || mapName !== currentMap || !tacticName) return;
    const room = activeRooms.get(roomId);
    if (!room || !room.maps[mapName] || !room.maps[mapName][tacticName]) return;

    const tacticsList = Object.keys(room.maps[mapName]);
    let newTactic;

    if (tacticsList.length <= 1) {
      delete room.maps[mapName][tacticName];
      const newDefaultTactic = 'Тактика 1';
      room.maps[mapName][newDefaultTactic] = [];
      room.currentTactic = newDefaultTactic;
      newTactic = newDefaultTactic;

      io.to(roomId).emit('tactic-replaced', {
        map: mapName,
        oldTactic: tacticName,
        newTactic: newTactic,
        tacticsList: Object.keys(room.maps[mapName])
      });
    } else {
      delete room.maps[mapName][tacticName];
      const remainingTactics = Object.keys(room.maps[mapName]);
      newTactic = remainingTactics[0];
      room.currentTactic = newTactic;

      io.to(roomId).emit('tactic-removed', { map: mapName, tactic: tacticName, tacticsList: Object.keys(room.maps[mapName]), newTactic: newTactic });
      io.to(roomId).emit('tactic-changed', { map: mapName, tactic: newTactic });
    }

    const socketsInRoom = await io.in(roomId).fetchSockets();
    for (const sock of socketsInRoom) {
      if (sock.currentMap === mapName) {
        sock.currentTactic = newTactic;
      }
    }

    scheduleRoomSave(roomId);
  });
  
  // --- GET OBJECTS FOR TACTIC (не использует блокировку, только чтение) ---
  socket.on('get-objects-for-tactic', async (data) => {
    const { map, tactic } = data;
    const roomId = socket.roomId;

    if (roomId && map && tactic) {
      try {
        let room = await getRoom(roomId); // <<< Чтение, без блокировки >>>
        if (room && room.maps[map] && room.maps[map][tactic]) {
          socket.emit('tactic-objects', {
            map: map,
            tactic: tactic,
            objects: room.maps[map][tactic]
          });
        } else {
          console.error(`[ROOM: ${roomId}] Не найдена карта "${map}" или тактика "${tactic}" при запросе объектов.`);
          socket.emit('tactic-objects', { map: map, tactic: tactic, objects: [] });
        }
      } catch (e) {
        console.error(`[GET-OBJECTS-FOR-TACTIC] Ошибка при получении объектов тактики ${tactic} для карты ${map} в комнате ${roomId}:`, e);
        socket.emit('error', { message: 'Ошибка при получении объектов тактики.' });
      }
    } else {
      console.error('Запрос get-objects-for-tactic без необходимых параметров map или tactic.');
      socket.emit('tactic-objects', { map: map, tactic: tactic, objects: [] });
    }
  });

  // --- CLICK EFFECT (не требует блокировки) ---
  socket.on('click-effect', (data) => {
    const roomId = socket.roomId;
    if (roomId) {
      socket.to(roomId).emit('click-effect', data);
    }
  });

  // --- HOLD CLICK EFFECT (не требует блокировки) ---
  socket.on('hold-click-effect', (data) => {
    const roomId = socket.roomId;
    if (roomId) {
      socket.to(roomId).emit('hold-click-effect', data);
      socket.emit('hold-click-effect', data);
    }
  });

  // --- DRAG END EFFECT (не требует блокировки) ---
  socket.on('drag-end-effect', (data) => {
    const roomId = socket.roomId;
    if (roomId) {
      socket.to(roomId).emit('drag-end-effect', data);
    }
  });

  // --- DROP EFFECT (не требует блокировки) ---
  socket.on('drop-effect', (data) => {
    const roomId = socket.roomId;
    if (roomId) {
      socket.to(roomId).emit('drop-effect', data);
    }
  });

  // --- DISCONNECT ---
socket.on('disconnect', async (reason) => {
  const roomId = socket.roomId;
  const userId = socket.userId;
  const socketId = socket.id;

  if (roomId) {
    console.log(`[ROOM: ${roomId}] Пользователь ${socketId} отключился, причина: ${reason}`);
    
    const room = activeRooms.get(roomId);
    if (room && userId && room.users[userId]) {
      if (room.users[userId].socketId === socketId) {
        delete room.users[userId];
      }
      
      io.to(roomId).emit('user-left', userId);
      
      // Принудительно сохраняем при выходе, чтобы не ждать таймера
      scheduleRoomSave(roomId); 
    }
  }
});
      

function isValidString(str) {
  if (typeof str !== 'string' || str.length > 15) return false;
  return /^[a-zA-Zа-яА-ЯёЁ0-9 ]*$/.test(str);
}

// --- PING ENDPOINT ---
app.get('/ping', (req, res) => {
  // Просто отвечаем OK. Никаких чтений из Redis.
  res.status(200).send('OK');
});

// --- MIGRATION AND STARTUP ---
async function migrateRoomsToNewTacticFormat() {
  console.log('=== Запуск миграции комнат к новому формату тактик ===');
  try {
    const roomKeys = await scanKeys('room:*');
    console.log(`Найдено ${roomKeys.length} комнат для проверки.`);

    if (roomKeys.length === 0) {
      console.log('Нет комнат для миграции.');
      return;
    }

    for (const key of roomKeys) {
      const roomId = key.replace('room:', '');
      console.log(`Проверка комнаты: ${roomId}`);

      let roomDataStr = await redisClient.get(key);
      if (!roomDataStr) {
        console.log(`  Комната ${key} пуста, пропускаем.`);
        continue;
      }

      let room = JSON.parse(roomDataStr);
      let migrationNeeded = false;

      for (const mapName in room.maps) {
        const mapData = room.maps[mapName];

        if (typeof mapData === 'object' && mapData !== null && mapData.hasOwnProperty('objects') && Array.isArray(mapData.objects)) {
            console.log(`  Найдена карта "${mapName}" в старом формате (объект с полем objects). Конвертируем...`);
            const oldObjects = mapData.objects;
            delete room.maps[mapName].objects;
            if (Object.keys(room.maps[mapName]).length === 0) {
                room.maps[mapName] = {
                  'Тактика 1': oldObjects
                };
            } else {
                room.maps[mapName] = {
                  'Тактика 1': oldObjects
                };
                console.warn(`  Предупреждение: Карта "${mapName}" имела неожиданные поля besides 'objects'. Они будут потеряны при миграции.`);
            }
            migrationNeeded = true;
            console.log(`  Карта "${mapName}" преобразована в новый формат: { "Тактика 1": [...] }`);
        }
        else if (typeof mapData === 'object' && mapData !== null) {
            const keys = Object.keys(mapData);
            let foundObjectsField = false;
            for (const keyName of keys) {
              if (keyName === 'objects') {
                 console.error(`  ОШИБКА: Карта "${mapName}" имеет поле 'objects', но оно не в корне объекта. Структура:`, mapData);
                 foundObjectsField = true;
                 break;
              }
            }
            if (!foundObjectsField) {
                 console.log(`  Карта "${mapName}" уже в новом формате или имеет неизвестный формат (ключи: ${keys.join(', ')}).`);
                 if (!room.currentTactic && keys.length > 0) {
                     room.currentTactic = keys[0];
                     console.log(`  Установлена currentTactic: ${room.currentTactic} для комнаты ${roomId}, карта ${mapName}`);
                     migrationNeeded = true;
                 }
            }
        } else {
          console.error(`  ОШИБКА: Карта "${mapName}" имеет неожиданный тип данных:`, typeof mapData, mapData);
        }
      }

      if (migrationNeeded) {
        try {
          await redisClient.set(key, JSON.stringify(room));
          console.log(`  Комната ${roomId} обновлена и сохранена.`);
        } catch (saveErr) {
          console.error(`  ОШИБКА при сохранении комнаты ${roomId}:`, saveErr);
        }
      } else {
         console.log(`  Комната ${roomId} не требовала миграции.`);
      }
    }

    console.log('=== Завершена миграция комнат к новому формату тактик ===');
  } catch (e) {
    console.error('=== ОШИБКА при миграции комнат ===', e);
  }
}

async function clearUsersOnStartup() {
  try {
    const roomKeys = await scanKeys('room:*');
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

migrateRoomsToNewTacticFormat().then(() => {
    console.log('Миграция завершена, запускаю очистку пользователей...');
    return clearUsersOnStartup();
}).then(() => {
    console.log('Сервер готов к запуску.');
}).catch(err => {
    console.error('Критическая ошибка при подготовке сервера:', err);
    process.exit(1);
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
