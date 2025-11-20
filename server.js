const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/admin/dump-state', (req, res) => {
  res.json(rooms);
});

const rooms = {};

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
  });

  socket.on('add-object', (data) => {
    const roomId = socket.roomId;
    const map = socket.currentMap;
    if (roomId && rooms[roomId] && rooms[roomId].maps[map]) {
      rooms[roomId].maps[map].objects.push(data);
      socket.to(roomId).emit('object-added', data);
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
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

});
