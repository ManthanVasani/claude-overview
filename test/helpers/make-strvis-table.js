'use strict';

// run by hand where strvis exists; the table it writes lets the checks run where it does not
const fs = require('fs');
const path = require('path');
const { buildOracle } = require('./strvis');

const SAMPLES = ['make one\nmake two', "printf 'a\tb'", 'echo café', 'echo ç', "echo 'で'", 'tail -f /x/\u{1F600}.log', '§ ¢ “quoted”', 'no break', 'del\u007f', 'bell\u0007', 'make one\\012make two', "grep 'M-' notes.txt"];

const oracle = buildOracle();
if (!oracle) throw new Error('no C compiler with strvis (libbsd on Linux)');
const bytes = [];
for (let b = 1; b < 256; b++) bytes.push(Buffer.from([b]));
const byteOut = oracle.run(bytes);
const sampleOut = oracle.run(SAMPLES);
fs.rmSync(oracle.dir, { recursive: true, force: true });
const table = { bytes: {}, samples: SAMPLES.map((s, i) => [s, sampleOut[i]]) };
bytes.forEach((b, i) => { table.bytes[b[0]] = byteOut[i]; });
fs.writeFileSync(path.join(__dirname, '..', 'fixtures', 'strvis.json'), JSON.stringify(table, null, 1) + '\n');
