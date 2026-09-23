// Static development server for the frontend only. No API, uploads or model calls.
// Do not use a general project-root file server for confidential meeting data.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ...['app.js', 'transcript-analyzer.js', 'meeting-utils.js', 'protocol-export.js', 'protocol-storage.js'].map(name => ['/' + name, [name, 'text/javascript']]),
  ['/styles.css', ['styles.css', 'text/css']]
]);
const port = Number(process.env.FRONTEND_PORT || 5500);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('FRONTEND_PORT must be a port from 1 to 65535');
const host = process.env.FRONTEND_HOST || '127.0.0.1';
const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  let path;
  try { path = new URL(request.url, 'http://localhost').pathname; }
  catch { response.writeHead(400, {'Content-Type': 'text/plain; charset=utf-8'}).end('Bad request'); return; }
  const asset = assets.get(path);
  if (!['GET', 'HEAD'].includes(request.method) || !asset) {
    response.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'}).end('Not found');
    return;
  }
  try {
    const data = await readFile(fileURLToPath(new URL(asset[0], import.meta.url)));
    response.writeHead(200, {'Content-Type': asset[1] + '; charset=utf-8'});
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch {
    response.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'}).end('Frontend asset unavailable');
  }
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Порт ${port} занят. Закройте Live Server или задайте FRONTEND_PORT=5501.` : error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`QORIT frontend: http://${host}:${port} (backend unchanged)`));
