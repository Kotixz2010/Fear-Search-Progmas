const { app, BrowserWindow, shell, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const http = require('http');

let mainWindow = null;
let tray = null;
let expressServer = null;
let serverPort = 8080;

// Запускаем Express сервер
function startExpressServer() {
    return new Promise((resolve, reject) => {
        const { createApp } = require('./server.js');
        const expressApp = createApp();
        const server = http.createServer(expressApp);

        function tryPort(port) {
            server.listen(port, '127.0.0.1', () => {
                serverPort = port;
                console.log(`Express server running on port ${port}`);
                resolve(port);
            });

            server.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    server.removeAllListeners('error');
                    tryPort(port + 1);
                } else {
                    reject(err);
                }
            });
        }

        tryPort(serverPort);
        expressServer = server;
    });
}

function createWindow(port) {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        title: 'FearSearch',
        backgroundColor: '#0a0a0f',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
        autoHideMenuBar: true,
        show: false,
    });

    mainWindow.loadURL(`http://127.0.0.1:${port}`);

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function createTray() {
    const icoPath = path.join(__dirname, 'icon.ico');
    let icon = nativeImage.createFromPath(icoPath);
    if (!icon || icon.isEmpty()) {
        const png16 = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIElEQVQ4T2NkoBAwUqifYdQDPDAwMDD8p4eLGBgYGAAA5bMDEtGJc5gAAAAASUVORK5CYII=',
            'base64'
        );
        icon = nativeImage.createFromBuffer(png16);
    }

    tray = new Tray(icon);
    tray.setToolTip('FearSearch');

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Открыть FearSearch',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                } else {
                    createWindow(serverPort);
                }
            }
        },
        { type: 'separator' },
        {
            label: 'Выход',
            click: () => {
                app.quit();
            }
        }
    ]);

    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

app.whenReady().then(async () => {
    try {
        const port = await startExpressServer();
        createWindow(port);
        try {
            createTray();
        } catch (trayErr) {
            console.error('Tray unavailable (app will work without tray icon):', trayErr);
        }
    } catch (err) {
        console.error('Failed to start server:', err);
        dialog.showErrorBox(
            'FearSearch — ошибка запуска',
            `Не удалось запустить локальный сервер.\n\n${err && err.message ? err.message : String(err)}\n\nПереустановите программу или проверьте, не блокирует ли антивирус.`
        );
        app.quit();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        // остаёмся в трее
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow(serverPort);
    }
});

app.on('before-quit', () => {
    if (expressServer) {
        expressServer.close();
    }
});
