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

// === ПЕРЕМЕННЫЕ ДЛЯ ХРАНЕНИЯ ИНФОРМАЦИИ О КОМНАТЕ ===
let currentRoomId = null;
let currentUserName = null;

// === СПРАВОЧНИК КОРАБЛЕЙ С РАДИУСАМИ (в км) ===
const shipRadii = {
  'Des Moines': 10,
  'Salem': 8.5,
  'Worcester': 9,
  'Puerto Rico': 10,
  'Невский': 12,
  'Москва': 12,
  'Сталинград': 12,
  'Петропавловск': 12,
  'Minotaur': 10,
  'Plymouth': 9,
  'Tordenskjold': 10,
  'Changzheng': 12,
  'Huangdi': 12,
  'Yueyang': 7.5,
  'Ragnar': 7.5,
  'Gdansk': 9,
  'Smaland': 7.5,
  'Brisbane': 10,
  'San Martin': 9
};

// === РАЗМЕР КАРТ (в км) ===
const mapSizes = {
  'Греция.jpeg': 42,
  'Ледяные острова.png': 42,
  'Огненная земля.png': 48,
  'Петля.png': 48,
  'Путь воина.png': 48,
  'Север.png': 48,
  'Северные воды.jpeg': 42,
  'Зона крушения Альфа.png': 42
};

// === НОВАЯ АНИМАЦИЯ ===
const ripples = [];

class Ripple {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.radius = 0;
    this.maxRadius = 20;
    this.speed = 1.2;
    this.alpha = 1;
    this.decay = 0.03;
  }

  update() {
    this.radius += this.speed;
    this.alpha -= this.decay;
    return this.alpha > 0;
  }

  draw(ctx) {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 0, 0, ${this.alpha})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

// === ОБЪЕДИНЁННЫЙ requestAnimationFrame ===
function animate() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Рисуем фон
  if (bgLoaded) {
    ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height);
  }

  // Рисуем объекты
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

      // === РИСУЕМ ОКРУЖНОСТЬ, ЕСЛИ ПОДПИСЬ СОВПАДАЕТ ===
      if (obj.label && shipRadii[obj.label]) {
        const mapSizeKm = mapSizes[currentMap] || 42; // по умолчанию 42
        const radiusPx = (shipRadii[obj.label] / mapSizeKm) * canvas.width; // 900px = размер карты

        ctx.beginPath();
        ctx.arc(obj.x, obj.y, radiusPx, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 0, 0.5)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Рисуем подпись под кораблём
      if (obj.label) {
        ctx.font = '12px Arial';
        ctx.fillStyle = 'yellow';
        ctx.textAlign = 'center';
        ctx.fillText(obj.label, obj.x, obj.y + img.height / 2 + 15);
      }
    } else if (obj.type === 'note') {
      ctx.font = '14px Arial';
      ctx.fillStyle = 'rgba(255, 255, 200, 0.9)';
      ctx.fillRect(obj.x - 30, obj.y - 20, 100, 30);
      ctx.fillStyle = 'black';
      ctx.fillText(obj.text, obj.x - 25, obj.y);
    }
  });

  // Рисуем анимацию (волн)
  for (let i = ripples.length - 1; i >= 0; i--) {
    if (!ripples[i].update()) {
      ripples.splice(i, 1);
    } else {
      ripples[i].draw(ctx);
    }
  }

  requestAnimationFrame(animate);
}

// === ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ===
let bgImage = new Image();
let bgLoaded = false;
let shipImages = {};

// Запускаем анимацию один раз
animate();

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
function loadBackground(map) {
  bgImage = new Image();
  bgImage.src = `maps/${map}`;
  bgImage.onload = () => {
    bgLoaded = true;
  };
  bgImage.onerror = () => {
    console.error(`Ошибка загрузки фона: maps/${map}`);
  };
}

// Установка размера canvas
function resizeCanvas() {
  canvas.width = 600;
  canvas.height = 600;
}

