const socket = io();

const roomInput = document.getElementById('room-input');
const roomIdInput = document.getElementById('room-id');
const userNameInput = document.getElementById('user-name');
const mapSelect = document.getElementById('map-select');
const joinBtn = document.getElementById('join-btn');
const canvasContainer = document.getElementById('canvas-container');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const roomDisplay = document.getElementById('room-id-display');
const usersList = document.getElementById('users-list');
const shipsPanel = document.getElementById('ships-panel');

let allObjects = {};
let currentMap = 'Греция.jpeg';
let objects = [];
let selectedObject = null;
let offsetX, offsetY;
let isDragging = false;

// Массив для хранения эффектов (кружков)
let effects = [];

// Флаг для оптимизации redraw
let redrawPending = false;

// Загрузка списка карт
socket.emit('get-available-maps');

socket.on('available-maps', (maps) => {
  mapSelect.innerHTML = '';
  maps.forEach(map => {
    const option = document.createElement('option');
    option.value = map;
    option.textContent = map;
    mapSelect.appendChild(option);
  });
  mapSelect.value = 'Греция.jpeg';
});

// Загрузка SVG-изображений кораблей
const shipImages = {};

['lk', 'kr', 'es'].forEach(type => {
  shipImages[type] = {};
  ['red', 'green'].forEach(color => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = `ships/${type}_${color}.svg`;
    img.onload = () => {
      if (img.width === 0 || img.height === 0) {
        img.width = 30;
        img.height = 30;
      }
    };
    img.onerror = () => {
      console.error(`Ошибка загрузки ${type}_${color}.svg`);
    };
    shipImages[type][color] = img;
  });
});

// Загрузка фона
let bgImage = new Image();
let bgLoaded = false;

function loadBackground(map) {
  bgImage = new Image();
  bgImage.src = `maps/${map}`;
  bgImage.onload = () => {
    bgLoaded = true;
    scheduleRedraw();
  };
  bgImage.onerror = () => {
    console.error(`Ошибка загрузки фона: maps/${map}`);
  };
}

// Установка размера canvas
function resizeCanvas() {
  canvas.width = 600;
  canvas.height = 600;
  scheduleRedraw();
}
window.onresize = resizeCanvas;

// Функция для планирования redraw
function scheduleRedraw() {
  if (!redrawPending) {
    redrawPending = true;
    requestAnimationFrame(() => {
      redraw();
      redrawPending = false;
    });
  }
}

joinBtn.onclick = () => {
  const roomId = roomIdInput.value.trim();
  const userName = userNameInput.value.trim() || 'User';
  if (!roomId) return;

  socket.emit('join-room', { roomId, userName });
  roomInput.style.display = 'none';
  canvasContainer.style.display = 'block';
  roomDisplay.textContent = roomId;
  resizeCanvas();
};

socket.on('room-data', (data) => {
  allObjects = {};
  allObjects[data.currentMap] = data.objects;
  currentMap = data.currentMap;
  objects = allObjects[currentMap];

  mapSelect.value = currentMap;
  loadBackground(currentMap);
  updateUsersList(data.users);
  scheduleRedraw();
});

socket.on('object-added', (obj) => {
  objects.push(obj);
  allObjects[currentMap] = objects;
  scheduleRedraw();
});

socket.on('object-updated', (data) => {
  const obj = objects.find(o => o.id === data.id);
  if (obj) {
    obj.x = data.x;
    obj.y = data.y;
    allObjects[currentMap] = objects;
    scheduleRedraw();
  }
});

socket.on('user-joined', (user) => {
  const li = document.createElement('li');
  li.id = `user-${user.id}`;
  li.textContent = user.name;
  usersList.appendChild(li);
});

socket.on('user-left', (userId) => {
  const li = document.getElementById(`user-${userId}`);
  if (li) li.remove();
});

function updateUsersList(users) {
  usersList.innerHTML = '';
  users.forEach(user => {
    const li = document.createElement('li');
    li.id = `user-${user.id}`;
    li.textContent = user.name;
    usersList.appendChild(li);
  });
}

