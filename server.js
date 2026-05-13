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

redisClient.on('error', (err) => {
  console.error('Redis Client Error', err);
});

const redlock = new Redlock([redisClient], {
  driftFactor: 0.01,
  retryCount: 3, // Количество попыток
  retryDelay: 200, // Задержка между попытками в мс
  retryJitter: 200 // Добавить случайности к задержке
});

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
  'Фарерские острова.png'
];

io.on('connection', (socket) => {
  console.log('Подключение клиента:', socket.id);

  socket.on('get-available-maps', () => {
    socket.emit('available-maps', availableMaps);
  });

  // --- JOIN ROOM ---
  socket.on('join-room', async ({ roomId, userName, userId, password }) => {
    // <<< НЕ ОБОРАЧИВАЕМ socket.join В withRoomLock >>>
    socket.join(roomId);

    try {
      await withRoomLock(roomId, async () => {
        let room = await getRoom(roomId);

        if (!room) {
          room = { maps: {}, users: {}, currentMap: 'Греция.png', currentTactic: 'Тактика 1', password: password || '' };
          room.maps[room.currentMap] = { [room.currentTactic]: [] };
          console.log(`[ROOM: ${roomId}] Комната создана`);
        } else {
          if (room.password && room.password !== password) {
            socket.emit('wrong-password');
            return; // <<< ВАЖНО: ВЫХОДИМ, НЕ СОХРАНЯЯ >>>
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

        if (room.users[userId]) {
            console.log(`[ROOM: ${roomId}] ВНИМАНИЕ: Пользователь ${userId} (${room.users[userId].name}) уже существует в списке. Возможно, предыдущий вход не был корректно завершён. Обновляем socket.id и имя.`);
            room.users[userId].socketId = socket.id;
            if (room.users[userId].name !== userName) {
                console.log(`[ROOM: ${roomId}] Имя пользователя ${userId} изменилось с "${room.users[userId].name}" на "${userName}".`);
                room.users[userId].name = userName;
            }
        } else {
            console.log(`[ROOM: ${roomId}] Новый пользователь ${userId} (${userName}) зашёл в комнату.`);
            room.users[userId] = { id: userId, name: userName, socketId: socket.id };
        }

        socket.userId = userId;
        socket.currentTactic = currentTactic;
        socket.roomId = roomId;
        socket.currentMap = currentMap;

        console.log(`Пользователь ${userId} (${userName}) зашёл в комнату ${roomId}`);

        socket.emit('room-data', {
          objects: room.maps[currentMap][currentTactic],
          currentMap: currentMap,
          currentTactic: currentTactic,
          tacticsForCurrentMap: Object.keys(room.maps[currentMap]),
          users: Object.values(room.users)
        });

        socket.to(roomId).emit('user-joined', room.users[userId]);

        try {
          await saveRoom(roomId, room);
          console.log(`[ROOM: ${roomId}] Состояние комнаты сохранено в Redis (join-room)`);
        } catch (e) {
          console.error(`[ROOM: ${roomId}] Ошибка при сохранении состояния в Redis (join-room):`, e);
        }
      });
    } catch (lockErr) {
      // <<< ОБРАБОТКА ОШИБКИ БЛОКИРОВКИ В join-room >>>
      if (lockErr.name === 'LockError') {
        console.error(`[JOIN-ROOM] Не удалось получить блокировку для комнаты ${roomId} при входе:`, lockErr.message);
        socket.emit('error', { message: 'Комната временно заблокирована, попробуйте войти позже.' });
      } else {
        console.error(`[JOIN-ROOM] Неожиданная ошибка при входе в комнату ${roomId}:`, lockErr);
        socket.emit('error', { message: 'Произошла ошибка на сервере при входе в комнату.' });
      }
    }
  });

  // --- ADD OBJECT ---
  socket.on('add-object', async (data) => {
    const roomId = socket.roomId;
    const map = socket.currentMap;
    const tactic = socket.currentTactic;

    if (roomId && map && tactic) {
      try {
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
      } catch (lockErr) {
        if (lockErr.name === 'LockError') {
          console.error(`[ADD-OBJECT] Не удалось получить блокировку для комнаты ${roomId}:`, lockErr.message);
          socket.emit('error', { message: 'Комната временно заблокирована, попробуйте позже.' });
        } else {
          console.error(`[ROOM: ${roomId}] Ошибка в обработчике add-object:`, lockErr);
          socket.emit('error', { message: 'Произошла ошибка на сервере при добавлении объекта.' });
        }
      }
    } else {
      console.error('Не указан roomId, currentMap или currentTactic при add-object');
    }
  });

  // --- UPDATE OBJECT ---
  socket.on('update-object', async (data) => {
    const roomId = socket.roomId;
    const map = socket.currentMap;
    const tactic = socket.currentTactic;

    if (roomId && map && tactic) {
      try {
        await withRoomLock(roomId, async () => {
          let room = await getRoom(roomId);
          if (room && room.maps[map] && room.maps[map][tactic]) {
            const obj = room.maps[map][tactic].find(o => o.id === data.id);
            if (obj) {
              let oldX = obj.x;
              let oldY = obj.y;

              if (data.x !== undefined) obj.x = data.x;
              if (data.y !== undefined) obj.y = data.y;

              if (data.label !== undefined) obj.label = data.label;
              if (data.rotation !== undefined) obj.rotation = data.rotation;

              if (data.startX !== undefined) obj.startX = data.startX;
              if (data.startY !== undefined) obj.startY = data.startY;
              if (data.endX !== undefined) obj.endX = data.endX;
              if (data.endY !== undefined) obj.endY = data.endY;

              const isShip = (obj.type.startsWith('l') || obj.type.startsWith('k') || obj.type === 'es');
              let circlesToUpdate = [];
              if (isShip && (oldX !== obj.x || oldY !== obj.y)) {
                room.maps[map][tactic].forEach(otherObj => {
                  if (otherObj.type.startsWith('custom-circle-') && otherObj.parentId === obj.id) {
                    otherObj.x = obj.x;
                    otherObj.y = obj.y;
                    circlesToUpdate.push(otherObj);
                  }
                });
              }

              io.to(roomId).emit('object-updated', data);

              circlesToUpdate.forEach(updatedCircle => {
                io.to(roomId).emit('object-updated', { id: updatedCircle.id, x: updatedCircle.x, y: updatedCircle.y });
              });

              try {
                await saveRoom(roomId, room);
                console.log(`[ROOM: ${roomId}] Объект и его окружности обновлены, состояние комнаты сохранено в Redis (update-object)`);
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
      } catch (lockErr) {
        if (lockErr.name === 'LockError') {
          console.error(`[UPDATE-OBJECT] Не удалось получить блокировку для комнаты ${roomId}:`, lockErr.message);
          socket.emit('error', { message: 'Комната временно заблокирована, попробуйте позже.' });
        } else {
          console.error(`[ROOM: ${roomId}] Ошибка в обработчике update-object:`, lockErr);
          socket.emit('error', { message: 'Произошла ошибка на сервере при обновлении объекта.' });
        }
      }
    } else {
      console.error('Не указан roomId, currentMap или currentTactic при update-object');
    }
  });

  // --- CHANGE MAP ---
  socket.on('change-map', async (data) => {
    const roomId = socket.roomId;
    if (roomId) {
      console.log(`[ROOM: ${roomId}] Смена карты на: ${data.map}`);
      try {
        await withRoomLock(roomId, async () => {
          let room = await getRoom(roomId);
          if (room) {
            if (!room.maps[data.map]) {
              room.maps[data.map] = { 'Тактика 1': [] };
              console.log(`[ROOM: ${roomId}] Карта "${data.map}" инициализирована с тактикой "Тактика 1"`);
            } else {
              if (Object.keys(room.maps[data.map]).length === 0) {
                room.maps[data.map]['Тактика 1'] = [];
                console.log(`[ROOM: ${roomId}] Карта "${data.map}" пуста, добавлена "Тактика 1"`);
              }
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

            try {
              await saveRoom(roomId, room);
              console.log(`[ROOM: ${roomId}] Состояние комнаты сохранено в Redis (change-map)`);
            } catch (e) {
              console.error(`[ROOM: ${roomId}] Ошибка при сохранении состояния в Redis (change-map):`, e);
            }
          }
        });
      } catch (lockErr) {
        if (lockErr.name === 'LockError') {
          console.error(`[CHANGE-MAP] Не удалось получить блокировку для комнаты ${roomId}:`, lockErr.message);
          // socket.to(roomId).emit('error', ...); // Не отправляем всем, т.к. это связано с конкретным сокетом
          socket.emit('error', { message: 'Комната временно заблокирована, невозможно сменить карту.' });
        } else {
          console.error(`[ROOM: ${roomId}] Ошибка в обработчике change-map:`, lockErr);
          socket.emit('error', { message: 'Произошла ошибка на сервере при смене карты.' });
        }
      }
    }
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

  // --- ADD VECTOR ---
  socket.on('add-vector', async (vectorObj) => {
    const roomId = socket.roomId;
    const map = socket.currentMap;
    const tactic = socket.currentTactic;

    if (roomId && map && tactic) {
      try {
        await withRoomLock(roomId, async () => {
          let room = await getRoom(roomId);
          if (room && room.maps[map] && room.maps[map][tactic]) {
            room.maps[map][tactic].push(vectorObj);
            socket.to(roomId).emit('vector-added', vectorObj);

            try {
              await saveRoom(roomId, room);
              console.log(`[ROOM: ${roomId}] Вектор добавлен в тактику "${tactic}" карты "${map}"`);
            } catch (e) {
              console.error(`[ROOM: ${roomId}] Ошибка при сохранении вектора:`, e);
            }
          } else {
            console.error(`[ROOM: ${roomId}] add-vector: Карта "${map}" или тактика "${tactic}" не найдены для сокета.`, room?.maps[map]);
          }
        });
      } catch (lockErr) {
        if (lockErr.name === 'LockError') {
          console.error(`[ADD-VECTOR] Не удалось получить блокировку для комнаты ${roomId}:`, lockErr.message);
          socket.emit('error', { message: 'Комната временно заблокирована, попробуйте позже.' });
        } else {
          console.error(`[ROOM: ${roomId}] Ошибка в обработчике add-vector:`, lockErr);
          socket.emit('error', { message: 'Произошла ошибка на сервере при добавлении вектора.' });
        }
      }
    } else {
      console.error('add-vector: Отсутствует roomId, currentMap или currentTactic у сокета.');
    }
  });

  // --- DISCONNECT ---
  socket.on('disconnect', async (reason) => {
    const roomId = socket.roomId;
    const userId = socket.userId;
    const socketId = socket.id;
    if (roomId) {
      console.log(`[ROOM: ${roomId}] Пользователь ${socket.id} отключился, причина: ${reason}`);
      console.log(`[DISCONNECT] socket.userId = ${userId}`); // <<< Лог для отладки >>>
    try {
      await withRoomLock(roomId, async () => {
        let room = await getRoom(roomId);
        if (room && userId && room.users[userId]) {
          if (room.users[userId].socketId === socketId) {
            console.log(`[ROOM: ${roomId}] Удаляем запись пользователя ${userId} из room.users.`);
            delete room.users[userId];
          } else {
            console.warn(`[ROOM: ${roomId}] socketId ${socketId} не совпадает с привязанным у пользователя ${userId}. Ожидалось: ${room.users[userId].socketId}. Удаление записи отменено.`);

          }

          io.to(roomId).emit('user-left', userId)

          console.log(`Пользователь ${userId} с socketId ${socketId} покинул комнату ${roomId} (локально).`);

          try {
            await saveRoom(roomId, room);
            console.log(`[ROOM: ${roomId}] Состояние комнаты сохранено в Redis (disconnect)`);
          } catch (e) {
            console.error(`[ROOM: ${roomId}] Ошибка при сохранении состояния в Redis (disconnect):`, e);
          }
        } else {
            console.log(`[ROOM: ${roomId}] Пользователь ${userId || 'unknown'} не найден в room.users при отключении socketId ${socketId}.`);
            // Возможен дубль или ошибка.
        }
      });
      } catch (lockErr) {
        // <<< ОШИБКА БЛОКИРОВКИ ПРИ ОТКЛЮЧЕНИИ >>>
        if (lockErr.name === 'LockError') {
          console.error(`[DISCONNECT] Не удалось получить блокировку для комнаты ${roomId} при отключении:`, lockErr.message);
          // socket.to(roomId).emit('error', ...); // Смысл отправлять ошибку пользователю, который уже отключился?
          // Лучше просто залогировать
        } else {
          console.error(`[ROOM: ${roomId}] Ошибка в обработчике disconnect:`, lockErr);
        }
      }
    } else {
        console.log(`Пользователь ${socket.id} отключился без комнаты.`);
    }
  });
      
  // --- ADD CUSTOM CIRCLE ---
  socket.on('add-custom-circle', async (circleObj) => {
    const roomId = socket.roomId;
    const map = socket.currentMap;
    const tactic = socket.currentTactic;

    if (roomId && map && tactic) {
      try {
        await withRoomLock(roomId, async () => {
          let room = await getRoom(roomId);
          if (room && room.maps[map] && room.maps[map][tactic]) {
            room.maps[map][tactic].push(circleObj);
            io.to(roomId).emit('object-added', circleObj);
            console.log(`[ROOM: ${roomId}] Кастомная окружность добавлена в тактику "${tactic}" карты "${map}"`);

            try {
              await saveRoom(roomId, room);
            } catch (e) {
              console.error(`[ROOM: ${roomId}] Ошибка при сохранении комнаты (add-custom-circle):`, e);
            }
          }
        });
      } catch (lockErr) {
        if (lockErr.name === 'LockError') {
          console.error(`[ADD-CUSTOM-CIRCLE] Не удалось получить блокировку для комнаты ${roomId}:`, lockErr.message);
          socket.emit('error', { message: 'Комната временно заблокирована, попробуйте позже.' });
        } else {
          console.error(`[ROOM: ${roomId}] Ошибка в обработчике add-custom-circle:`, lockErr);
          socket.emit('error', { message: 'Произошла ошибка на сервере при добавлении окружности.' });
        }
      }
    }
  });

  // --- REMOVE ALL CUSTOM CIRCLES ---
  socket.on('remove-all-custom-circles', async (data) => {
    const { parentId } = data;
    const roomId = socket.roomId;
    const map = socket.currentMap;
    const tactic = socket.currentTactic;

    if (roomId && map && tactic && parentId) {
      try {
        await withRoomLock(roomId, async () => {
          let room = await getRoom(roomId);
          if (room && room.maps[map] && room.maps[map][tactic]) {
            const circlesToRemove = room.maps[map][tactic].filter(obj => obj.type.startsWith('custom-circle-') && obj.parentId === parentId);
            room.maps[map][tactic] = room.maps[map][tactic].filter(obj => !(obj.type.startsWith('custom-circle-') && obj.parentId === parentId));

            circlesToRemove.forEach(circle => {
              io.to(roomId).emit('object-removed', { id: circle.id });
            });

            console.log(`[ROOM: ${roomId}] Удалено ${circlesToRemove.length} кастомных окружностей с корабля ${parentId} в тактике "${tactic}" карты "${map}"`);

            try {
              await saveRoom(roomId, room);
            } catch (e) {
              console.error(`[ROOM: ${roomId}] Ошибка при сохранении комнаты (remove-all-custom-circles):`, e);
            }
          }
        });
      } catch (lockErr) {
        if (lockErr.name === 'LockError') {
          console.error(`[REMOVE-ALL-CUSTOM-CIRCLES] Не удалось получить блокировку для комнаты ${roomId}:`, lockErr.message);
          socket.emit('error', { message: 'Комната временно заблокирована, попробуйте позже.' });
        } else {
          console.error(`[ROOM: ${roomId}] Ошибка в обработчике remove-all-custom-circles:`, lockErr);
          socket.emit('error', { message: 'Произошла ошибка на сервере при удалении окружностей.' });
        }
      }
    }
  });

  // --- REMOVE OBJECT ---
  socket.on('remove-object', async (data) => {
    const { id: objectIdToRemove } = data;
    const roomId = socket.roomId;
    const map = socket.currentMap;
    const tactic = socket.currentTactic;

    if (roomId && map && tactic && objectIdToRemove) {
      try {
        await withRoomLock(roomId, async () => {
          let room = await getRoom(roomId);
          if (room && room.maps[map] && room.maps[map][tactic]) {
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

                console.log(`[ROOM: ${roomId}] Удалён корабль ${objToRemove.id} и ${circlesToRemove.length} привязанных к нему кастомных окружностей.`);
              } else {
                console.log(`[ROOM: ${roomId}] Удалён объект ${objToRemove.id}.`);
              }

              io.to(roomId).emit('object-removed', { id: objToRemove.id });

              circlesToRemove.forEach(circle => {
                io.to(roomId).emit('object-removed', { id: circle.id });
              });

              try {
                await saveRoom(roomId, room);
                console.log(`[ROOM: ${roomId}] Объект и его окружности удалены, состояние сохранено в Redis`);
              } catch (e) {
                console.error(`[ROOM: ${roomId}] Ошибка при сохранении в Redis:`, e);
              }
            } else {
              console.log(`[ROOM: ${roomId}] Объект с id ${objectIdToRemove} не найден для удаления в тактике "${tactic}" карты "${map}".`);
            }
          } else {
            console.error(`[ROOM: ${roomId}] Не найдена карта "${map}" или тактика "${tactic}" при попытке удалить объект.`);
          }
        });
      } catch (lockErr) {
        if (lockErr.name === 'LockError') {
          console.error(`[REMOVE-OBJECT] Не удалось получить блокировку для комнаты ${roomId}:`, lockErr.message);
          socket.emit('error', { message: 'Комната временно заблокирована, попробуйте позже.' });
        } else {
          console.error(`[ROOM: ${roomId}] Ошибка в обработчике remove-object:`, lockErr);
          socket.emit('error', { message: 'Произошла ошибка на сервере при удалении объекта.' });
        }
      }
    } else {
      console.error('remove-object: Отсутствует roomId, currentMap, currentTactic или id удаляемого объекта.');
    }
  });

  // --- SWITCH TACTIC ---
  socket.on('switch-tactic', async (data) => {
    const { mapName, tacticName } = data;
    const roomId = socket.roomId;
    const currentMap = socket.currentMap;

    if (roomId && mapName === currentMap) {
      try {
        await withRoomLock(roomId, async () => {
          let room = await getRoom(roomId);
          if (room && room.maps[mapName] && room.maps[mapName][tacticName]) {
            room.currentTactic = tacticName;

            const socketsInRoom = await io.in(roomId).fetchSockets();
            for (const sock of socketsInRoom) {
              sock.currentTactic = tacticName;
            }

            io.to(roomId).emit('tactic-changed', { map: mapName, tactic: tacticName });

            try {
              await saveRoom(roomId, room);
              console.log(`[ROOM: ${roomId}] Тактика изменена на ${tacticName} для карты ${mapName}, socket.currentTactic обновлён у всех.`);
            } catch (e) {
              console.error(`[ROOM: ${roomId}] Ошибка при сохранении комнаты (switch-tactic):`, e);
            }
          } else {
            console.error(`[ROOM: ${roomId}] switch-tactic: Карта "${mapName}" или тактика "${tacticName}" не найдены в данных комнаты.`, room?.maps[mapName]);
          }
        });
      } catch (lockErr) {
        if (lockErr.name === 'LockError') {
          console.error(`[SWITCH-TACTIC] Не удалось получить блокировку для комнаты ${roomId}:`, lockErr.message);
          socket.emit('error', { message: 'Комната временно заблокирована, невозможно переключить тактику.' });
        } else {
          console.error(`[ROOM: ${roomId}] Ошибка в обработчике switch-tactic:`, lockErr);
          socket.emit('error', { message: 'Произошла ошибка на сервере при переключении тактики.' });
        }
      }
    } else {
      console.error(`[ROOM: ${roomId}] switch-tactic: Карта в данных (${mapName}) не совпадает с текущей картой сокета (${socket.currentMap}) или roomId отсутствует.`);
    }
  });

  // --- ADD TACTIC ---
  socket.on('add-tactic', async (data) => {
    const { mapName, tacticName } = data;
    const roomId = socket.roomId;
    const currentMap = socket.currentMap;

    if (roomId && mapName === currentMap && isValidString(tacticName)) {
      try {
        await withRoomLock(roomId, async () => {
          let room = await getRoom(roomId);
          if (room && room.maps[mapName]) {
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

              try {
                await saveRoom(roomId, room);
                console.log(`[ROOM: ${roomId}] Новая тактика ${tacticName} добавлена для карты ${mapName}, currentTactic обновлён у всех.`);
              } catch (e) {
                console.error(`[ROOM: ${roomId}] Ошибка при сохранении комнаты (add-tactic):`, e);
              }
            } else {
              socket.emit('tactic-error', { message: 'Тактика с таким именем уже существует.' });
            }
          }
        });
      } catch (lockErr) {
        if (lockErr.name === 'LockError') {
          console.error(`[ADD-TACTIC] Не удалось получить блокировку для комнаты ${roomId}:`, lockErr.message);
          socket.emit('tactic-error', { message: 'Комната временно заблокирована, невозможно добавить тактику.' });
        } else {
          console.error(`[ROOM: ${roomId}] Ошибка в обработчике add-tactic:`, lockErr);
          socket.emit('tactic-error', { message: 'Произошла ошибка на сервере при добавлении тактики.' });
        }
      }
    } else {
      socket.emit('tactic-error', { message: 'Неверное имя тактики или карта.' });
    }
  });

  // --- REMOVE TACTIC ---
  socket.on('remove-tactic', async (data) => {
    const { mapName, tacticName } = data;
    const roomId = socket.roomId;
    const currentMap = socket.currentMap;

    if (roomId && mapName === currentMap && tacticName) {
      try {
        await withRoomLock(roomId, async () => {
          let room = await getRoom(roomId);
          if (room && room.maps[mapName] && room.maps[mapName][tacticName]) {
            const tacticsList = Object.keys(room.maps[mapName]);
            let newTactic;

            if (tacticsList.length <= 1) {
              console.log(`[ROOM: ${roomId}] Удаление последней тактики "${tacticName}". Создаём и переключаемся на 'Тактика 1'.`);
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

            try {
              await saveRoom(roomId, room);
              if (tacticsList.length <= 1) {
                console.log(`[ROOM: ${roomId}] Последняя тактика "${tacticName}" заменена на "${newTactic}", currentTactic обновлён у всех.`);
              } else {
                console.log(`[ROOM: ${roomId}] Тактика "${tacticName}" удалена для карты ${mapName}, currentTactic обновлён у всех на '${newTactic}'.`);
              }
            } catch (e) {
              console.error(`[ROOM: ${roomId}] Ошибка при сохранении комнаты (remove-tactic):`, e);
            }
          } else {
            console.error(`[ROOM: ${roomId}] remove-tactic: Карта "${mapName}" или тактика "${tacticName}" не найдены в данных комнаты.`, room?.maps[mapName]);
          }
        });
      } catch (lockErr) {
        if (lockErr.name === 'LockError') {
          console.error(`[REMOVE-TACTIC] Не удалось получить блокировку для комнаты ${roomId}:`, lockErr.message);
          socket.emit('tactic-error', { message: 'Комната временно заблокирована, невозможно удалить тактику.' });
        } else {
          console.error(`[ROOM: ${roomId}] Ошибка в обработчике remove-tactic:`, lockErr);
          socket.emit('tactic-error', { message: 'Произошла ошибка на сервере при удалении тактики.' });
        }
      }
    }
  });

});

function isValidString(str) {
  if (typeof str !== 'string' || str.length > 15) return false;
  return /^[a-zA-Zа-яА-ЯёЁ0-9 ]*$/.test(str);
}

// --- PING ENDPOINT ---
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

// --- MIGRATION AND STARTUP ---
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
