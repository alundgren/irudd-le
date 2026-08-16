const { app, BrowserWindow } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const buildRoot = process.argv.at(-1);
const sandboxModuleUrl = pathToFileURL(path.join(buildRoot, 'renderer', 'asset-sandbox.js')).href;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9oZC8AAAAASUVORK5CYII=';
const webp = 'UklGRiIAAABXRUJQVlA4IBYAAABwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=';
const pngId = '444fca91dfd7bac233811a63d7270a9a1ea159ea6a5a10886271000b4c4a9d4e';
const webpId = '6b0fbb8f90ee268f17436c94afd9ddc67e7a048c49430673c91d2f94e2bb7006';

void app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  try {
    await win.loadFile(path.join(buildRoot, '..', 'test', 'renderer-assets-host.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const { sandboxedDocument } = await import(${JSON.stringify(sandboxModuleUrl)});
      const token = 'asset-render-token';
      const assets = [
        { id: ${JSON.stringify(pngId)}, dataUrl: 'data:image/png;base64,${png}' },
        { id: ${JSON.stringify(webpId)}, dataUrl: 'data:image/webp;base64,${webp}' },
      ];
      return new Promise((resolve, reject) => {
        const iframe = document.createElement('iframe');
        iframe.setAttribute('sandbox', 'allow-scripts');
        const timer = setTimeout(() => reject(new Error('sandbox did not settle')), 3000);
        window.addEventListener('message', function onMessage(event) {
          if (event.source !== iframe.contentWindow || event.data?.token !== token) return;
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          iframe.remove();
          if (event.data.type === 'overlay:render-failure') reject(new Error(event.data.error));
          else resolve(event.data);
        });
        iframe.srcdoc = sandboxedDocument('<img src="asset:${pngId}"><img src="asset:${webpId}">', assets, token);
        document.body.append(iframe);
      });
    })()`);
    process.stdout.write(JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    process.stderr.write(String(error));
    app.exit(1);
  }
});
