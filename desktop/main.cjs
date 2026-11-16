'use strict';

const path = require('node:path');
const { app, BrowserWindow, dialog, session, shell } = require('electron');

let mainWindow = null;
let server = null;
const allowedExternalHosts = new Set([
  'github.com', 'irsa.ipac.caltech.edu', 'caltech-ipac.github.io',
  'spaceappschallenge.org', 'www.spaceappschallenge.org',
  'doi.org', 'simbad.cds.unistra.fr', 'aladin.cds.unistra.fr',
  'archive.stsci.edu', 'cds.unistra.fr',
]);

function openApprovedExternal(url) {
  try {
    const target = new URL(url);
    if (target.protocol === 'https:' && allowedExternalHosts.has(target.hostname.toLowerCase())) {
      void shell.openExternal(target.href);
    }
  } catch {
    // Ignore malformed links and unsafe protocols.
  }
}

async function openUrutau() {
  process.env.NODE_ENV = 'production';
  process.env.URUTAU_EMBEDDED = '1';

  // The portable executable already includes Node/Electron and the bundled API.
  const { startServer } = require('../dist-server/server.cjs');
  server = await startServer({
    production: true,
    host: '127.0.0.1',
    port: 0,
    staticDir: path.join(app.getAppPath(), 'dist'),
    dataDir: path.join(app.getPath('userData'), 'data'),
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, answer) => {
    answer(false);
  });

  mainWindow = new BrowserWindow({
    title: 'URUTAU — The Sky in Motion',
    width: 1320,
    height: 840,
    minWidth: 800,
    minHeight: 580,
    backgroundColor: '#07090e',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openApprovedExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin !== new URL(server.url).origin) {
        event.preventDefault();
        openApprovedExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });

  await mainWindow.loadURL(server.url);
  mainWindow.show();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(openUrutau).catch(async err => {
    dialog.showErrorBox(
      'URUTAU não conseguiu iniciar',
      'Não foi possível iniciar o servidor local.\n\n' + (err?.message || String(err)),
    );
    if (server) await server.close().catch(() => {});
    app.quit();
  });
  app.on('window-all-closed', () => {
    Promise.resolve(server?.close()).catch(() => {}).finally(() => app.quit());
  });
}
