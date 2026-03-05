const socket = io({
  transports: ['websocket'],
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: Infinity,
  timeout: 20000
});

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
let currentMap = 'Греция.png';
let objects = [];
let selectedObject = null;
let offsetX, offsetY;
let isDragging = false;

let currentRoomId = null;
let currentUserName = null;
let currentPassword = null;

let draggedObj = null;

let drawingVector = false;
let vectorType = null;
let vectorStartPoint = null;
let tempVectorEnd = null;

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
  'Brisbane': 12,
  'San Martin': 9
};

const mapSizes = {
  'Греция.png': 42,
  'Ледяные острова.png': 42,
  'Огненная земля.png': 48,
  'Петля.png': 48,
  'Путь воина.png': 48,
  'Север.png': 48,
  'Северные воды.jpeg': 42,
  'Зона крушения Альфа.png': 42
};

function isValidString(str) {
  if (str.length > 15) return false;
  return /^[a-zA-Zа-яА-ЯёЁ0-9 ]*$/.test(str);
}

joinBtn.onclick = () => {
  const roomId = roomIdInput.value.trim();
  const userName = userNameInput.value.trim() || 'User';
  const password = document.getElementById('room-password').value;

  if (!roomId) {
    alert('Введите название комнаты.');
    return;
  }

  if (!isValidString(roomId)) {
    alert('Название комнаты должно содержать только латиницу, кириллицу, цифры и быть не длиннее 15 символов.');
    return;
  }

  if (!isValidString(userName)) {
    alert('Имя должно содержать только латиницу, кириллицу, цифры и быть не длиннее 15 символов.');
    return;
  }

  if (password && !isValidString(password)) {
    alert('Пароль должен содержать только латиницу, кириллицу, цифры и быть не длиннее 15 символов.');
    return;
  }

  currentRoomId = roomId;
  currentUserName = userName;
  currentPassword = password;
  
  socket.emit('join-room', { roomId, userName, password });
  roomInput.style.display = 'none';
  canvasContainer.style.display = 'block';
  roomDisplay.textContent = roomId;
  resizeCanvas();
};

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

function drawObjects() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

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

      ctx.save();
      ctx.translate(obj.x, obj.y);

      if (obj.rotation !== undefined && obj.rotation !== 0) {
        const angle = obj.rotation * Math.PI / 4;
        ctx.rotate(angle);
      }

      ctx.drawImage(img, -img.width / 2, -img.height / 2);

      if (obj.label && shipRadii[obj.label]) {
        const mapSizeKm = mapSizes[currentMap] || 42;
        const radiusPx = (shipRadii[obj.label] / mapSizeKm) * canvas.width;

        ctx.beginPath();
        ctx.arc(0, 0, radiusPx, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 0, 0.5)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      if (obj.label) {
        ctx.restore();
        ctx.font = '12px Arial';
        ctx.fillStyle = 'yellow';
        ctx.textAlign = 'center';
        ctx.fillText(obj.label, obj.x, obj.y + img.height / 2 + 15);
      } else {
        ctx.restore();
      }
    } else if (obj.type === 'note') {
      ctx.font = '14px Arial';
      ctx.fillStyle = 'rgba(255, 255, 200, 0.9)';
      ctx.fillRect(obj.x - 30, obj.y - 20, 100, 30);
      ctx.fillStyle = 'black';
      ctx.fillText(obj.text, obj.x - 25, obj.y);
    } else if (obj.type.startsWith('vector-')) {
      ctx.beginPath();
      ctx.moveTo(obj.startX, obj.startY);
      ctx.lineTo(obj.endX, obj.endY);

      if (obj.type === 'vector-red') {
        ctx.strokeStyle = 'red';
      } else if (obj.type === 'vector-green') {
        ctx.strokeStyle = 'green';
      }

      ctx.lineWidth = 2;
      ctx.stroke();

      const angle = Math.atan2(obj.endY - obj.startY, obj.endX - obj.startX);
      const arrowLength = 10;
      const arrowAngle = Math.PI / 6;

      ctx.beginPath();

      ctx.moveTo(obj.endX, obj.endY);
      ctx.lineTo(
        obj.endX - arrowLength * Math.cos(angle - arrowAngle),
        obj.endY - arrowLength * Math.sin(angle - arrowAngle)
      );

      ctx.moveTo(obj.endX, obj.endY);
      ctx.lineTo(
        obj.endX - arrowLength * Math.cos(angle + arrowAngle),
        obj.endY - arrowLength * Math.sin(angle + arrowAngle)
      );

      ctx.strokeStyle = ctx.strokeStyle;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  });

  if (drawingVector && vectorStartPoint && tempVectorEnd) {
    ctx.beginPath();
    ctx.moveTo(vectorStartPoint.x, vectorStartPoint.y);
    ctx.lineTo(tempVectorEnd.x, tempVectorEnd.y);

    if (vectorType === 'vector-red') {
      ctx.strokeStyle = 'red';
    } else if (vectorType === 'vector-green') {
      ctx.strokeStyle = 'green';
    }

    ctx.lineWidth = 2;
    ctx.stroke();

    const angle = Math.atan2(tempVectorEnd.y - vectorStartPoint.y, tempVectorEnd.x - vectorStartPoint.x);
    const arrowLength = 10;
    const arrowAngle = Math.PI / 6;

    ctx.beginPath();

    ctx.moveTo(tempVectorEnd.x, tempVectorEnd.y);
    ctx.lineTo(
      tempVectorEnd.x - arrowLength * Math.cos(angle - arrowAngle),
      tempVectorEnd.y - arrowLength * Math.sin(angle - arrowAngle)
    );

    ctx.moveTo(tempVectorEnd.x, tempVectorEnd.y);
    ctx.lineTo(
      tempVectorEnd.x - arrowLength * Math.cos(angle + arrowAngle),
      tempVectorEnd.y - arrowLength * Math.sin(angle + arrowAngle)
    );

    ctx.strokeStyle = ctx.strokeStyle;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  for (let i = ripples.length - 1; i >= 0; i--) {
    if (!ripples[i].update()) {
      ripples.splice(i, 1);
    } else {
      ripples[i].draw(ctx);
    }
  }
}

