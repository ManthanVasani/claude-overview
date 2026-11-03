'use strict';

const { HOME } = require('./config');

const HOME_RE = new RegExp('^' + escapeRe(HOME));
const SCRATCH_RE = /^.*?\/claude-\d+\/[^/]+\/[0-9a-f-]{36}\/scratchpad/;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function oneLine(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function plainText(s) {
  return String(s == null ? '' : s)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*|`/g, '');
}

function shortPath(p) {
  if (!p) return '';
  p = String(p).replace(SCRATCH_RE, 'scratchpad').replace(HOME_RE, '~');
  return p.length > 80 ? '…' + p.slice(-79) : p;
}

function host(u) {
  try { return new URL(u).host; } catch { return oneLine(u, 60); }
}

function entryTime(d) {
  const t = Date.parse(d && d.timestamp);
  return Number.isFinite(t) ? t : 0;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((x) => x && x.type === 'text' && x.text).map((x) => x.text).join('\n');
}

function toolError(result) {
  return result.is_error ? oneLine(textOf(result.content), 200) : null;
}

module.exports = { HOME_RE, escapeRe, oneLine, plainText, shortPath, host, entryTime, textOf, toolError };
