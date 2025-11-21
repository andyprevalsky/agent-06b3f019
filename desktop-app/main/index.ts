import { app, BrowserWindow } from 'electron';
import path from 'path';
import { config } from './base/config';
import './handlers/registry'; // Register IPC handlers

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset', // Mac native look
    webPreferences: {
      nodeIntegration: false,      // Security: no Node in renderer
      contextIsolation: true,       // Security: isolate renderer
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (config.isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../ui/index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});


