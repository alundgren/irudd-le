const { app, BrowserWindow } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const buildRoot = process.argv.at(-1);
const sandboxModuleUrl = pathToFileURL(path.join(buildRoot, 'renderer', 'asset-sandbox.js')).href;

void app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  try {
    await win.loadFile(path.join(buildRoot, '..', 'test', 'renderer-shell-stage-host.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const { sandboxedDocument } = await import(${JSON.stringify(sandboxModuleUrl)});
      const token = 'shell-stage-token';
      return new Promise((resolve, reject) => {
        const iframe = document.createElement('iframe');
        iframe.setAttribute('sandbox', 'allow-scripts');
        const timer = setTimeout(() => reject(new Error('shell stage did not settle')), 3000);
        window.addEventListener('message', function onMessage(event) {
          if (event.source !== iframe.contentWindow || event.data?.token !== token) return;
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          iframe.remove();
          if (event.data.type === 'overlay:render-failure') reject(new Error(event.data.error));
          else resolve(event.data);
        });
        iframe.srcdoc = sandboxedDocument('<p>Staged revision</p>', [], token);
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
