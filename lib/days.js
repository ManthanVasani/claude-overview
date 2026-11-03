'use strict';

// usage-scan writes its totals under these keys and usage reads them back, so both build them here
function pad(n) { return n < 10 ? '0' + n : String(n); }
function dayKey(t) { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function hourKey(t) { const d = new Date(t); return dayKey(t) + 'T' + pad(d.getHours()); }

module.exports = { pad, dayKey, hourKey };
