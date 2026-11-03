#!/usr/bin/env node
'use strict';

const os = require('os');
const { HOST, PORT } = require('./lib/config');

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('CLAUDE_OVERVIEW_PORT must be a port number from 1 to 65535.');
  process.exit(1);
}

const arg = process.argv[2];
if (arg) {
  const usageText = 'Usage: claude-overview\nServes the overview on http://' + HOST + ':' + PORT + '/ until Ctrl + C. CLAUDE_OVERVIEW_PORT sets the port.';
  if (arg === '--version' || arg === '-v') console.log(require('./package.json').version);
  else if (arg === '--help' || arg === '-h') console.log(usageText);
  else { console.error('Unknown argument: ' + arg + '\n' + usageText); process.exit(1); }
  process.exit(0);
}

// npm gives it no nice, and a dashboard should not compete with the sessions it watches
try { if (os.getPriority() < 10) os.setPriority(10); } catch (e) { /* it keeps the priority it started with */ }

// loaded only past the argument check, so --version and --help work even when the server cannot load
const feed = require('./lib/feed');
const { createServer } = require('./lib/http');
const log = require('./lib/log');
const usage = require('./lib/usage');

const server = createServer();

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') log.error('Port ' + PORT + ' is already in use, maybe by another copy of claude-overview. Set CLAUDE_OVERVIEW_PORT to use another port.');
  else log.error(e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log.info('Claude overview on http://' + HOST + ':' + PORT + '/');
  feed.start();
  usage.start();
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