joinBtn.onclick = () => {
  const roomId = roomIdInput.value.trim();
  const userName = userNameInput.value.trim() || 'User';
  if (!roomId) return;

  currentRoomId = roomId;
  currentUserName = userName;

  socket.emit('join-room', { roomId, userName });
  roomInput.style.display = 'none';
  canvasContainer.style.display = 'block';
  roomDisplay.textContent = roomId;
  resizeCanvas();
};

socket.on('room-data', (data) => {
  allObjects = {};
  allObjects[data.currentMap] = data.objects || [];
  currentMap = data.currentMap;
  objects = allObjects[currentMap];

  mapSelect.value = currentMap;
  loadBackground(currentMap);
  updateUsersList(data.users);
});

socket.on('object-added', (obj) => {
  objects.push(obj);
  allObjects[currentMap] = objects;
});

socket.on('object-updated', (data) => {
  const obj = objects.find(o => o.id === data.id);
  if (obj) {
    obj.x = data.x;
    obj.y = data.y;
    if (data.label !== undefined) obj.label = data.label;
    allObjects[currentMap] = objects;
  }
});

// === УДАЛЕНИЕ ОБЪЕКТА ===
socket.on('object-removed', (data) => {
  const index = objects.findIndex(o => o.id === data.id);
  if (index !== -1) {
    objects.splice(index, 1);
    allObjects[currentMap] = objects;
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

// Обработка кликов по canvas
let currentTool = null;

canvas.onclick = (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const id = Date.now() + Math.random();

  // === Добавляем анимацию локально ===
  ripples.push(new Ripple(x, y));

  // === Отправляем анимацию всем другим ===
  socket.emit('click-effect', { x, y });

  if (currentTool === 'note') {
    const text = prompt('Введите текст заметки:');
    if (!text) return;
    const obj = { id, type: 'note', x, y, text };
    objects.push(obj);
    allObjects[currentMap] = objects;
    socket.emit('add-object', obj);
  }
};

// Обработка получения анимации клика от других
socket.on('click-effect', (data) => {
  // === Добавляем анимацию от других ===
  ripples.push(new Ripple(data.x, data.y));
});

// === ОБРАБОТКА ПКМ (удаление) ===
canvas.oncontextmenu = (e) => {
  e.preventDefault(); // Отключаем контекстное меню
};

canvas.onmousedown = (e) => {
  if (e.button === 2) { // === ПКМ ===
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
        if (confirm('Удалить маркер?')) {
          socket.emit('remove-object', { id: obj.id });
          // Удаляем локально
          objects.splice(i, 1);
          allObjects[currentMap] = objects;
        }
        return;
      }
    }
  } else {
    // === ЛКМ (ранее) ===
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
  }
};

canvas.onmousemove = (e) => {
  if (!isDragging || !selectedObject) return;

  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  selectedObject.x = x + offsetX;
  selectedObject.y = y + offsetY;
};

canvas.onmouseup = () => {
  if (isDragging && selectedObject) {
    // === Добавляем анимацию при отпускании ===
    ripples.push(new Ripple(selectedObject.x, selectedObject.y));

    socket.emit('drag-end-effect', { x: selectedObject.x, y: selectedObject.y });

    socket.emit('update-object', { id: selectedObject.id, x: selectedObject.x, y: selectedObject.y });
  }
  isDragging = false;
  selectedObject = null;
  canvas.style.cursor = 'default';
};

// Обработка получения анимации drag-end от других
socket.on('drag-end-effect', (data) => {
  // === Добавляем анимацию от других ===
  ripples.push(new Ripple(data.x, data.y));
});

canvas.onmouseleave = () => {
  isDragging = false;
  selectedObject = null;
  canvas.style.cursor = 'default';
};

// Обработка **двойного клика** по кораблю
canvas.ondblclick = (e) => {
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
    }

    if (inBounds) {
      // Открываем поле ввода для подписи
      const newLabel = prompt('Введите подпись для корабля:', obj.label || '');
      if (newLabel !== null) {
        obj.label = newLabel;
        allObjects[currentMap] = objects;

        // Отправляем обновление подписи
        socket.emit('update-object', { id: obj.id, x: obj.x, y: obj.y, label: obj.label });
      }
      return;
    }
  }
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

  // === Добавляем анимацию локально ===
  ripples.push(new Ripple(x, y));

  // === Отправляем анимацию всем другим ===
  socket.emit('drop-effect', { x, y });

  const obj = { id, type, x, y, color, label: '' };
  objects.push(obj);
  allObjects[currentMap] = objects;
  socket.emit('add-object', obj);
});

