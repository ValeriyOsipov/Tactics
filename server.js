const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/admin/dump-state', (req, res) => { res.json(rooms); });

// === НОВОЕ: файл для сохранения состояния ===
const STATE_FILE = './rooms-state.json';

// === Функция для загрузки состояния ===
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    const data = fs.readFileSync(STATE_FILE, 'utf8');
    try {
      return JSON.parse(data);
    } catch (e) {
      console.error('Ошибка при загрузке состояния:', e);
      return {};
    }
  }
  return {};
}

// === Функция для сохранения состояния ===
let saveTimeout = null;

function saveState() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = setTimeout(() => {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(rooms, null, 2));
      console.log('Состояние комнат сохранено');
    } catch (e) {
      console.error('Ошибка при сохранении состояния:', e);
    }
  }, 1000); // Сохраняем с задержкой 1 секунда
}

// === Загружаем состояние при запуске ===
let rooms = loadState();
console.log('Состояние комнат загружено');

// Список карт
const availableMaps = [
  'Греция.jpeg',
  'Ледяные острова.png',
  'Огненная земля.png',
  'Петля.png',
  'Путь воина.png',
  'Север.png',
  'Северные воды.jpeg'
];

io.on('connection', (socket) => {
  socket.on('get-available-maps', () => {
    socket.emit('available-maps', availableMaps);
  });

  socket.on('join-room', ({ roomId, userName }) => {
    socket.join(roomId);
    if (!rooms[roomId]) {
      rooms[roomId] = { maps: {}, users: {}, currentMap: 'Греция.jpeg' };
      console.log(`Комната создана: ${roomId}`);
    }
    if (!rooms[roomId].maps[rooms[roomId].currentMap]) {
      rooms[roomId].maps[rooms[roomId].currentMap] = { objects: [] };
    }

    rooms[roomId].users[socket.id] = { id: socket.id, name: userName || `User ${Object.keys(rooms[roomId].users).length + 1}` };

    socket.roomId = roomId;
    socket.currentMap = rooms[roomId].currentMap;

    console.log(`Пользователь ${socket.id} зашёл в комнату ${roomId}`);

    socket.to(roomId).emit('user-joined', rooms[roomId].users[socket.id]);
    socket.emit('room-data', {
      objects: rooms[roomId].maps[rooms[roomId].currentMap].objects,
      currentMap: rooms[roomId].currentMap,
      users: Object.values(rooms[roomId].users)
    });

    saveState(); // Сохраняем при входе
  });

  socket.on('add-object', (data) => {
    const roomId = socket.roomId;
    const map = socket.currentMap;
    if (roomId && rooms[roomId] && rooms[roomId].maps[map]) {
      rooms[roomId].maps[map].objects.push(data);
      socket.to(roomId).emit('object-added', data);
      saveState(); // Сохраняем при добавлении
    }
  });

  socket.on('update-object', (data) => {
    const roomId = socket.roomId;
    const map = socket.currentMap;
    if (rooms[roomId] && rooms[roomId].maps[map]) {
      const obj = rooms[roomId].maps[map].objects.find(o => o.id === data.id);
      if (obj) {
        obj.x = data.x;
        obj.y = data.y;
        if (data.label !== undefined) obj.label = data.label;
        socket.to(roomId).emit('object-updated', data);
        saveState(); // Сохраняем при обновлении
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
      socket.currentMap = data.map;
      socket.emit('map-changed', data);
      socket.to(roomId).emit('map-changed', data);
      saveState(); // Сохраняем при смене карты
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

      // Если в комнате больше нет пользователей, можно удалить комнату
      if (Object.keys(rooms[roomId].users).length === 0) {
        delete rooms[roomId];
        console.log(`Комната ${roomId} удалена (пустая)`);
      }

      saveState(); // Сохраняем при выходе
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// === Сохраняем состояние при завершении работы ===
process.on('SIGINT', () => {
  console.log('Сохраняем состояние перед завершением...');
  saveState();
  process.exit(0);
});
