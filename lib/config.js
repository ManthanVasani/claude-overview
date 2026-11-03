'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// the XDG spec ignores a relative path
function xdgDir(name, fallback) {
  const xdg = (process.env[name] || '').replace(/^~(?=$|\/)/, () => HOME);
  return path.isAbsolute(xdg) ? xdg : path.join(HOME, fallback);
}

// npm can install the code where its user cannot write, and the index keeps the totals of deleted transcripts
function usageIndexFile() {
  const base = process.platform === 'darwin' ? path.join(HOME, 'Library', 'Application Support') : xdgDir('XDG_STATE_HOME', path.join('.local', 'state'));
  // servers reading different Claude folders must not mix their totals
  const folder = crypto.createHash('sha1').update(path.resolve(PROJECTS_DIR)).digest('hex').slice(0, 12);
  return path.join(base, 'claude-overview', 'usage-index-' + folder + '.json');
}

// cswap keeps its files under the XDG data dir on Linux and in ~/.claude-swap-backup on macOS
function cswapDir() {
  if (process.platform !== 'linux') return path.join(HOME, '.claude-swap-backup');
  return path.join(xdgDir('XDG_DATA_HOME', path.join('.local', 'share')), 'claude-swap');
}

module.exports = {
  ROOT,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  HOME,
  SESSIONS_DIR: path.join(CLAUDE_DIR, 'sessions'),
  PROJECTS_DIR,
  CSWAP_DIR: cswapDir(),
  USAGE_INDEX: usageIndexFile(),
  // Linux reads processes from /proc; macOS has none, so there one ps listing per poll stands in for it.
  PROC_FS: process.platform === 'linux',
  HOST: '127.0.0.1',
  PORT: Number(process.env.CLAUDE_OVERVIEW_PORT || 3100),
};
