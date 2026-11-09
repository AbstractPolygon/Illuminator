#!/usr/bin/env node
// Serves the app folder for use in a browser: npm run web [-- --port 8080]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? +process.argv[portArg + 1] : +(process.env.PORT || 8080);
// Local only by default; HOST=0.0.0.0 opts in to reaching it from another device.
const host = process.env.HOST || '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  // One malformed request must not throw out of the handler and end the server.
  let file;
  try {
    const url = new URL(req.url, 'http://localhost');
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    if (rel.includes('\0')) {
      res.writeHead(400).end('Bad request');
      return;
    }
    file = path.join(root, rel);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(port, host, () => console.log(`Illuminator: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`));
