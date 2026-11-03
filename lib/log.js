'use strict';

const logged = new Set();

function info(msg) {
  console.log(new Date().toISOString(), msg);
}

function error(msg) {
  console.error(new Date().toISOString(), msg);
}

function once(e) {
  const msg = (e && e.stack) || String(e);
  if (logged.has(msg)) return;
  logged.add(msg);
  error(msg);
}

module.exports = { info, error, once };