function animate() {
  drawObjects();
  requestAnimationFrame(animate);
}

let bgImage = new Image();
let bgLoaded = false;
let shipImages = {};

animate();

socket.emit('get-available-maps');

socket.on('available-maps', (maps) => {
  mapSelect.innerHTML = '';
  maps.forEach(map => {
    const option = document.createElement('option');
    option.value = map;
    option.textContent = map;
    mapSelect.appendChild(option);
  });
  mapSelect.value = 'Греция.png';
});

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
      } else {
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

document.querySelectorAll('.ship-item').forEach(item => {
  item.addEventListener('click', () => {
    const type = item.getAttribute('data-type');
    if (type.startsWith('vector-')) {
      drawingVector = true;
      vectorType = type;
      vectorStartPoint = null;
      tempVectorEnd = null;
      console.log('Режим рисования вектора:', type);
    }
  });
});

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

function resizeCanvas() {
  canvas.width = 900;
  canvas.height = 900;
}

socket.on('wrong-password', () => {
  alert('Пароль для уже существующей комнаты не подошел. Создайте новую комнату с другим названием, либо уточните пароль для данной комнаты.');
  roomInput.style.display = 'block';
  canvasContainer.style.display = 'none';
});

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

socket.on('vector-added', (obj) => {
  objects.push(obj);
  allObjects[currentMap] = objects;
});

socket.on('object-updated', (data) => {
  const obj = objects.find(o => o.id === data.id);
  if (obj) {
    if (obj.type.startsWith('vector-')) {
      obj.startX = data.startX;
      obj.startY = data.startY;
      obj.endX = data.endX;
      obj.endY = data.endY;
    } else {
      obj.x = data.x;
      obj.y = data.y;
      if (data.label !== undefined) obj.label = data.label;
      if (data.rotation !== undefined) obj.rotation = data.rotation;
    }
    allObjects[currentMap] = objects;
  }
});

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

let currentTool = null;

canvas.onclick = (e) => {
  if (drawingVector) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (!vectorStartPoint) {
      vectorStartPoint = { x, y };
      console.log('Начало вектора:', vectorStartPoint);
    } else {
      tempVectorEnd = { x, y };
      const vectorObj = {
        id: Date.now() + '-' + Math.random(),
        type: vectorType,
        startX: vectorStartPoint.x,
        startY: vectorStartPoint.y,
        endX: tempVectorEnd.x,
        endY: tempVectorEnd.y
      };

      objects.push(vectorObj);
      allObjects[currentMap] = objects;
      drawObjects();

      socket.emit('add-vector', vectorObj);

      drawingVector = false;
      vectorType = null;
      vectorStartPoint = null;
      tempVectorEnd = null;
      console.log('Вектор добавлен:', vectorObj);
    }
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const id = Date.now() + Math.random();

  ripples.push(new Ripple(x, y));

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

canvas.addEventListener('mousemove', (e) => {
  if (drawingVector && vectorStartPoint) {
    const rect = canvas.getBoundingClientRect();
    tempVectorEnd = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
    drawObjects();
  }
});

socket.on('click-effect', (data) => {
  ripples.push(new Ripple(data.x, data.y));
});

canvas.oncontextmenu = (e) => {
  e.preventDefault();

  if (drawingVector) {
    drawingVector = false;
    vectorType = null;
    vectorStartPoint = null;
    tempVectorEnd = null;
    console.log('Режим вектора отменён');
    e.preventDefault();
    return;
  }

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
      obj.rotation = (obj.rotation || 0) + 1;
      if (obj.rotation > 7) obj.rotation = 0;
      allObjects[currentMap] = objects;

      socket.emit('update-object', {
        id: obj.id,
        x: obj.x,
        y: obj.y,
        rotation: obj.rotation
      });

      drawObjects();
      return false;
    }
  }
};