// Обработка получения анимации drop от других
socket.on('drop-effect', (data) => {
  // === Добавляем анимацию от других ===
  ripples.push(new Ripple(data.x, data.y));
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
  allObjects[data.map] = data.objects || [];
  if (data.map === currentMap) {
    objects = allObjects[data.map];
    loadBackground(currentMap);
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
  }
});

// === ОБРАБОТКА RECONNECT / DISCONNECT ===
socket.on('reconnect', (attemptNumber) => {
  console.log('Соединение восстановлено, попытка:', attemptNumber);
  if (currentRoomId && currentUserName) {
    socket.emit('join-room', { roomId: currentRoomId, userName: currentUserName });
  }
});

socket.on('disconnect', (reason) => {
  console.log('Соединение потеряно:', reason);
});

// Установка размера canvas при загрузке
resizeCanvas();
window.onresize = resizeCanvas;

// === СОЗДАНИЕ ТАБЛИЦЫ СПРАВА ===
function createRadiusInfoTable() {
  // Создаём контейнер для таблицы
  const tableDiv = document.createElement('div');
  tableDiv.id = 'radius-info';
  tableDiv.style.position = 'absolute';
  tableDiv.style.top = '10px';
  tableDiv.style.right = '10px';
  tableDiv.style.background = 'rgba(0, 0, 0, 0.7)';
  tableDiv.style.color = 'white';
  tableDiv.style.padding = '10px';
  tableDiv.style.borderRadius = '5px';
  tableDiv.style.fontSize = '12px';
  tableDiv.style.width = '200px';
  tableDiv.style.zIndex = '10';
  tableDiv.style.fontFamily = 'Arial, sans-serif';

  // Заголовок
  const title = document.createElement('h4');
  title.textContent = 'Радиусы кораблей (км)';
  title.style.margin = '0 0 10px 0';
  title.style.color = 'yellow';
  title.style.fontSize = '13px';
  tableDiv.appendChild(title);

  // Таблица
  const table = document.createElement('table');
  table.id = 'radius-table';
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.fontSize = '11px';

  // Заголовки
  const headerRow = document.createElement('tr');
  const th1 = document.createElement('th');
  th1.textContent = 'Корабль';
  th1.style.textAlign = 'left';
  th1.style.padding = '2px';
  th1.style.color = 'yellow';
  const th2 = document.createElement('th');
  th2.textContent = 'Радиус';
  th2.style.textAlign = 'left';
  th2.style.padding = '2px';
  th2.style.color = 'yellow';
  headerRow.appendChild(th1);
  headerRow.appendChild(th2);
  table.appendChild(headerRow);

  // Данные
  for (const name in shipRadii) {
    const row = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.textContent = name;
    td1.style.padding = '2px';
    td1.style.borderBottom = '1px solid rgba(255, 255, 255, 0.2)';
    const td2 = document.createElement('td');
    td2.textContent = shipRadii[name];
    td2.style.padding = '2px';
    td2.style.borderBottom = '1px solid rgba(255, 255, 255, 0.2)';
    row.appendChild(td1);
    row.appendChild(td2);
    table.appendChild(row);
  }

  tableDiv.appendChild(table);

  // Добавляем в canvas-container
  const canvasWrapper = document.querySelector('#canvas-container');
  canvasWrapper.style.position = 'relative'; // Убедимся, что родитель позиционирован
  canvasWrapper.appendChild(tableDiv);
}

// Вызов при загрузке
createRadiusInfoTable();

// === ФУНКЦИЯ ДЛЯ ОТЛАДКИ ===
window.dumpAllObjects = () => {
  console.log('=== Состояние allObjects ===');
  console.log(allObjects);
  console.log('Текущая карта:', currentMap);
  console.log('Объекты на текущей карте:', objects);
  console.log('=====================================');
};



