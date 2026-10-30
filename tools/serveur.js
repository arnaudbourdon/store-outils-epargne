'use strict';

// Serveur de test local de docs\ (http://127.0.0.1:8765), pour essayer la page avant publication.
//   $env:ELECTRON_RUN_AS_NODE='1'; & <electron.exe> tools\serveur.js

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const DOCS = path.resolve(__dirname, '..', 'docs');
const PORT = Number(process.env.PORT) || 8765;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(DOCS, rel);
  if (!file.startsWith(DOCS + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('introuvable');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`http://127.0.0.1:${PORT}/`));