canvas.onmousedown = (e) => {
  if (drawingVector) {
    return;
  }

  if (e.button === 2) return;

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

    else if (obj.type.startsWith('vector-')) {
      
      const centerX = (obj.startX + obj.endX) / 2;
      const centerY = (obj.startY + obj.endY) / 2;

      const dist = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
      inBounds = dist < 20;
    }

    if (inBounds) {
      selectedObject = obj;

      if (obj.type.startsWith('vector-')) {
        const centerX = (obj.startX + obj.endX) / 2;
        const centerY = (obj.startY + obj.endY) / 2;

        offsetX = centerX - x;
        offsetY = centerY - y;
      } else {
        offsetX = obj.x - x;
        offsetY = obj.y - y;
      }
      isDragging = true;
      canvas.style.cursor = 'grabbing';

      if (obj.type.startsWith('vector-')) {
        draggedObj = {
          obj,
          originalStartX: obj.startX,
          originalStartY: obj.startY,
          originalEndX: obj.endX,
          originalEndY: obj.endY,
          index: i
        };
      } else {
        draggedObj = { obj, originalX: obj.x, originalY: obj.y, index: i };
      }

      break;
    }
  }
};

document.addEventListener('mousemove', (e) => {
  if (isDragging && selectedObject) {
    const rect = canvas.getBoundingClientRect();
    const newX = e.clientX - rect.left + offsetX;
    const newY = e.clientY - rect.top + offsetY;

    if (selectedObject.type.startsWith('vector-')) {
      const dx = newX - ((selectedObject.startX + selectedObject.endX) / 2);
      const dy = newY - ((selectedObject.startY + selectedObject.endY) / 2);

      selectedObject.startX += dx;
      selectedObject.endX += dx;
      selectedObject.startY += dy;
      selectedObject.endY += dy;
    } else {
      selectedObject.x = newX;
      selectedObject.y = newY;
    }

    allObjects[currentMap] = objects;
    drawObjects();
  }

  if (!isDragging && draggedObj) { // <<< УБРАЛИ УСЛОВИЕ !draggedObj.obj.type.startsWith('vector-')
    const rect = canvas.getBoundingClientRect();

    if (draggedObj.obj.type.startsWith('vector-')) {
      
      const currentCenterX = (draggedObj.obj.startX + draggedObj.obj.endX) / 2;
      const currentCenterY = (draggedObj.obj.startY + draggedObj.obj.endY) / 2;

      const dx = (e.clientX - rect.left) - currentCenterX;
      const dy = (e.clientY - rect.top) - currentCenterY;

      draggedObj.obj.startX += dx;
      draggedObj.obj.endX += dx;
      draggedObj.obj.startY += dy;
      draggedObj.obj.endY += dy;
    } else {
      draggedObj.obj.x = e.clientX - rect.left;
      draggedObj.obj.y = e.clientY - rect.top;
    }
    drawObjects();
  }
});

