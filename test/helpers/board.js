'use strict';

const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { toolScript } = require('./claude-code');

const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a test that starts a server gives up after this, so a hang fails that test instead of the whole run
const SERVER_TEST_MS = 180000;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

class Board {
  constructor(prefix, regDefaults) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    this.claude = path.join(this.dir, 'claude');
    this.cwd = path.join(this.dir, 'work');
    this.projDir = path.join(this.claude, 'projects', this.cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    this.taskDir = path.join(this.dir, 'tasks');
    for (const d of [path.join(this.claude, 'sessions'), this.cwd, this.projDir, this.taskDir]) fs.mkdirSync(d, { recursive: true });
    this.regDefaults = regDefaults || {};
    this.sessions = {};
    this.groups = [];
    this.errors = '';
  }

  task(name) {
    return path.join(this.taskDir, name + '.output');
  }

  // its own process group, so the end of the test stops everything it started
  spawn(cmd, args) {
    const k = cp.spawn(cmd, args, { stdio: 'ignore', detached: true });
    this.groups.push(k.pid);
    return k;
  }

  sleeper() {
    return this.spawn('sleep', ['600']);
  }

  // a process standing in for a session, so the shells it starts are that session's children
  shells(...steps) {
    const args = [];
    const script = steps.map((st) => {
      if (typeof st === 'string') return st;
      args.push(...st);
      return 'bash -c "$' + (args.length - 1) + '" > "$' + args.length + '" &';
    }).join(' ') + ' wait';
    return this.spawn('sh', ['-c', script, 'sh', ...args]);
  }

  session(key, reg, lines, proc) {
    proc = proc || this.sleeper();
    const sid = '00000000-0000-4000-8000-' + String(Object.keys(this.sessions).length + 1).padStart(12, '0');
    this.sessions[key] = { sid, pid: proc.pid };
    this.writeTranscript(key, lines);
    this.writeReg(key, reg);
    return sid;
  }

  transcript(key) {
    return path.join(this.projDir, this.sessions[key].sid + '.jsonl');
  }

