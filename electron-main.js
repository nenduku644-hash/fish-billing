const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Hardware Acceleration & Chromium GPU Performance Switches
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization,WebAssemblySimd');
app.commandLine.appendSwitch('enable-fast-unload');

// Ensure single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let mainWindow = null;

// Window state preservation helper
function getWindowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const p = getWindowStatePath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (e) {}
  return { width: 1366, height: 860, isMaximized: false };
}

function saveWindowState() {
  if (!mainWindow) return;
  try {
    const isMaximized = mainWindow.isMaximized();
    const bounds = mainWindow.getBounds();
    const state = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized
    };
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state));
  } catch (e) {}
}

function createWindow() {
  const savedState = loadWindowState();

  mainWindow = new BrowserWindow({
    x: savedState.x,
    y: savedState.y,
    width: savedState.width || 1366,
    height: savedState.height || 860,
    minWidth: 1024,
    minHeight: 700,
    title: "Aaryan Aqua Needs - GST Billing System",
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#0f172a',
    show: false, // Show gracefully after ready-to-show
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  if (savedState.isMaximized) {
    mainWindow.maximize();
  }

  // Load the application
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open external links safely in user's default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://wa.me') || 
        url.startsWith('https://t.me') || 
        url.startsWith('https://web.whatsapp.com') ||
        url.startsWith('http://') || 
        url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('close', () => {
    saveWindowState();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// macOS & Windows Application Menu
function createMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: 'Aaryan Aqua Needs',
      submenu: [
        { role: 'about', label: 'About Aaryan Aqua Needs' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Aaryan Aqua Needs' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Aaryan Aqua Needs' }
      ]
    }] : []),
    {
      label: 'Billing',
      submenu: [
        {
          label: 'New Invoice',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            if (mainWindow) mainWindow.webContents.executeJavaScript(`if (typeof switchTab === 'function') switchTab('billing');`);
          }
        },
        {
          label: 'Invoice History',
          accelerator: 'CmdOrCtrl+H',
          click: () => {
            if (mainWindow) mainWindow.webContents.executeJavaScript(`if (typeof switchTab === 'function') switchTab('history');`);
          }
        },
        {
          label: 'Dashboard Overview',
          accelerator: 'CmdOrCtrl+D',
          click: () => {
            if (mainWindow) mainWindow.webContents.executeJavaScript(`if (typeof switchTab === 'function') switchTab('dashboard');`);
          }
        },
        { type: 'separator' },
        {
          label: 'Save Active Invoice',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            if (mainWindow) mainWindow.webContents.executeJavaScript(`if (typeof handleSaveInvoice === 'function') handleSaveInvoice('save_only');`);
          }
        },
        {
          label: 'Print Active Invoice',
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            if (mainWindow) mainWindow.webContents.print();
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        {
          label: 'Sync Database Now',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (mainWindow) mainWindow.webContents.executeJavaScript(`if (typeof triggerDatabaseSync === 'function') triggerDatabaseSync(true);`);
          }
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' }
        ] : [
          { role: 'close' }
        ])
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Aaryan Aqua Online Cloud Portal',
          click: async () => {
            await shell.openExternal('https://kandukurijagan7-star.github.io/bill/');
          }
        },
        {
          label: 'WhatsApp Companion Console',
          click: async () => {
            await shell.openExternal('http://localhost:3001');
          }
        },
        { type: 'separator' },
        {
          label: 'Developer Tools',
          accelerator: 'F12',
          click: () => {
            if (mainWindow) mainWindow.webContents.toggleDevTools();
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ----------------------------------------------------------------------------
// HIGH-SPEED NATIVE IPC COMMUNICATION & DISK CACHE BUS (< 1ms)
// ----------------------------------------------------------------------------
const cacheDir = path.join(app.getPath('userData'), 'fast_cache');
try {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
} catch (e) {}

ipcMain.handle('fast-save-cache', async (event, { key, data }) => {
  try {
    const safeKey = String(key || 'cache').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(cacheDir, `${safeKey}.json`);
    await fs.promises.writeFile(filePath, JSON.stringify(data), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fast-read-cache', async (event, { key }) => {
  try {
    const safeKey = String(key || 'cache').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(cacheDir, `${safeKey}.json`);
    if (fs.existsSync(filePath)) {
      const content = await fs.promises.readFile(filePath, 'utf8');
      return { ok: true, data: JSON.parse(content) };
    }
  } catch (err) {}
  return { ok: false };
});

ipcMain.on('print-invoice', (event) => {
  if (mainWindow) {
    mainWindow.webContents.print();
  }
});

ipcMain.on('open-external', (event, url) => {
  if (url && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:') || url.startsWith('tel:'))) {
    shell.openExternal(url);
  }
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  createMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