document.addEventListener('mouseup', (e) => {
if (isDragging && selectedObject) {
    let objX, objY;

    if (selectedObject.type.startsWith('vector-')) {
      objX = (selectedObject.startX + selectedObject.endX) / 2;
      objY = (selectedObject.startY + selectedObject.endY) / 2;
    } else {
      objX = selectedObject.x;
      objY = selectedObject.y;
    }

    ripples.push(new Ripple(objX, objY));

    socket.emit('drag-end-effect', { x: objX, y: objY });

    if (selectedObject.type.startsWith('vector-')) {
      socket.emit('update-object', {
        id: selectedObject.id,
        startX: selectedObject.startX,
        startY: selectedObject.startY,
        endX: selectedObject.endX,
        endY: selectedObject.endY
      });
    } else {
      socket.emit('update-object', { id: selectedObject.id, x: selectedObject.x, y: selectedObject.y });
    }

    const obj = objects.find(o => o.id === selectedObject.id);
    if (obj) {
      if (obj.type.startsWith('vector-')) {
        obj.startX = selectedObject.startX;
        obj.startY = selectedObject.startY;
        obj.endX = selectedObject.endX;
        obj.endY = selectedObject.endY;
      } else {
        obj.x = selectedObject.x;
        obj.y = selectedObject.y;
      }
      allObjects[currentMap] = objects;
    }

    drawObjects();

    isDragging = false;
    selectedObject = null;
    canvas.style.cursor = 'default';
  }

  if (draggedObj) { 
    const trashElement = document.getElementById('trashcan');
    if (!trashElement) {
      console.error('Trashcan element not found!');
      return;
    }

    const trashRect = trashElement.getBoundingClientRect();
    const mouseX = e.clientX;
    const mouseY = e.clientY;

    if (mouseX >= trashRect.left && mouseX <= trashRect.right &&
        mouseY >= trashRect.top && mouseY <= trashRect.bottom) {
      objects.splice(draggedObj.index, 1);
      allObjects[currentMap] = objects;
      drawObjects();

      socket.emit('remove-object', { id: draggedObj.obj.id });

      console.log('Объект удалён:', draggedObj.obj.id);
    } else {
      if (draggedObj.obj.type.startsWith('vector-')) {
        if ((draggedObj.obj.endX+draggedObj.obj.endY)/2 <= 0 || (draggedObj.obj.endX+draggedObj.obj.endY)/2 >= 900) {
          draggedObj.obj.startX = draggedObj.originalStartX;
          draggedObj.obj.startY = draggedObj.originalStartY;
          draggedObj.obj.endX = draggedObj.originalEndX;
          draggedObj.obj.endY = draggedObj.originalEndY;
        }
      } else {
        if (draggedObj.obj.x <= 0 || draggedObj.obj.y <=0 || draggedObj.obj.x >= 900 || draggedObj.obj.y >= 900) {
          draggedObj.obj.x = draggedObj.originalX;
          draggedObj.obj.y = draggedObj.originalY;
        }
      }
    }
    draggedObj = null;
    drawObjects();
  }

  if (!isDragging) {
    isDragging = false;
    selectedObject = null;
    canvas.style.cursor = 'default';
  }
});

canvas.onmousemove = (e) => {
};

canvas.onmouseup = () => {
};

socket.on('drag-end-effect', (data) => {
  ripples.push(new Ripple(data.x, data.y));
});

canvas.onmouseleave = () => {
  isDragging = false;
  selectedObject = null;
  canvas.style.cursor = 'default';
};

canvas.ondblclick = (e) => {
  if (drawingVector) {
    drawingVector = false;
    vectorType = null;
    vectorStartPoint = null;
    tempVectorEnd = null;
    console.log('Режим вектора отменён');
    return;
  }

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
      const newLabel = prompt('Введите название корабля:', obj.label || '');
      if (newLabel !== null) {
        if (!isValidString(newLabel)) {
          alert('Название корабля должно содержать только латиницу, кириллицу, цифры и быть не длиннее 15 символов.');
          return;
        }

        obj.label = newLabel;
        allObjects[currentMap] = objects;

        if (socket.connected) {
          socket.emit('update-object', { id: obj.id, x: obj.x, y: obj.y, label: obj.label });
          console.log('[DEBUG] update-object отправлен:', obj.label);
        } else {
          console.warn('Соединение с сервером потеряно, обновление не отправлено:', obj.label);
          alert('Соединение с сервером потеряно. Подпись не обновлена.');
        }
      }
      return;
    }
  }
};

shipsPanel.addEventListener('dragstart', (e) => {
  const el = e.target.closest('.ship-item');
  if (!el) return;

  const type = el.dataset.type;
  if (type && type.startsWith('vector-')) {
    return;
  }

  e.dataTransfer.setData('text/plain', JSON.stringify({
    type: el.dataset.type,
    color: el.dataset.color
  }));
});

