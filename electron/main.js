const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // Загружаем index.html из папки app (туда Capacitor копирует dist)
  win.loadFile(path.join(__dirname, 'app', 'index.html'));

  // Открываем DevTools для отладки
  win.webContents.openDevTools();
}

app.whenReady().then(createWindow);