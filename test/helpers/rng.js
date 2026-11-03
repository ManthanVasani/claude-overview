'use strict';

function rng(seed) {
  let x = seed;
  const r = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  r.pick = (a) => a[Math.floor(r() * a.length)];
  return r;
}

module.exports = { rng };