  writeTranscript(key, lines) {
    fs.writeFileSync(this.transcript(key), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  append(key, lines) {
    fs.appendFileSync(this.transcript(key), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  writeReg(key, reg) {
    const s = this.sessions[key];
    const r = Object.assign({ pid: s.pid, sessionId: s.sid, cwd: this.cwd, name: key, version: '2.1.316' }, this.regDefaults, reg);
    if (r.version === null) delete r.version;
    if (r.status && !r.statusUpdatedAt) r.statusUpdatedAt = Date.now();
    fs.writeFileSync(path.join(this.claude, 'sessions', s.pid + '.json'), JSON.stringify(r));
  }

  restart(key, reg) {
    fs.unlinkSync(path.join(this.claude, 'sessions', this.sessions[key].pid + '.json'));
    this.sessions[key].pid = this.sleeper().pid;
    this.writeReg(key, reg);
  }

  agent(key, id, meta, lines) {
    const dir = path.join(this.projDir, this.sessions[key].sid, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    const metaFile = path.join(dir, 'agent-' + id + '.meta.json');
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    fs.writeFileSync(path.join(dir, 'agent-' + id + '.jsonl'), lines.map((l) => JSON.stringify(Object.assign(l, { isSidechain: true }))).join('\n') + '\n');
    return metaFile;
  }

  // another test file's server can take the port before this one listens, so only this server's own line counts
  async start(opts) {
    opts = opts || {};
    let failed = '';
    for (let tries = 1; ; tries++) {
      this.port = await freePort();
      const env = Object.assign({}, process.env, {
        HOME: this.dir,
        CLAUDE_CONFIG_DIR: this.claude,
        CLAUDE_OVERVIEW_PORT: String(this.port),
        XDG_STATE_HOME: path.join(this.dir, 'state'),
        XDG_DATA_HOME: path.join(this.dir, 'data'),
        XDG_CACHE_HOME: path.join(this.dir, 'cache'),
      });
      const args = [opts.server || path.join(ROOT, 'server.js')];
      if (opts.macOS && process.platform !== 'darwin') {
        args.unshift('-r', path.join(__dirname, 'darwin.js'));
        // the stand-in runs on the first node on PATH
        env.PATH = [path.join(__dirname, 'fake-ps'), path.dirname(process.execPath), env.PATH].join(path.delimiter);
      }
      this.errors = '';
      this.server = cp.spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.server.stderr.on('data', (b) => { this.errors += b; });
      if (await this.listening()) return this.state().catch((e) => { throw new Error(e.message + '; the server said:\n' + this.errors); });
      await this.stopServer();
      failed += this.errors;
      if (tries === 3) throw new Error('the server did not start:\n' + failed);
    }
  }

  listening() {
    const line = 'Claude overview on http://127.0.0.1:' + this.port + '/';
    const s = this.server;
    return new Promise((resolve) => {
      let out = '';
      const done = (up) => {
        clearTimeout(timer);
        s.stdout.removeListener('data', onData);
        s.removeListener('exit', onExit);
        s.stdout.resume();
        resolve(up);
      };
      const onData = (b) => {
        out += b;
        if (out.includes(line)) done(true);
      };
      const onExit = () => done(false);
      const timer = setTimeout(() => done(false), 20000);
      s.stdout.on('data', onData);
      s.once('exit', onExit);
    });
  }

  async stopServer() {
    if (!this.server || this.server.exitCode !== null || this.server.signalCode !== null) return;
    const gone = new Promise((r) => this.server.once('exit', r));
    this.server.kill();
    await gone;
  }

  get(pathname) {
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: this.port, path: pathname }, (r) => {
        let body = '';
        r.on('data', (x) => { body += x; });
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body }));
      }).on('error', reject);
    });
  }

  async state() {
    return JSON.parse((await this.get('/state.json')).body);
  }

  history() {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: this.port, path: '/events' }, (r) => {
        let buf = '';
        r.on('data', (x) => {
          buf += x;
          const m = /^event: hist\ndata: (.*)\n\n/m.exec(buf);
          if (m) { req.destroy(); resolve(JSON.parse(m[1]).a); }
        });
      });
      req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    });
  }

  // the server's errors usually say why a wait timed out
  async waitFor(what, done, ms = 60000) {
    const end = Date.now() + ms;
    for (;;) {
      const s = await this.state();
      if (done(s)) return s;
      if (Date.now() > end) throw new Error('timed out waiting for ' + what + (this.errors ? '; the server said:\n' + this.errors : ''));
      await sleep(100);
    }
  }

  // a snapshot's time is when its poll started, so each change of it is one poll
  async polls(n) {
    let last = (await this.state()).now;
    let seen = 0;
    return this.waitFor(n + ' polls', (s) => {
      if (s.now !== last) { last = s.now; seen++; }
      return seen >= n;
    });
  }

  until(t) {
    return this.waitFor('a poll at ' + new Date(t).toISOString(), (s) => s.now >= t);
  }

  listed(count) {
    return this.waitFor(count + ' sessions', (s) => s.sessions.length >= count);
  }

  view(snap, key) {
    return snap.sessions.find((s) => s.id === this.sessions[key].sid);
  }

  // the server goes first, so nothing it writes lands in the folder after it is removed
  async stop() {
    await this.stopServer();
    for (const pid of this.groups) {
      try { process.kill(-pid); } catch { /* gone */ }
    }
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

// a function per program the command runs stands in for it, so the shell stays up
function runningToolShell(fns, afterEval, prelude) {
  return fns.map((f) => f + '() { sleep 600; }; ').join('') + toolScript(afterEval, { prelude, cwdFile: '/dev/null' });
}

module.exports = { Board, runningToolShell, sleep, SERVER_TEST_MS };
