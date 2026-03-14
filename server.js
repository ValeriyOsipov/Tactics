const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const Redis = require('ioredis');
const Redlock = require('redlock');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "https://mk-tactics.ru", // исправлено
    methods: ["GET", "POST"]
  },
  pingInterval: 60000,
  pingTimeout: 30000
});

app.use(express.static(path.join(__dirname, 'public')));

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redisClient = new Redis(redisUrl);

redisClient.on('error', (err) => {
  console.error('Redis Client Error', err);
});

//redisClient.connect();

const redlock = new Redlock([redisClient], {
  driftFactor: 0.01,
  retryCount: 3,
  retryDelay: 200,
  retryJitter: 200
});

async function withRoomLock(roomId, callback) {
  const lockKey = `lock:room:${roomId}`;
  const lock = await redlock.acquire([lockKey], 1000);
  try {
    return await callback();
  } finally {
    await redlock.release(lock);
  }
}

async function getRoom(roomId) {
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
  await redisClient.set(`room:${roomId}`, JSON.stringify(roomData));
}

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

  await withRoomLock(roomId, async () => {
    let room = await getRoom(roomId);

    if (!room) {
      room = { maps: {}, users: {}, currentMap: 'Греция.png', currentTactic: 'Тактика 1', password: password || '' };
      room.maps[room.currentMap] = { [room.currentTactic]: [] };
      console.log(`[ROOM: ${roomId}] Комната создана`);
    } else {
      if (room.password && room.password !== password) {
        socket.emit('wrong-password');
        return;
      }
    }

    let currentMap = room.currentMap;
    let currentTactic = room.currentTactic;

    if (!room.maps[currentMap] || !room.maps[currentMap][currentTactic]) {
      if (room.maps[currentMap] && Object.keys(room.maps[currentMap]).length > 0) {
        currentTactic = Object.keys(room.maps[currentMap])[0];
        room.currentTactic = currentTactic;
        console.log(`[ROOM: ${roomId}] Текущая тактика изменена на существующую: ${currentTactic}`);
      } else {
        if (!room.maps[currentMap]) {
          room.maps[currentMap] = {};
        }
        room.maps[currentMap]['Тактика 1'] = [];
        room.currentTactic = 'Тактика 1';
        currentTactic = 'Тактика 1';
      }
    }

    room.users[socket.id] = { id: socket.id, name: userName || `User ${Object.keys(room.users).length + 1}` };
    
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

    socket.to(roomId).emit('user-joined', room.users[socket.id]);
    
    try {
      await saveRoom(roomId, room);
      console.log(`[ROOM: ${roomId}] Состояние комнаты сохранено в Redis (join-room)`);
    } catch (e) {
      console.error(`[ROOM: ${roomId}] Ошибка при сохранении состояния в Redis (join-room):`, e);
    }
    });
  });

socket.on('add-object', async (data) => {
  const roomId = socket.roomId;
  const map = socket.currentMap;
  const tactic = socket.currentTactic;

  if (roomId && map && tactic) {
    await withRoomLock(roomId, async () => {
      let room = await getRoom(roomId);
      if (room && room.maps[map] && room.maps[map][tactic]) {
        if (data.rotation === undefined) data.rotation = 0;

        room.maps[map][tactic].push(data);

        socket.to(roomId).emit('object-added', data);

        try {
          await saveRoom(roomId, room);
          console.log(`[ROOM: ${roomId}] Объект добавлен в тактику "${tactic}" карты "${map}", состояние комнаты сохранено в Redis (add-object)`);
        } catch (e) {
          console.error(`[ROOM: ${roomId}] Ошибка при сохранении состояния в Redis (add-object):`, e);
        }
      } else {
        console.error(`[ROOM: ${roomId}] Не найдена карта "${map}" или тактика "${tactic}" при попытке добавить объект.`, room?.maps[map]);
      }
    });
  } else {
    console.error('Не указан roomId, currentMap или currentTactic при add-object');
  }
});

socket.on('update-object', async (data) => {
  const roomId = socket.roomId;
  const map = socket.currentMap;
  const tactic = socket.currentTactic;

  if (roomId && map && tactic) {
    await withRoomLock(roomId, async () => {
      let room = await getRoom(roomId);
      if (room && room.maps[map] && room.maps[map][tactic]) {
        const obj = room.maps[map][tactic].find(o => o.id === data.id);
        if (obj) {
          if (data.x !== undefined) obj.x = data.x;
          if (data.y !== undefined) obj.y = data.y;

          if (data.label !== undefined) obj.label = data.label;
          if (data.rotation !== undefined) obj.rotation = data.rotation;

          if (data.startX !== undefined) obj.startX = data.startX;
          if (data.startY !== undefined) obj.startY = data.startY;
          if (data.endX !== undefined) obj.endX = data.endX;
          if (data.endY !== undefined) obj.endY = data.endY;

          socket.to(roomId).emit('object-updated', data);

          try {
            await saveRoom(roomId, room);
            console.log(`[ROOM: ${roomId}] Объект в тактике "${tactic}" карты "${map}" обновлён, состояние комнаты сохранено в Redis (update-object)`);
          } catch (e) {
            console.error(`[ROOM: ${roomId}] Ошибка при сохранении состояния в Redis (update-object):`, e);
          }
        } else {
          console.log(`[ROOM: ${roomId}] Объект с id ${data.id} не найден в тактике "${tactic}" карты "${map}".`);
        }
      } else {
        console.error(`[ROOM: ${roomId}] Не найдена карта "${map}" или тактика "${tactic}" при попытке обновить объект.`);
      }
    });
  } else {
    console.error('Не указан roomId, currentMap или currentTactic при update-object');
  }
});

