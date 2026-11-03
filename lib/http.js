'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { PUBLIC_DIR, HOST, PORT } = require('./config');
const feed = require('./feed');
const { usageReply } = require('./usage');

const ALLOWED_HOSTS = new Set([HOST + ':' + PORT, 'localhost:' + PORT]);
const PAGE_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:" };
const SCRIPT_HEADERS = { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' };
const SCRIPTS = new Set(['/map.js', '/live.js', '/usage-ui.js', '/alerts.js', '/vendor/d3.min.js']);

function sendFile(res, file, headers, missing, missingBody) {
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(missing); res.end(missingBody); return; }
    res.writeHead(200, headers);
    res.end(body);
  });
}

function sendJson(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function handle(req, res) {
  if (!ALLOWED_HOSTS.has(req.headers.host || '')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  const url = (req.url || '/').split('?')[0];
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end();
    return;
  }
  if (url === '/') return sendFile(res, path.join(PUBLIC_DIR, 'index.html'), PAGE_HEADERS, 500, 'page missing');
  if (SCRIPTS.has(url)) return sendFile(res, path.join(PUBLIC_DIR, url), SCRIPT_HEADERS, 404);
  if (url === '/usage') {
    const range = (/[?&]range=([a-z0-9]+)/.exec(req.url || '') || [])[1] || '7d';
    return sendJson(res, JSON.stringify(usageReply(range, feed.current())));
  }
  if (url === '/state.json') return sendJson(res, JSON.stringify(feed.current(), null, 2));
  if (url === '/events') return feed.subscribe(req, res);
  res.writeHead(404);
  res.end();
}

function createServer() {
  return http.createServer(handle);
}

module.exports = { createServer };