canvas.addEventListener('dragover', (e) => {
  e.preventDefault();
});

canvas.addEventListener('drop', (e) => {
  if (drawingVector) {
    drawingVector = false;
    vectorType = null;
    vectorStartPoint = null;
    tempVectorEnd = null;
    console.log('Режим вектора отменён');
    return;
  }

  e.preventDefault();

  const data = e.dataTransfer.getData('text/plain');
  if (!data) return;

  const { type, color } = JSON.parse(data);
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const id = Date.now() + Math.random();

  ripples.push(new Ripple(x, y));

  socket.emit('drop-effect', { x, y });

  const obj = { id, type, x, y, color, label: '', rotation: 0 };
  objects.push(obj);
  allObjects[currentMap] = objects;
  socket.emit('add-object', obj);
});

socket.on('drop-effect', (data) => {
  ripples.push(new Ripple(data.x, data.y));
});

mapSelect.onchange = (e) => {
  const newMap = e.target.value;
  socket.emit('get-map-objects', { map: newMap });
  currentMap = newMap;
  socket.emit('change-map', { map: newMap });
};

socket.on('map-objects', (data) => {
  allObjects[data.map] = data.objects || [];
  if (data.map === currentMap) {
    objects = allObjects[data.map];
    loadBackground(currentMap);
  }
});

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

socket.on('connect', () => {
  console.log('Новое подключение, ID:', socket.id);
  if (currentRoomId && currentUserName) {
    console.log('Отправляем join-room при connect...');
    socket.emit('join-room', {
      roomId: currentRoomId,
      userName: currentUserName,
      password: currentPassword || ''
    });
  }
});

socket.on('disconnect', (reason) => {
  console.log('Соединение потеряно:', reason);
});

resizeCanvas();
window.onresize = resizeCanvas;

function addRadiusInfoTable() {
  const canvas = document.getElementById('canvas');
  if (!canvas) {
    console.log('Canvas не найден!');
    return;
  }

  const parent = canvas.parentElement;
  if (getComputedStyle(parent).position !== 'relative') {
    parent.style.position = 'relative';
  }

  const tableDiv = document.createElement('div');
  tableDiv.id = 'radius-info';
  tableDiv.style.position = 'absolute';
  tableDiv.style.top = '50%';
  tableDiv.style.transform = 'translateY(-50%)';
  tableDiv.style.left = 'calc(50% + 500px)';
  tableDiv.style.width = '220px';
  tableDiv.style.background = 'rgba(0, 0, 0, 0.7)';
  tableDiv.style.color = 'white';
  tableDiv.style.padding = '10px';
  tableDiv.style.borderRadius = '5px';
  tableDiv.style.fontSize = '12px';
  tableDiv.style.zIndex = '10';
  tableDiv.style.fontFamily = 'Arial, sans-serif';
  tableDiv.style.boxSizing = 'border-box';

  const title = document.createElement('h4');
  title.textContent = 'Радиус РЛС (км)';
  title.style.margin = '0 0 10px 0';
  title.style.color = 'yellow';
  title.style.fontSize = '13px';
  tableDiv.appendChild(title);

  const table = document.createElement('table');
  table.id = 'radius-table';
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.fontSize = '11px';

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

  const trashcan = document.createElement('div');
  trashcan.id = 'trashcan';
  trashcan.innerHTML = '🗑️';
  trashcan.style = `
    position: absolute;
    top: 10px;
    left: calc(50% + 500px);
    width: 80px;
    height: 80px;
    background: white;
    border-radius: 50%;
    border-color: black;
    cursor: pointer;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-size: 24px;
    pointer-events: auto;
  `;

  parent.appendChild(trashcan);
  
  tableDiv.appendChild(table);

  parent.appendChild(tableDiv);
}

addRadiusInfoTable();

setInterval(() => {
  fetch('/ping')
    .then(response => response.text())
    .then(data => console.log('Keep-alive ping:', data))
    .catch(err => console.error('Keep-alive failed:', err));
}, 10 * 60 * 1000);

window.dumpAllObjects = () => {
  console.log('=== Состояние allObjects ===');
  console.log(allObjects);
  console.log('Текущая карта:', currentMap);
  console.log('Объекты на текущей карте:', objects);
  console.log('=====================================');
};