socket.on('change-map', async (data) => {
  const roomId = socket.roomId;
  if (roomId) {
    console.log(`[ROOM: ${roomId}] Смена карты на: ${data.map}`);
    let room = await getRoom(roomId);
    if (room) {
      if (!room.maps[data.map]) {
        room.maps[data.map] = { 'Тактика 1': [] };
        console.log(`[ROOM: ${roomId}] Карта "${data.map}" инициализирована с тактикой "Тактика 1"`);
      } else {
        if (Object.keys(room.maps[data.map]).length === 0) {
          room.maps[data.map]['Тактика 1'] = [];
        }
      }

      room.currentMap = data.map;
      const firstTactic = Object.keys(room.maps[data.map])[0];
      room.currentTactic = firstTactic;

      socket.currentMap = data.map;
      socket.currentTactic = firstTactic;

      socket.emit('map-changed', {
        map: data.map,
        tacticsList: Object.keys(room.maps[data.map]),
        currentTactic: room.currentTactic
      });
      socket.to(roomId).emit('map-changed', {
        map: data.map,
        tacticsList: Object.keys(room.maps[data.map]),
        currentTactic: room.currentTactic
      });

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

  socket.on('get-objects-for-tactic', async (data) => {
    const { map, tactic } = data;
    const roomId = socket.roomId;
  
    if (roomId && map && tactic) {
      let room = await getRoom(roomId);
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
    } else {
      console.error('Запрос get-objects-for-tactic без необходимых параметров map или tactic.');
      socket.emit('tactic-objects', { map: map, tactic: tactic, objects: [] });
    }
  });
  
  socket.on('click-effect', (data) => {
    const roomId = socket.roomId;
    if (roomId) {
      socket.to(roomId).emit('click-effect', data);
    }
  });

  socket.on('hold-click-effect', (data) => {
    const roomId = socket.roomId;
    if (roomId) {
      socket.to(roomId).emit('hold-click-effect', data);
      socket.emit('hold-click-effect', data);
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

socket.on('add-vector', async (vectorObj) => {
  const roomId = socket.roomId;
  const map = socket.currentMap;
  if (roomId) {
    let room = await getRoom(roomId);
    if (room && room.maps[map]) {
      room.maps[map].objects.push(vectorObj);
      socket.to(roomId).emit('vector-added', vectorObj);

      try {
        await saveRoom(roomId, room);
        console.log(`[ROOM: ${roomId}] Вектор добавлен`);
      } catch (e) {
        console.error(`[ROOM: ${roomId}] Ошибка при сохранении вектора:`, e);
      }
    }
  }
});
  
  socket.on('disconnect', async () => {
    const roomId = socket.roomId;
    if (roomId) {
      await withRoomLock(roomId, async () => {
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
    });
    }
  });

socket.on('remove-object', async (data) => {
  const roomId = socket.roomId;
  const map = socket.currentMap;
  const tactic = socket.currentTactic;

  if (roomId && map && tactic) {
    await withRoomLock(roomId, async () => {
      let room = await getRoom(roomId);
      if (room && room.maps[map] && room.maps[map][tactic]) {
        const index = room.maps[map][tactic].findIndex(o => o.id === data.id);
        if (index !== -1) {
          room.maps[map][tactic].splice(index, 1);

          socket.to(roomId).emit('object-removed', { id: data.id });

          try {
            await saveRoom(roomId, room);
            console.log(`[ROOM: ${roomId}] Объект из тактики "${tactic}" карты "${map}" удалён, состояние сохранено в Redis`);
          } catch (e) {
            console.error(`[ROOM: ${roomId}] Ошибка при сохранении в Redis:`, e);
          }
        } else {
          console.log(`[ROOM: ${roomId}] Объект с id ${data.id} не найден для удаления в тактике "${tactic}" карты "${map}".`);
        }
      } else {
        console.error(`[ROOM: ${roomId}] Не найдена карта "${map}" или тактика "${tactic}" при попытке удалить объект.`);
      }
    });
  } else {
    console.error('Не указан roomId, currentMap или currentTactic при remove-object');
  }
});
  
socket.on('switch-tactic', async (data) => {
  const { mapName, tacticName } = data;
  const roomId = socket.roomId;
  const currentMap = socket.currentMap;

  if (roomId && mapName === currentMap) {
    await withRoomLock(roomId, async () => {
      let room = await getRoom(roomId);
      if (room && room.maps[mapName] && room.maps[mapName][tacticName]) {
        room.currentMap = mapName;
        room.currentTactic = tacticName;
        socket.currentTactic = tacticName;

        socket.to(roomId).emit('tactic-changed', { map: mapName, tactic: tacticName });

        socket.emit('tactic-changed', { map: mapName, tactic: tacticName });

        try {
          await saveRoom(roomId, room);
          console.log(`[ROOM: ${roomId}] Тактика изменена на ${tacticName} для карты ${mapName}`);
        } catch (e) {
          console.error(`[ROOM: ${roomId}] Ошибка при сохранении комнаты (switch-tactic):`, e);
        }
      }
    });
  }
});

socket.on('add-tactic', async (data) => {
  const { mapName, tacticName } = data;
  const roomId = socket.roomId;
  const currentMap = socket.currentMap;

  if (roomId && mapName === currentMap && isValidString(tacticName)) {
    await withRoomLock(roomId, async () => {
      let room = await getRoom(roomId);
      if (room && room.maps[mapName]) {
        if (!room.maps[mapName][tacticName]) {
          room.maps[mapName][tacticName] = [];
          room.currentTactic = tacticName;
          socket.currentTactic = tacticName;

          socket.to(roomId).emit('tactic-added', { map: mapName, tactic: tacticName, tacticsList: Object.keys(room.maps[mapName]) });
          socket.emit('tactic-added', { map: mapName, tactic: tacticName, tacticsList: Object.keys(room.maps[mapName]) });

          socket.to(roomId).emit('tactic-changed', { map: mapName, tactic: tacticName });
          socket.emit('tactic-changed', { map: mapName, tactic: tacticName });

          try {
            await saveRoom(roomId, room);
            console.log(`[ROOM: ${roomId}] Новая тактика ${tacticName} добавлена для карты ${mapName}`);
          } catch (e) {
            console.error(`[ROOM: ${roomId}] Ошибка при сохранении комнаты (add-tactic):`, e);
          }
        } else {
          socket.emit('tactic-error', { message: 'Тактика с таким именем уже существует.' });
        }
      }
    });
  } else {
    socket.emit('tactic-error', { message: 'Неверное имя тактики или карта.' });
  }
});

socket.on('remove-tactic', async (data) => {
  const { mapName, tacticName } = data;
  const roomId = socket.roomId;
  const currentMap = socket.currentMap;

  if (roomId && mapName === currentMap && tacticName) {
    await withRoomLock(roomId, async () => {
      let room = await getRoom(roomId);
      if (room && room.maps[mapName] && room.maps[mapName][tacticName]) {
        const tacticsList = Object.keys(room.maps[mapName]);
        if (tacticsList.length <= 1) {
          delete room.maps[mapName][tacticName];
          const newDefaultTactic = 'Тактика 1';
          room.maps[mapName][newDefaultTactic] = [];
          room.currentTactic = newDefaultTactic;
          socket.currentTactic = newDefaultTactic;
        } else {
          delete room.maps[mapName][tacticName];

          const remainingTactics = Object.keys(room.maps[mapName]);
          const newTactic = remainingTactics[0];
          room.currentTactic = newTactic;
          socket.currentTactic = newTactic;
        }

        socket.to(roomId).emit('tactic-removed', { map: mapName, tactic: tacticName, tacticsList: Object.keys(room.maps[mapName]), newTactic: room.currentTactic });
        socket.emit('tactic-removed', { map: mapName, tactic: tacticName, tacticsList: Object.keys(room.maps[mapName]), newTactic: room.currentTactic });

        socket.to(roomId).emit('tactic-changed', { map: mapName, tactic: room.currentTactic });
        socket.emit('tactic-changed', { map: mapName, tactic: room.currentTactic });

        try {
          await saveRoom(roomId, room);
          console.log(`[ROOM: ${roomId}] Тактика ${tacticName} удалена для карты ${mapName}`);
        } catch (e) {
          console.error(`[ROOM: ${roomId}] Ошибка при сохранении комнаты (remove-tactic):`, e);
        }
      }
    });
  }
});

function isValidString(str) {
  if (typeof str !== 'string' || str.length > 15) return false;
  return /^[a-zA-Zа-яА-ЯёЁ0-9 ]*$/.test(str);
}
  
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

async function migrateRoomsToNewTacticFormat() {
  console.log('=== Запуск миграции комнат к новому формату тактик ===');
  try {
    const roomKeys = await redisClient.keys('room:*');
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