// Рендер всех объектов и эффектов
function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!currentMap) {
    console.error('Карта не установлена');
    return;
  }

  if (bgLoaded) {
    ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height);
  }

  objects.forEach(obj => {
    if (obj.type.startsWith('l') || obj.type.startsWith('k') || obj.type === 'es') {
      const img = shipImages[obj.type][obj.color];
      if (!img) {
        console.error(`Изображение не найдено для ${obj.type}_${obj.color}`);
        return;
      }
      if (!img.complete) {
        console.warn(`Изображение ${obj.type}_${obj.color} ещё не загружено`);
        return;
      }
      ctx.drawImage(img, obj.x - img.width / 2, obj.y - img.height / 2);
    } else if (obj.type === 'note') {
      ctx.font = '14px Arial';
      ctx.fillStyle = 'rgba(255, 255, 200, 0.9)';
      ctx.fillRect(obj.x - 30, obj.y - 20, 100, 30);
      ctx.fillStyle = 'black';
      ctx.fillText(obj.text, obj.x - 25, obj.y);
    }
  });

  // Рисуем эффекты (кружки)
  effects.forEach((effect, index) => {
    const elapsed = Date.now() - effect.startTime;
    if (elapsed > effect.duration) {
      effects.splice(index, 1); // Удаляем, если время вышло
      return;
    }

    const progress = elapsed / effect.duration;
    const radius = effect.startRadius + (effect.maxRadius - effect.startRadius) * progress;
    const alpha = 1 - progress;

    ctx.beginPath();
    ctx.arc(effect.x, effect.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 0, 0, ${alpha})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}

// Обработка кликов по canvas
let currentTool = null;

canvas.onclick = (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const id = Date.now() + Math.random();

  // Добавляем эффект **локально**
  effects.push({
    x,
    y,
    startTime: Date.now(),
    duration: 800,
    startRadius: 0,
    maxRadius: 20
  });
  scheduleRedraw();

  // Отправляем событие анимации всем
  socket.emit('click-effect', { x, y });

  if (currentTool === 'note') {
    const text = prompt('Введите текст заметки:');
    if (!text) return;
    const obj = { id, type: 'note', x, y, text };
    objects.push(obj);
    allObjects[currentMap] = objects;
    scheduleRedraw();
    socket.emit('add-object', obj);
  }
};

// Обработка получения анимации клика от других
socket.on('click-effect', (data) => {
  effects.push({
    x: data.x,
    y: data.y,
    startTime: Date.now(),
    duration: 800,
    startRadius: 0,
    maxRadius: 20
  });
  scheduleRedraw();
});

// Обработка Drag & Drop объектов
canvas.onmousedown = (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    let inBounds = false;

    if (obj.type.startsWith('l') || obj.type.startsWith('k') || obj.type === 'es') {
      const img = shipImages[obj.type][obj.color];
      if (img && img.complete) {
        inBounds = x >= obj.x - img.width / 2 && x <= obj.x + img.width / 2 &&
                   y >= obj.y - img.height / 2 && y <= obj.y + img.height / 2;
      }
    } else if (obj.type === 'note') {
      inBounds = x >= obj.x - 30 && x <= obj.x + 70 && y >= obj.y - 20 && y <= obj.y + 10;
    }

    if (inBounds) {
      selectedObject = obj;
      offsetX = obj.x - x;
      offsetY = obj.y - y;
      isDragging = true;
      canvas.style.cursor = 'grabbing';
      break;
    }
  }
};

canvas.onmousemove = (e) => {
  if (!isDragging || !selectedObject) return;

  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  selectedObject.x = x + offsetX;
  selectedObject.y = y + offsetY;

  scheduleRedraw();
};

canvas.onmouseup = () => {
  if (isDragging && selectedObject) {
    // Добавляем эффект **локально**
    effects.push({
      x: selectedObject.x,
      y: selectedObject.y,
      startTime: Date.now(),
      duration: 800,
      startRadius: 0,
      maxRadius: 20
    });
    scheduleRedraw();

    // Отправляем анимацию при отпускании
    socket.emit('drag-end-effect', { x: selectedObject.x, y: selectedObject.y });

    socket.emit('update-object', { id: selectedObject.id, x: selectedObject.x, y: selectedObject.y });
  }
  isDragging = false;
  selectedObject = null;
  canvas.style.cursor = 'default';
};

// Обработка получения анимации drag-end от других
socket.on('drag-end-effect', (data) => {
  effects.push({
    x: data.x,
    y: data.y,
    startTime: Date.now(),
    duration: 800,
    startRadius: 0,
    maxRadius: 20
  });
  scheduleRedraw();
});

canvas.onmouseleave = () => {
  isDragging = false;
  selectedObject = null;
  canvas.style.cursor = 'default';
};

// Обработка перетаскивания корабля из панели
shipsPanel.addEventListener('dragstart', (e) => {
  const el = e.target.closest('.ship-item');
  if (!el) return;

  e.dataTransfer.setData('text/plain', JSON.stringify({
    type: el.dataset.type,
    color: el.dataset.color
  }));
});

canvas.addEventListener('dragover', (e) => {
  e.preventDefault();
});

canvas.addEventListener('drop', (e) => {
  e.preventDefault();

  const data = e.dataTransfer.getData('text/plain');
  if (!data) return;

  const { type, color } = JSON.parse(data);
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const id = Date.now() + Math.random();

  // Добавляем эффект **локально**
  effects.push({
    x,
    y,
    startTime: Date.now(),
    duration: 800,
    startRadius: 0,
    maxRadius: 20
  });
  scheduleRedraw();

  // Отправляем анимацию drop всем
  socket.emit('drop-effect', { x, y });

  const obj = { id, type, x, y, color };
  objects.push(obj);
  allObjects[currentMap] = objects;
  scheduleRedraw();
  socket.emit('add-object', obj);
});

// Обработка получения анимации drop от других
socket.on('drop-effect', (data) => {
  effects.push({
    x: data.x,
    y: data.y,
    startTime: Date.now(),
    duration: 800,
    startRadius: 0,
    maxRadius: 20
  });
  scheduleRedraw();
});

// Обработка смены карты
mapSelect.onchange = (e) => {
  const newMap = e.target.value;
  socket.emit('get-map-objects', { map: newMap });
  currentMap = newMap;
  socket.emit('change-map', { map: newMap });
};

// Обработка получения объектов для карты
socket.on('map-objects', (data) => {
  allObjects[data.map] = data.objects;
  if (data.map === currentMap) {
    objects = data.objects;
    loadBackground(currentMap);
    scheduleRedraw();
  }
});

// Обработка получения смены карты от других пользователей
socket.on('map-changed', (data) => {
  currentMap = data.map;
  mapSelect.value = currentMap;
  if (!allObjects[data.map]) {
    socket.emit('get-map-objects', { map: data.map });
  } else {
    objects = allObjects[data.map];
    loadBackground(currentMap);
    scheduleRedraw();
  }
});