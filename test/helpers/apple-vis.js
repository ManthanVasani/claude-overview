'use strict';

// strvis(VIS_TAB | VIS_NL | VIS_NOSLASH) as Apple's ps calls it, kept apart from the board's encoder to check it
function visByte(c) {
  const extra = c === 0x09 || c === 0x0a;
  if (!extra && c >= 0x20 && c < 0x7f) return String.fromCharCode(c);
  if (extra || (c & 0x7f) === 0x20) return '\\' + ((c >> 6) & 3) + ((c >> 3) & 7) + (c & 7);
  const low = c & 0x7f;
  const meta = c & 0x80 ? 'M' : '';
  if (low < 0x20 || low === 0x7f) return meta + '^' + (low === 0x7f ? '?' : String.fromCharCode(low + 0x40));
  return meta + '-' + String.fromCharCode(low);
}

function appleVis(s) {
  let out = '';
  for (const b of Buffer.from(s, 'utf8')) out += visByte(b);
  return out;
}

module.exports = { appleVis };
