'use strict';
/*
 * CodeBuddy Workbench — CodeBuddy 风格工作台服务（零第三方依赖，node-pty 已 vendor 到 ./node-pty）
 * 用法: node server.js --root <项目目录> [--port N] [--daemon] [--stop] [--no-open]
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
// Windows 上所有「控制台类」子进程都必须隐藏窗口，否则每次 git 轮询 / 定时任务 /
// 终端开关都会闪出命令行黑框。GUI 程序（explorer / rundll32 / 浏览器）不要加此标志，
// 否则 windowsHide 会连它们的正常窗口一起隐藏。
const HIDE = IS_WIN ? { windowsHide: true } : {};
const hidden = (opts) => Object.assign({}, HIDE, opts || {});
const CODEX_MISSING = '未找到 codex 可执行文件：请把 codex 加入 PATH，或设置环境变量 BUDDY_CODEX_BIN 指向 codex.exe / codex.js';
function comspecPath() {
  return process.env.COMSPEC || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
}
// 同步在 PATH 中查找可执行文件，替代 where.exe / which：不启动任何子进程，也就不会弹窗。
function findInPath(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = IS_WIN
    ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [''];
  for (const rawDir of dirs) {
    const dir = rawDir.replace(/^"|"$/g, '');
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}

const SKILL_DIR = path.resolve(__dirname, '..');
const WEB_DIR = path.join(SKILL_DIR, 'web');
// 允许用 BUDDY_STATE_DIR 隔离状态目录（多实例 / 自动化测试时不污染用户数据）。
const STATE_DIR = process.env.BUDDY_STATE_DIR
  ? path.resolve(process.env.BUDDY_STATE_DIR)
  : path.join(os.homedir(), '.codex', 'codebuddy-workbench');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOG_FILE = path.join(STATE_DIR, 'server.log');
const HIST_FILE = path.join(STATE_DIR, 'chat-history.json');
function loadHistoryFile() { try { const a = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveHistoryFile(a) { try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(HIST_FILE, JSON.stringify(a.slice(0, 500))); } catch {} }
/* ---- 与 codex 双向同步：直接读写 ~/.codex 的真实配置 ---- */
const CODEX_CFG = path.join(os.homedir(), '.codex', 'config.toml');
const CODEX_AGENTS = path.join(os.homedir(), '.codex', 'AGENTS.md');
const CODEX_MEM = path.join(os.homedir(), '.codex', 'memories');
function readCfg() { try { return fs.readFileSync(CODEX_CFG, 'utf8'); } catch { return ''; } }
function writeCfg(txt) { try { try { fs.copyFileSync(CODEX_CFG, CODEX_CFG + '.bak'); } catch {} fs.mkdirSync(path.dirname(CODEX_CFG), { recursive: true }); fs.writeFileSync(CODEX_CFG, txt); return true; } catch { return false; } }
function cfgModel(txt) { const m = txt.match(/^\s*model\s*=\s*"([^"]*)"/m); return m ? m[1] : ''; }
function cfgSandbox(txt) { const m = txt.match(/^\s*sandbox\s*=\s*"([^"]*)"/m); return m ? m[1] : ''; }
function cfgMcp(txt) {
  const lines = txt.split('\n'); const arr = []; let cur = null;
  for (const ln of lines) {
    const h = /^\s*\[mcp_servers\.([^\]]+)\]\s*$/.exec(ln);
    if (h) { if (cur) arr.push(cur); cur = { name: h[1], enabled: true, command: '' }; continue; }
    if (/^\s*\[[^\]]+\]\s*$/.test(ln)) { if (cur) { arr.push(cur); cur = null; } continue; }
    if (cur) {
      let m = /^\s*enabled\s*=\s*(true|false)\s*$/.exec(ln); if (m) { cur.enabled = m[1] === 'true'; continue; }
      m = /^\s*command\s*=\s*'([^']*)'/.exec(ln); if (m) { cur.command = m[1]; continue; }
      m = /^\s*command\s*=\s*"([^"]*)"/.exec(ln); if (m) { cur.command = m[1]; continue; }
    }
  }
  if (cur) arr.push(cur);
  return arr;
}
function blockRange(lines, headerRe) {
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) { let j = i + 1; while (j < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[j])) j++; return [i, j]; }
  }
  return null;
}
function setModel(txt, val) {
  const lines = txt.split('\n'); const line = 'model = "' + val + '"';
  for (let i = 0; i < lines.length; i++) { if (/^\s*model\s*=/.test(lines[i])) { lines[i] = line; return lines.join('\n'); } }
  return line + '\n' + txt;
}
function setWindowsSandbox(txt, val) {
  const lines = txt.split('\n'); const line = 'sandbox = "' + val + '"';
  const r = blockRange(lines, /^\s*\[windows\]\s*$/);
  if (r) {
    const [s, e] = r; let done = false;
    for (let i = s + 1; i < e; i++) { if (/^\s*sandbox\s*=/.test(lines[i])) { lines[i] = line; done = true; break; } }
    if (!done) lines.splice(s + 1, 0, line);
    return lines.join('\n');
  }
  return txt + '\n[windows]\n' + line + '\n';
}
function mcpAdd(txt, name, command, enabled) {
  const lines = txt.split('\n');
  lines.push('', '[mcp_servers.' + name + ']', 'command = ' + JSON.stringify(command), 'enabled = ' + (enabled ? 'true' : 'false'));
  return lines.join('\n') + '\n';
}
function mcpRemove(txt, name) {
  const lines = txt.split('\n'); const re = new RegExp('^\\[mcp_servers\\.' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]\\s*$');
  const r = blockRange(lines, re); if (!r) return txt;
  let [s, e] = r;
  if (s > 0 && lines[s - 1] === '') s--;
  if (e < lines.length && lines[e] === '') e++;
  lines.splice(s, e - s);
  return lines.join('\n');
}
function mcpToggle(txt, name) {
  const lines = txt.split('\n'); const re = new RegExp('^\\[mcp_servers\\.' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]\\s*$');
  const r = blockRange(lines, re); if (!r) return txt;
  const [s, e] = r; let done = false;
  for (let i = s + 1; i < e; i++) { if (/^\s*enabled\s*=/.test(lines[i])) { lines[i] = (lines[i].indexOf('true') >= 0 ? 'enabled = false' : 'enabled = true'); done = true; break; } }
  if (!done) lines.splice(e, 0, 'enabled = false');
  return lines.join('\n');
}
function sanName(n) { return String(n || '').replace(/[\\/]/g, '').slice(0, 120) || 'untitled'; }
const DEFAULT_PORT = 5399;

/* ---------------- args ---------------- */
function parseArgs(argv) {
  const a = { root: process.cwd(), port: DEFAULT_PORT, daemon: false, stop: false, open: true, token: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--root') a.root = path.resolve(argv[++i] || '.');
    else if (t === '--port') a.port = parseInt(argv[++i], 10) || a.port;
    else if (t === '--daemon') a.daemon = true;
    else if (t === '--stop') a.stop = true;
    else if (t === '--no-open') a.open = false;
    else if (t === '--token') a.token = String(argv[++i] || '');
  }
  return a;
}

/* ---------------- daemon control ---------------- */
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function stopDaemon() {
  const st = readState();
  if (!st || !pidAlive(st.pid)) { console.log('NOT_RUNNING'); return true; }
  await new Promise((res) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(st.pid), '/T', '/F'], hidden(), () => res());
    } else {
      try { process.kill(st.pid); } catch {}
      res();
    }
  });
  try { fs.unlinkSync(STATE_FILE); } catch {}
  console.log('STOPPED pid=' + st.pid);
  return true;
}
function spawnDaemon(root, port, open, token) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const args = [__filename, '--root', root, '--port', String(port)];
  if (token) args.push('--token', token);
  if (!open) args.push('--no-open');
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, args, hidden({
    detached: true, stdio: ['ignore', out, out],
    env: Object.assign({}, process.env, { BUDDY_DAEMON: '1' }),
  }));
  child.unref();
  fs.closeSync(out);
  // 等待 state.json 出现
  const deadline = Date.now() + 8000;
  const wait = () => {
    const st = readState();
    if (st && st.pid === child.pid && st.ready) {
      console.log('READY ' + st.url + ' token=' + st.token);
      return;
    }
    if (Date.now() > deadline) { console.log('TIMEOUT see log: ' + LOG_FILE); return; }
    setTimeout(wait, 150);
  };
  setTimeout(wait, 200);
}

/* ---------------- pty (optional) ---------------- */
let pty = null;
try { pty = require('./node-pty'); } catch (e) { pty = null; }

/* ---------------- helpers ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};
function guessMime(p) { return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'; }

function safeJoin(root, rel) {
  const r = path.resolve(root);
  const t = path.resolve(r, '.' + path.sep + String(rel || '').replace(/^[A-Za-z]:/, '').replace(/\\/g, '/').replace(/^\/+/, ''));
  if (t !== r && !t.startsWith(r + path.sep)) return null;
  return t;
}
function relFrom(root, abs) { return path.relative(root, abs).split(path.sep).join('/'); }

function gitRun(cwd, args, cb) {
  execFile('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], hidden({ maxBuffer: 8 * 1024 * 1024 }),
    (err, stdout, stderr) => cb(err, String(stdout || ''), String(stderr || '')));
}
function findRepoRoot(startDir, cb) {
  gitRun(startDir, ['rev-parse', '--show-toplevel'], (err, out) => {
    if (err) return cb(null);
    cb(out.trim() || null);
  });
}
// 把聊天附件目录加入本地 git 忽略（.git/info/exclude，不进版本库），
// 避免 .buddy-attachments 里的聊天图片/文件被误当成待提交改动。
function ensureBuddyExclude(repoDir) {
  try {
    const infoDir = path.join(repoDir, '.git', 'info');
    if (!fs.existsSync(infoDir)) return;
    const f = path.join(infoDir, 'exclude');
    let cur = '';
    try { cur = fs.readFileSync(f, 'utf8'); } catch {}
    if (!/(^|\n)\s*\.buddy-attachments\/?\s*($|\n)/.test(cur)) {
      fs.appendFileSync(f, (cur && !cur.endsWith('\n') ? '\n' : '') + '.buddy-attachments/\n');
    }
  } catch {}
}
// 解析 git status --porcelain=v1 -b 输出为结构化对象（供 /api/git 与 /api/git-action 复用）
// 注意：本函数在模块顶层，root 不在作用域内，必须由调用方把项目根目录作为 rootDir 传入。
function gitStatusObj(repo, rootDir, cb) {
  ensureBuddyExclude(repo);
  gitRun(repo, ['status', '--porcelain=v1', '-b', '--untracked-files=all'], (err, out) => {
    if (err) return cb(String(out || err.message || 'git error').trim());
    const lines = out.split(/\r?\n/);
    let branch = '', ahead = 0, behind = 0;
    const files = {};
    for (const ln of lines) {
      if (ln.startsWith('## ')) {
        const body = ln.slice(3);
        const br = body.split('...')[0].trim();
        branch = br.replace(/^\((?:HEAD )?detached (?:from|of) /, '@').replace(/^\(no branch.*\)$/, 'DETACHED');
        const a = body.match(/ahead (\d+)/); const b = body.match(/behind (\d+)/);
        ahead = a ? +a[1] : 0; behind = b ? +b[1] : 0;
      } else if (ln.length >= 4) {
        const xy = ln.slice(0, 2);
        let f = ln.slice(3);
        const arrow = f.indexOf(' -> ');
        if (arrow >= 0) f = f.slice(arrow + 4);
        // 聊天附件目录不应出现在待提交列表里
        if (f === '.buddy-attachments' || f.startsWith('.buddy-attachments/')) continue;
        files[f] = xy;
      }
    }
    cb(null, { repo, repoRel: relFrom(rootDir, repo) || '.', branch, ahead, behind, files });
  });
}

function listDir(abs, cb) {
  fsp.readdir(abs, { withFileTypes: true }).then((ents) => {
    const items = [];
    let pending = ents.length;
    if (!pending) return cb(null, []);
    const done = () => { if (--pending === 0) cb(null, items); };
    for (const e of ents) {
      const full = path.join(abs, e.name);
      const it = { name: e.name, dir: e.isDirectory() };
      items.push(it);
      if (!it.dir) {
        fsp.stat(full).then((s) => { it.size = s.size; done(); }, () => done());
      } else done();
    }
  }, (err) => cb(err, null));
}

/* ---------------- WebSocket (minimal RFC6455 server) ---------------- */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsFrame(strOrBuf, opcode) {
  const payload = Buffer.isBuffer(strOrBuf) ? strOrBuf : Buffer.from(String(strOrBuf), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | (opcode === undefined ? 1 : opcode);
  return Buffer.concat([header, payload]);
}
function attachWS(req, socket, onMessage, onClose) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return null; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0);
  let closed = false;
  const send = (obj) => { if (!closed && socket.writable) socket.write(wsFrame(typeof obj === 'string' ? obj : JSON.stringify(obj))); };
  const close = () => { if (!closed) { closed = true; try { socket.write(wsFrame(Buffer.alloc(0), 8)); } catch {} try { socket.destroy(); } catch {} } };
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; const b = buf.readBigUInt64BE(2); if (b > 10485760n) { close(); return; } len = Number(b); off = 10; }
      let mask = null;
      if (masked) { if (buf.length < off + 4) return; mask = buf.subarray(off, off + 4); off += 4; }
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (mask) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]; }
      buf = buf.subarray(off + len);
      if (op === 8) { close(); onClose && onClose(); return; }
      if (op === 9) { if (socket.writable) socket.write(wsFrame(payload, 10)); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2) { try { onMessage(payload.toString('utf8'), send, close); } catch {} }
    }
  });
  socket.on('error', () => { if (!closed) { closed = true; onClose && onClose(); } });
  socket.on('close', () => { if (!closed) { closed = true; onClose && onClose(); } });
  return { send, close };
}

/* ---------------- codex binary resolution ----------------
 * 无论 codex 装在何处，都解析为「原生 exe」或「node + JS 入口」直接启动：
 * 绝不通过 cmd.exe / .cmd 垫片 / shell:true，避免 Windows 上黑框闪现与 stdin 卡住。
 */
let _codexLaunch = undefined; // {cmd, prefix[]} | null
function launchFromShim(shim) {
  const base = path.dirname(shim);
  // npm 全局安装的标准布局：<bin>/codex.cmd → <bin>/node_modules/@openai/codex/bin/codex.js
  const common = [
    'node_modules/@openai/codex/bin/codex.js',
    '../lib/node_modules/@openai/codex/bin/codex.js',
  ];
  for (const rel of common) {
    const js = path.resolve(base, rel);
    try { if (fs.statSync(js).isFile()) return { cmd: process.execPath, prefix: [js] }; } catch {}
  }
  let txt = '';
  try { txt = fs.readFileSync(shim, 'utf8'); } catch {}
  const m = txt.match(/[^\s"']*@openai[\\/]codex[\\/]bin[\\/]codex\.js/i) || txt.match(/[^\s"']+\.(?:js|mjs|cjs)/i);
  if (m) {
    const raw = m[0].replace(/%~?dp0%/gi, base + path.sep).replace(/["']/g, '').replace(/[\\/]/g, path.sep);
    const js = path.resolve(base, raw);
    try { if (fs.statSync(js).isFile()) return { cmd: process.execPath, prefix: [js] }; } catch {}
  }
  return null; // 解析不出就不走垫片，避免弹窗
}
function launchFromPath(p) {
  if (!p) return null;
  const abs = path.resolve(String(p));
  let st; try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile()) return null;
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return { cmd: process.execPath, prefix: [abs] };
  if (IS_WIN) {
    if (ext === '.cmd' || ext === '.bat' || ext === '') return launchFromShim(abs);
    if (ext === '.exe') return { cmd: abs, prefix: [] };
    return null;
  }
  if (ext === '.sh' || ext === '') return launchFromShim(abs) || { cmd: abs, prefix: [] };
  return { cmd: abs, prefix: [] };
}
function resolveCodexLaunch() {
  if (_codexLaunch !== undefined) return _codexLaunch;
  _codexLaunch = null;
  const candidates = [];
  if (process.env.BUDDY_CODEX_BIN) candidates.push(process.env.BUDDY_CODEX_BIN);
  const npmRoot = IS_WIN ? path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules') : null;
  if (npmRoot) {
    const pkgDir = path.join(npmRoot, '@openai', 'codex');
    const vendorBase = path.join(pkgDir, 'node_modules', '@openai');
    try {
      for (const d of fs.readdirSync(vendorBase)) {
        if (!d.startsWith('codex-win32-')) continue;
        const base = path.join(vendorBase, d, 'vendor');
        try { for (const t of fs.readdirSync(base)) {
          const exe = path.join(base, t, 'bin', 'codex.exe');
          if (fs.existsSync(exe)) candidates.push(exe);
        } } catch {}
      }
    } catch {}
    candidates.push(path.join(pkgDir, 'bin', 'codex.js'));
  }
  const onPath = findInPath('codex');
  if (onPath) candidates.push(onPath);
  if (!IS_WIN) candidates.push('/usr/local/bin/codex', '/usr/bin/codex', path.join(os.homedir(), '.local', 'bin', 'codex'));
  for (const c of candidates) {
    const l = launchFromPath(c);
    if (l) { _codexLaunch = l; return _codexLaunch; }
  }
  return _codexLaunch; // null → 调用方给出明确提示，不再退回 shell:true
}

/* ---------------- shells ----------------
 * 纯文件系统扫描，不再为每个 shell 启动一个 where.exe 进程（原先每次刷新页面 3 个）。
 */
function detectShells(cb) {
  const cands = [];
  const push = (file, label) => { if (file) cands.push({ file, label }); };
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  push(findInPath('pwsh') || (fs.existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe') ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null), 'PowerShell 7');
  push(findInPath('powershell') || path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), 'Windows PowerShell');
  push(comspecPath(), 'cmd');
  push(findInPath('bash'), 'bash');
  cb(cands.filter((c) => { try { return fs.existsSync(c.file); } catch { return false; } }));
}

/* ---------------- HTTP server ---------------- */
// 读取 codex 应使用的 model provider。若用户未显式配置 model_provider，但存在 magpie
// 自定义 provider，则强制走 magpie：内置 openai provider 会触发 workspace routing
// discovery（magpie 不提供该端点），导致 codex exec 长时间卡住并报 "Reconnecting…"。
function readCodexProvider() {
  try {
    const cfgPath = path.join(os.homedir(), '.codex', 'config.toml');
    const txt = fs.readFileSync(cfgPath, 'utf8');
    const m = txt.match(/^\s*model_provider\s*=\s*"([^"]+)"/m);
    if (m) return m[1];
    if (/\[model_providers\.magpie\]/.test(txt)) return 'magpie';
    return null;
  } catch { return null; }
}
function createServer(root, token) {
  const server = http.createServer((req, res) => {
    try { handle(req, res); } catch (e) {
      console.error('REQ ERROR', req.url, e && e.stack || e);
      try { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('server error: ' + (e && e.message)); } catch {}
    }
  });
  function handle(req, res) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const q = u.searchParams;
    const send = (code, body, headers) => {
      res.writeHead(code, Object.assign({ 'Access-Control-Allow-Origin': '*' }, headers || {}));
      res.end(body);
    };
    const json = (obj, code) => send(code || 200, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
    const cookies = {};
    String(req.headers.cookie || '').split(';').forEach((kv) => { const i = kv.indexOf('='); if (i > 0) cookies[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim()); });
    const authed = q.get('token') === token || cookies.buddy_token === token;
    if (!authed) return send(403, 'bad token');

    // 读取 Codex 默认模型（~/.codex/config.toml 的 model 字段），供前端下拉默认选中
    function readCodexModel() {
      try {
        const cfgPath = path.join(os.homedir(), '.codex', 'config.toml');
        const txt = fs.readFileSync(cfgPath, 'utf8');
        const m = txt.match(/^\s*model\s*=\s*"([^"]+)"/m);
        return m ? m[1] : null;
      } catch { return null; }
    }

    // 读取 Codex 本地真实可用模型列表（来自 codex 自身的 models_cache.json）。
    // 这份缓存是 codex 拉取并维护的全集，包含通过 magpie 等反代接入的模型，
    // 远比写死的预设准确。返回 [{id: slug, name: display_name}]；失败时返回 null。
    let _modelsCache = null; // { mtime, items }
    function readCodexModels() {
      try {
        const cachePath = path.join(os.homedir(), '.codex', 'models_cache.json');
        const st = fs.statSync(cachePath);
        if (_modelsCache && _modelsCache.mtime === st.mtimeMs) return _modelsCache.items;
        const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        const items = Array.isArray(data && data.models)
          ? data.models.map((m) => {
              if (typeof m === 'string') return { id: m, name: m };
              if (m && m.slug) return { id: m.slug, name: m.display_name || m.slug };
              return null;
            }).filter(Boolean)
          : [];
        _modelsCache = { mtime: st.mtimeMs, items };
        return items;
      } catch { _modelsCache = null; return null; }
    }

    /* ---------------- 定时任务模块 ---------------- */
    const TASKS_FILE = path.join(STATE_DIR, 'tasks.json');
    const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
    function loadTasks() {
      try { const a = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
    }
    function saveTasks(t) { try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(TASKS_FILE, JSON.stringify(t, null, 2)); } catch {} }
    function atToday(d, hhmm) { const [h, m] = String(hhmm || '09:00').split(':').map(Number); const x = new Date(d); x.setHours(h || 0, m || 0, 0, 0); return x; }
    // 计算下一次运行时间（ms 时间戳），无下次则返回 null
    function nextRunFor(task, now) {
      const s = task.schedule || {};
      if (s.type === 'once') { const t = new Date(s.at); return isNaN(t) ? null : t.getTime(); }
      if (s.type === 'daily') { let t = atToday(now, s.time); if (t.getTime() <= now.getTime()) t = new Date(t.getTime() + 86400000); return t.getTime(); }
      if (s.type === 'weekly') {
        const dow = (typeof s.dow === 'number') ? s.dow : 1; const base = atToday(now, s.time);
        let add = (dow - base.getDay() + 7) % 7; if (add === 0 && base.getTime() <= now.getTime()) add = 7;
        return base.getTime() + add * 86400000;
      }
      if (s.type === 'interval') {
        const unitMs = s.unit === 'hours' ? 3600000 : s.unit === 'days' ? 86400000 : 60000;
        const n = Math.max(1, Number(s.every) || 1);
        const from = task.lastRun && task.lastRun.at ? new Date(task.lastRun.at).getTime() : new Date(task.createdAt || now).getTime();
        let t = from + n * unitMs; while (t <= now.getTime()) t += n * unitMs; return t;
      }
      return null;
    }
    function isDue(task, now) {
      if (!task.enabled) return false;
      const s = task.schedule || {};
      if (s.type === 'once') { if (task.lastRun) return false; const t = new Date(s.at); return !isNaN(t) && t.getTime() <= now.getTime(); }
      const nr = nextRunFor(task, now); if (nr == null) return false;
      if (task.lastRun && (now.getTime() - new Date(task.lastRun.at).getTime()) < 30000) return false; // 防同周期重复触发
      return nr <= now.getTime();
    }
    function runTask(task, cb) {
      const startedAt = Date.now();
      const finish = (ok, summary) => {
        task.lastRun = { at: new Date(startedAt).toISOString(), ok: !!ok, summary: String(summary || '').slice(0, 4000) };
        const all = loadTasks(); const i = all.findIndex((x) => x.id === task.id);
        if (i >= 0) { all[i] = task; saveTasks(all); }
        if (cb) cb(!!ok, task.lastRun.summary);
      };
      const a = task.action || {};
      if (a.type === 'shell') {
        let out = '', err = '';
        // 显式启动隐藏的 shell，而不是 shell:true（后者会再套一层 cmd.exe，并有参数拼接告警）
        const exe = IS_WIN ? comspecPath() : '/bin/sh';
        const pre = IS_WIN ? ['/d', '/s', '/c', String(a.command || '')] : ['-c', String(a.command || '')];
        const child = spawn(exe, pre, hidden({ cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }));
        const to = setTimeout(() => { try { child.kill(); } catch {} }, 1000 * 60 * 10); to.unref && to.unref();
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => finish(code === 0, (out + err).trim().slice(0, 4000) || ('exit ' + code)));
        child.on('error', (e) => finish(false, '启动失败: ' + e.message));
        return;
      }
      if (a.type === 'chat') {
        const sandbox = a.sandbox || 'read-only';
        const args = ['exec', '--json', '-C', root, '--skip-git-repo-check', '-s', sandbox,
          '-c', 'mcp_servers={}', '-c', 'plugins={}', '-c', 'features.apps=false',
          '-c', 'features.browser_use=false', '-c', 'features.remote_plugin=false',
          '-c', 'features.unbounded_connection_retries=false'];
        const provider = readCodexProvider();
        if (provider) args.push('-c', 'model_provider=' + provider);
        if (a.model && typeof a.model === 'string' && a.model.trim()) args.push('-m', a.model.trim());
        args.push(a.prompt || '');
        const launch = resolveCodexLaunch();
        if (!launch) return finish(false, CODEX_MISSING);
        let child;
        try {
          child = spawn(launch.cmd, [...launch.prefix, ...args], hidden({ cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }));
        } catch (e) { return finish(false, '无法启动 codex: ' + e.message); }
        let buf = '', text = '';
        const to = setTimeout(() => { try { child.kill(); } catch {} }, 1000 * 60 * 10); to.unref && to.unref();
        child.stdout.on('data', (d) => {
          buf += d.toString('utf8'); let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith('{')) continue;
            let ev; try { ev = JSON.parse(line); } catch { continue; }
            if (ev.type === 'turn.completed' || ev.type === 'thread.message') {
              const t = (ev.item && (ev.item.text || (ev.item.content && JSON.stringify(ev.item.content)))) || ev.text || '';
              if (t) text = t;
            }
          }
        });
        let errBuf = ''; child.stderr.on('data', (d) => { errBuf += d; });
        child.on('close', (code) => finish(code === 0, (text.trim() || errBuf.trim().slice(0, 1500) || ('exit ' + code)).slice(0, 4000)));
        child.on('error', (e) => finish(false, 'codex 错误: ' + e.message));
        return;
      }
      finish(false, '未知动作类型: ' + a.type);
    }
    let _taskInflight = 0; const MAX_INFLIGHT = 3; const _taskRunningIds = new Set();
    function taskTick() {
      const now = new Date(); const tasks = loadTasks();
      for (const t of tasks) {
        if (_taskInflight >= MAX_INFLIGHT) break;
        if (_taskRunningIds.has(t.id)) continue;
        if (isDue(t, now)) { _taskRunningIds.add(t.id); _taskInflight++; runTask(t, () => { _taskRunningIds.delete(t.id); _taskInflight--; }); }
      }
    }
    function startScheduler() { taskTick(); const iv = setInterval(taskTick, 15000); if (iv.unref) iv.unref(); }

    // 弹出系统原生目录选择对话框（本地服务进程可直接访问桌面），用于选择文件仓库
    function pickDirectory(cb) {
      let c;
      if (process.platform === 'win32') {
        const ps = "Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.Form; $f.TopMost=$true; $f.ShowInTaskbar=$false; $f.WindowState=[System.Windows.Forms.FormWindowState]::Minimized; $f.Opacity=0; $f.Show(); $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='选择文件仓库目录'; $r=$d.ShowDialog($f); $f.Close(); if($r -eq [System.Windows.Forms.DialogResult]::OK){$d.SelectedPath}";
        c = spawn('powershell.exe', ['-Sta', '-NoProfile', '-Command', ps], { windowsHide: true });
      } else if (process.platform === 'darwin') {
        c = spawn('osascript', ['-e', 'choose folder with prompt "选择文件仓库目录"', '-e', 'POSIX path of result']);
      } else {
        c = spawn('zenity', ['--file-selection', '--directory', '--title=选择文件仓库目录']);
      }
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', (d) => { /* ignore */ });
      c.on('error', (e) => cb(e));
      c.on('close', () => { const p = (out || '').trim(); if (!p) cb(new Error('cancelled')); else cb(null, p); });
    }

    // static web assets
    if (u.pathname === '/' || u.pathname === '/index.html') {
      return fs.readFile(path.join(WEB_DIR, 'index.html'), (e, b) => e ? send(500, 'missing index.html') : send(200, b, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'Set-Cookie': 'buddy_token=' + token + '; Path=/; SameSite=Strict' }));
    }
    if (u.pathname.startsWith('/web/')) {
      const f = safeJoin(WEB_DIR, u.pathname.slice(5));
      if (!f) return send(403, 'no');
      return fs.readFile(f, (e, b) => e ? send(404, 'no') : send(200, b, { 'Content-Type': guessMime(f), 'Cache-Control': 'no-store' }));
    }

    if (u.pathname === '/api/info') {
      return json({ root, platform: process.platform, pty: !!pty, home: os.homedir(), defaultModel: readCodexModel() });
    }
    if (u.pathname === '/api/models') {
      const def = readCodexModel() || '（未配置）';
      const real = readCodexModels();
      let models;
      if (real && real.length) {
        // 用 codex 本地真实可用模型（含 magpie 反代模型），默认项排最前
        const matched = def !== '（未配置）' ? real.filter((x) => x.id === def) : [];
        const rest = real.filter((x) => x.id !== def);
        if (def !== '（未配置）' && matched.length === 0) matched.push({ id: def, name: def });
        models = [...matched, ...rest];
      } else {
        // 兜底：codex 尚未拉取过模型缓存时，退回写死的常见预设
        const presets = ['workbuddy/deepseek-v4.1-flash', 'workbuddy/deepseek-v4.1', 'gpt-5.1-codex', 'gpt-5.1', 'gpt-5-codex', 'o3', 'o4-mini', 'claude-opus-4-5', 'claude-sonnet-4-5'];
        models = Array.from(new Set([def, ...presets])).filter(Boolean).map((s) => ({ id: s, name: s }));
      }
      return json({ default: def, models });
    }
    if (u.pathname === '/api/setroot') {
      if (req.method !== 'POST') return send(405, 'method');
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let nr;
        try { nr = JSON.parse(body).root; } catch { return send(400, 'invalid json'); }
        if (typeof nr !== 'string' || !nr.trim()) return send(400, 'empty');
        nr = path.resolve(nr.trim());
        try { fs.statSync(nr); } catch { return send(400, '目录不存在'); }
        root = nr; // 改内存中的项目根目录（文件 API / git / chat 全部随之生效）
        try {
          const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
          st.root = nr; st.url = 'http://127.0.0.1:' + st.port + '/';
          fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
        } catch {}
        send(200, JSON.stringify({ ok: true, root: nr }));
      });
      return;
    }
    if (u.pathname === '/api/pickdir') {
      pickDirectory((err, p) => {
        if (err || !p) return send(500, JSON.stringify({ error: '选择已取消或失败' }));
        send(200, JSON.stringify({ path: p }));
      });
      return;
    }
    if (u.pathname === '/api/shells') {
      return detectShells((list) => json({ shells: list }));
    }
    if (u.pathname === '/api/ls') {
      const abs = safeJoin(root, q.get('dir') || '');
      if (!abs) return json({ error: 'outside root' }, 400);
      return listDir(abs, (err, items) => {
        if (err) return json({ error: String(err.message || err) }, 500);
        json({ dir: relFrom(root, abs) || '.', items });
      });
    }
    if (u.pathname === '/api/file') {
      const abs = safeJoin(root, q.get('path') || '');
      if (!abs) return json({ error: 'outside root' }, 400);
      return fsp.readFile(abs).then((b) => {
        if (b.subarray(0, 4).toString('hex') === 'ffd8ffe0' || b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' || b.subarray(0, 6).toString('ascii', 0, 6).startsWith('GIF8') || b.subarray(0, 4).toString('ascii') === 'RIFF' || b.subarray(0, 5).toString('ascii') === '%PDF-') {
          return send(200, b, { 'Content-Type': guessMime(abs) });
        }
        const MAX = 2 * 1024 * 1024;
        const text = b.subarray(0, MAX).toString('utf8');
        const binary = b.subarray(0, 8000).includes(0);
        json({ path: relFrom(root, abs), size: b.length, truncated: b.length > MAX, binary, text });
      }, (e) => json({ error: String(e.message || e) }, 500));
    }
    // 保存文件（可编辑预览面板）
    if (u.pathname === '/api/save') {
      if (req.method !== 'POST') return send(405, 'method');
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 32e6) req.destroy(); });
      req.on('end', () => {
        let pj; try { pj = JSON.parse(body); } catch { return send(400, 'invalid json'); }
        const abs = safeJoin(root, pj.path || '');
        if (!abs) return json({ error: '路径越界' }, 400);
        if (typeof pj.text !== 'string') return json({ error: '缺少内容' }, 400);
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return json({ error: '目标是目录' }, 400);
        fsp.writeFile(abs, pj.text, 'utf8').then(
          () => json({ ok: true, size: Buffer.byteLength(pj.text) }),
          (e) => json({ error: String(e.message || e) }, 500));
      });
      return;
    }
    if (u.pathname === '/api/raw') {
      const abs = safeJoin(root, q.get('path') || '');
      if (!abs) return send(403, 'no');
      return fs.stat(abs, (e, s) => {
        if (e || !s.isFile()) return send(404, 'no');
        res.writeHead(200, { 'Content-Type': guessMime(abs), 'Content-Length': s.size });
        fs.createReadStream(abs).pipe(res);
      });
    }
    if (u.pathname === '/api/git') {
      const abs = safeJoin(root, q.get('path') || '');
      if (!abs) return json({ error: 'outside root' }, 400);
      const probe = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
      return findRepoRoot(probe, (repo) => {
        if (!repo) return json({ repo: null });
        gitStatusObj(repo, root, (err, obj) => { if (err) return json({ repo, error: err }); json(obj); });
      });
    }
    // 可视化 Git 面板：暂存 / 取消暂存 / 放弃更改 / 删除未跟踪 / 提交
    if (u.pathname === '/api/git-action') {
      if (req.method !== 'POST') return send(405, 'method');
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let pj; try { pj = JSON.parse(body); } catch { return send(400, 'invalid json'); }
        const action = pj.action;
        if (!action) return json({ error: 'missing action' }, 400);
        const abs = pj.path ? safeJoin(root, pj.path) : null;
        const probe = abs && fs.existsSync(abs) ? (fs.statSync(abs).isDirectory() ? abs : path.dirname(abs)) : root;
        findRepoRoot(probe, (repo) => {
          if (!repo) return json({ error: '不是 Git 仓库' }, 400);
          // git 返回的仓库路径是正斜杠，而 safeJoin 返回反斜杠，先统一再比较
          const repoN = path.resolve(repo);
          ensureBuddyExclude(repoN);
          if (abs && abs !== repoN && !abs.startsWith(repoN + path.sep)) return json({ error: '文件不在仓库内' }, 400);
          const relToRepo = abs ? path.relative(repoN, abs).split(path.sep).join('/') : '';
          const runGit = (args, done) => gitRun(repoN, args, (err, out, stderr) => {
            if (err) return done((stderr || out || err.message).trim());
            done(null, out);
          });
          const after = (errMsg) => {
            if (errMsg) return json({ error: errMsg }, 400);
            gitStatusObj(repo, root, (e2, obj) => json(obj || { repo, repoRel: relFrom(root, repo) || '.', branch: '', ahead: 0, behind: 0, files: {} }));
          };
          if (action === 'stage') return runGit(['add', '--', relToRepo], after);
          if (action === 'unstage') return runGit(['reset', 'HEAD', '--', relToRepo], after);
          if (action === 'discard') {
            // 从 HEAD 恢复：同时清掉暂存区与工作区改动（git checkout -- 只还原工作区，暂存改动会残留）
            return runGit(['checkout', 'HEAD', '--', relToRepo], (e) => {
              if (!e) return after(null);
              // 新增文件不在 HEAD：取消暂存并删除工作区文件
              runGit(['rm', '--cached', '--force', '--', relToRepo], (e2) => {
                if (e2) return after(e);
                fs.unlink(abs, (e3) => after(e3 && e3.code !== 'ENOENT' ? e3.message : null));
              });
            });
          }
          if (action === 'delete') { // 删除未跟踪文件
            if (!abs) return json({ error: '需要 path' }, 400);
            fs.unlink(abs, (e) => { if (e) return json({ error: e.message }, 400); gitStatusObj(repo, root, (e2, obj) => json(obj || { repo, repoRel: relFrom(root, repo) || '.', branch: '', ahead: 0, behind: 0, files: {} })); });
            return;
          }
          if (action === 'clean-untracked') return runGit(['clean', '-fd'], after);
          if (action === 'stage-all') return runGit(['add', '-A'], after);
          if (action === 'reset') {
            if (!pj.hash || !/^[0-9a-f]{4,40}$/i.test(pj.hash)) return json({ error: '无效提交' }, 400);
            return runGit(['reset', '--hard', pj.hash], after);
          }
          if (action === 'checkout') {
            if (!pj.name || !/^[\w./-]+$/.test(pj.name)) return json({ error: '无效分支名' }, 400);
            return runGit(pj.create ? ['checkout', '-b', pj.name] : ['checkout', pj.name], after);
          }
          if (action === 'commit') {
            if (!pj.message || !pj.message.trim()) return json({ error: '提交信息为空' }, 400);
            const commit = () => runGit(['commit', '-m', pj.message], after);
            if (pj.all && !pj.path) return runGit(['add', '-A'], (e) => e ? after(e) : commit());
            // 没有已暂存内容时给出中文提示（git diff --cached --quiet 退出码 0 表示无暂存）
            return runGit(['diff', '--cached', '--quiet'], (e) => {
              if (!e) return json({ error: '没有已暂存的更改：请先点击文件旁的「暂存」，或使用「暂存并提交」' }, 400);
              return commit();
            });
          }
          return json({ error: '未知 action: ' + action }, 400);
        });
      });
      return;
    }
    // 上传附件：写盘到项目内 .buddy-attachments（供 codex 读取 / -i 图片）
    if (u.pathname === '/api/upload') {
      if (req.method !== 'POST') return send(405, 'method');
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 32e6) req.destroy(); });
      req.on('end', () => {
        let pj; try { pj = JSON.parse(body); } catch { return send(400, 'invalid json'); }
        const name = String(pj.name || '').replace(/[\\/]/g, '').replace(/^\.+/, '').slice(0, 120);
        if (!name) return json({ error: '缺少文件名' }, 400);
        if (typeof pj.data !== 'string' || !pj.data) return json({ error: '缺少数据' }, 400);
        const dir = path.join(root, '.buddy-attachments');
        let target = path.join(dir, name);
        if (fs.existsSync(target)) {
          const ext = path.extname(name); const base = name.slice(0, name.length - ext.length) || name;
          let i = 1; while (fs.existsSync(target)) { target = path.join(dir, base + '_' + i + ext); i++; }
        }
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(target, Buffer.from(pj.data, 'base64'));
        } catch (e) { return json({ error: '写入失败: ' + e.message }, 500); }
        return json({ path: relFrom(root, target), size: fs.statSync(target).size });
      });
      return;
    }
    // 定时任务：列表
    if (u.pathname === '/api/tasks' && req.method === 'GET') {
      const tasks = loadTasks().map((t) => Object.assign({}, t, { nextRun: nextRunFor(t, new Date()) }));
      return json({ tasks });
    }
    // 定时任务：新建 / 更新
    if (u.pathname === '/api/tasks' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let pj; try { pj = JSON.parse(body); } catch { return send(400, 'invalid json'); }
        if (!pj.name || !String(pj.name).trim()) return send(400, '缺少任务名');
        if (!pj.schedule || !pj.schedule.type) return send(400, '缺少调度方式');
        if (!pj.action || !pj.action.type) return send(400, '缺少执行动作');
        const tasks = loadTasks(); let t;
        if (pj.id) { t = tasks.find((x) => x.id === pj.id); if (!t) return send(404, '任务不存在'); }
        else { t = { id: crypto.randomBytes(6).toString('hex'), createdAt: new Date().toISOString(), enabled: true, lastRun: null }; tasks.push(t); }
        t.name = String(pj.name).trim();
        t.enabled = pj.enabled !== false;
        t.schedule = pj.schedule;
        t.action = pj.action;
        t.updatedAt = new Date().toISOString();
        saveTasks(tasks);
        return json({ ok: true, task: Object.assign({}, t, { nextRun: nextRunFor(t, new Date()) }) });
      });
      return;
    }
    // 定时任务：删除
    if (u.pathname === '/api/tasks' && req.method === 'DELETE') {
      const id = q.get('id'); if (!id) return send(400, '缺少 id');
      saveTasks(loadTasks().filter((x) => x.id !== id));
      return json({ ok: true });
    }
    // 定时任务：手动立即运行
    if (u.pathname === '/api/tasks/run' && req.method === 'POST') {
      const id = q.get('id'); const t = loadTasks().find((x) => x.id === id);
      if (!t) return send(404, '任务不存在');
      runTask(t, () => {});
      return json({ ok: true });
    }
    // 会话历史记录：读取（持久化在 ~/.codex/codebuddy-workbench/chat-history.json）
    if (u.pathname === '/api/history' && req.method === 'GET') {
      return json({ history: loadHistoryFile() });
    }
    // 会话历史记录：整体写入（客户端合并后上传，服务端为唯一真源）
    if (u.pathname === '/api/history' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 20 * 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        let pj; try { pj = JSON.parse(body); } catch { return send(400, 'invalid json'); }
        const arr = Array.isArray(pj && pj.history) ? pj.history : [];
        saveHistoryFile(arr);
        return json({ ok: true });
      });
      return;
    }
    // 读取 / 写入 codex 真实配置（~/.codex/config.toml）：model、[windows] sandbox、[mcp_servers]
    if (u.pathname === '/api/codex-config' && req.method === 'GET') {
      const t = readCfg();
      return json({ ok: true, model: cfgModel(t), sandbox: cfgSandbox(t), mcp: cfgMcp(t) });
    }
    if (u.pathname === '/api/codex-config' && req.method === 'POST') {
      let body = ''; req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let pj; try { pj = JSON.parse(body); } catch { return send(400, 'invalid json'); }
        let t = readCfg(); let changed = false;
        if (typeof pj.model === 'string' && pj.model.trim()) { t = setModel(t, pj.model.trim()); changed = true; }
        if (typeof pj.sandbox === 'string' && pj.sandbox.trim()) { t = setWindowsSandbox(t, pj.sandbox.trim()); changed = true; }
        if (Array.isArray(pj.mcp)) { for (const op of pj.mcp) { if (!op || !op.name) continue; if (op.op === 'add') { t = mcpAdd(t, op.name, op.command || '', op.enabled !== false); changed = true; } else if (op.op === 'remove') { t = mcpRemove(t, op.name); changed = true; } else if (op.op === 'toggle') { t = mcpToggle(t, op.name); changed = true; } } }
        if (!changed) return json({ ok: true });
        if (!writeCfg(t)) return send(500, 'write failed');
        return json({ ok: true, model: cfgModel(t), sandbox: cfgSandbox(t), mcp: cfgMcp(t) });
      });
      return;
    }
    // 全局规则：~/.codex/AGENTS.md（codex 启动时作为系统指令读取）
    if (u.pathname === '/api/codex-agents-md' && req.method === 'GET') { let c = ''; try { c = fs.readFileSync(CODEX_AGENTS, 'utf8'); } catch {} return json({ ok: true, content: c }); }
    if (u.pathname === '/api/codex-agents-md' && req.method === 'POST') {
      let body = ''; req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => { let pj; try { pj = JSON.parse(body); } catch { return send(400, 'invalid json'); } try { fs.mkdirSync(path.dirname(CODEX_AGENTS), { recursive: true }); fs.writeFileSync(CODEX_AGENTS, pj.content || ''); return json({ ok: true }); } catch { return send(500, 'write failed'); } });
      return;
    }
    // 记忆：~/.codex/memories
    if (u.pathname === '/api/codex-memories' && req.method === 'GET') {
      let files = []; try { files = fs.readdirSync(CODEX_MEM).filter((f) => { try { return fs.statSync(path.join(CODEX_MEM, f)).isFile(); } catch { return false; } }); } catch {}
      return json({ ok: true, files: files.map((f) => { let sz = 0; try { sz = fs.statSync(path.join(CODEX_MEM, f)).size; } catch {} return { name: f, size: sz }; }) });
    }
    if (u.pathname === '/api/codex-memories' && req.method === 'POST') {
      let body = ''; req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let pj; try { pj = JSON.parse(body); } catch { return send(400, 'invalid json'); }
        const d = CODEX_MEM; const n = sanName(pj.name);
        try {
          fs.mkdirSync(d, { recursive: true });
          if (pj.op === 'read') { try { return json({ ok: true, content: fs.readFileSync(path.join(d, n), 'utf8') }); } catch { return send(404, 'no'); } }
          if (pj.op === 'save') { fs.writeFileSync(path.join(d, n), pj.content || ''); return json({ ok: true }); }
          if (pj.op === 'delete') { fs.unlinkSync(path.join(d, n)); return json({ ok: true }); }
        } catch { return send(500, 'io error'); }
        return send(400, 'bad op');
      });
      return;
    }
    // 回退本次对话对工作区产生的改动：新增文件删除；修改/删除文件用 git checkout 还原
    if (u.pathname === '/api/rollback' && req.method === 'POST') {
      let body = ''; req.on('data', (d) => { body += d; if (body.length > 2e6) req.destroy(); });
      req.on('end', () => {
        let pj; try { pj = JSON.parse(body); } catch { return send(400, 'invalid json'); }
        const changes = Array.isArray(pj && pj.changes) ? pj.changes : [];
        const r = path.resolve(root);
        gitRun(r, ['rev-parse', '--is-inside-work-tree'], (err, out) => {
          const isGit = !err && /true/.test(out);
          const reverted = []; const failed = [];
          const queue = changes.slice(0, 500);
          const next = (i) => {
            if (i >= queue.length) return json({ ok: true, git: isGit, reverted, failed });
            const ch = queue[i] || {}; const abs = safeJoin(root, ch.path || '');
            if (!abs) { failed.push({ path: ch.path, reason: 'bad path' }); return next(i + 1); }
            const rel = relFrom(root, abs); const kind = ch.kind || 'update';
            const done = (ok, reason) => { if (ok) reverted.push(rel); else failed.push({ path: rel, reason: reason || 'failed' }); next(i + 1); };
            if (kind === 'add') {
              try { if (fs.existsSync(abs)) { fs.unlinkSync(abs); done(true); } else done(true, 'not found'); } catch (e) { done(false, e.message); }
              return;
            }
            if (!isGit) return done(false, 'not a git repo');
            gitRun(r, ['checkout', '--', rel], (e2) => done(!e2, e2 ? 'git checkout failed' : ''));
          };
          next(0);
        });
      });
      return;
    }
    // 列出 codex 自带技能（同步自 ~/.codex/skills），供聊天 / 面板调用
    if (u.pathname === '/api/skills') {
      const home = path.join(os.homedir(), '.codex', 'skills');
      const out = [];
      const walk = (dir, depth) => {
        let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name === '..' || e.name === '.git') continue;
          const fp = path.join(dir, e.name);
          if (!e.isDirectory()) continue;
          const sk = path.join(fp, 'SKILL.md');
          if (fs.existsSync(sk)) {
            let txt = ''; try { txt = fs.readFileSync(sk, 'utf8'); } catch {}
            const fm = txt.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
            let name = e.name, desc = '';
            if (fm) {
              const m1 = fm[1].match(/name:\s*"([^"]*)"/); const m2 = fm[1].match(/description:\s*"([^"]*)"/);
              if (m1) name = m1[1]; if (m2) desc = m2[1];
            }
            out.push({ name, dir: fp, description: desc });
          } else if (depth < 3) walk(fp, depth + 1);
        }
      };
      walk(home, 0);
      return json({ skills: out });
    }
    // 某文件的改动（unified diff）：已跟踪用 git diff HEAD，未跟踪生成全 + 的 diff
    if (u.pathname === '/api/git-diff') {
      const rel = q.get('path') || '';
      const abs = safeJoin(root, rel);
      if (!abs) return json({ error: '路径越界' }, 400);
      const probe = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
      return findRepoRoot(probe, (repo) => {
        if (!repo) return json({ error: '不是 Git 仓库', diff: '' }, 400);
        const repoN = path.resolve(repo);
        const relToRepo = path.relative(repoN, abs).split(path.sep).join('/');
        const hash = q.get('hash') || '';
        if (hash) {
          if (!/^[0-9a-f]{4,40}$/i.test(hash)) return json({ error: '无效提交', diff: '' }, 400);
          return gitRun(repoN, ['show', '--pretty=format:', '--no-color', hash, '--', relToRepo],
            (e, out) => json({ diff: e ? '' : out, path: rel, hash }));
        }
        gitRun(repoN, ['ls-files', '--error-unmatch', '--', relToRepo], (err) => {
          if (!err) {
            const done = (out) => json({ diff: out || '', path: rel });
            return gitRun(repoN, ['diff', 'HEAD', '--', relToRepo], (e2, out2) => {
              if (!e2) return done(out2);
              return gitRun(repoN, ['diff', '--cached', '--', relToRepo], (e3, out3) => {
                if (!e3 && out3.trim()) return done(out3);
                gitRun(repoN, ['diff', '--', relToRepo], (e4, out4) => done(e4 ? '' : out4));
              });
            });
          }
          // 未跟踪文件：整份内容当作新增
          fs.readFile(abs, 'utf8', (e, content) => {
            if (e) return json({ error: e.message, diff: '' }, 400);
            const lines = String(content).split(/\r?\n/);
            let d = '--- /dev/null\n+++ b/' + relToRepo + '\n@@ -0,0 +1,' + lines.length + ' @@\n';
            d += lines.map((l) => '+' + l).join('\n') + '\n';
            json({ diff: d, path: rel, untracked: true });
          });
        });
      });
    }
    // 列出本地分支（供切换）
    if (u.pathname === '/api/git-branches') {
      const abs = safeJoin(root, q.get('path') || '');
      const probe = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : (fs.existsSync(abs) ? path.dirname(abs) : root);
      return findRepoRoot(probe, (repo) => {
        if (!repo) return json({ error: '不是 Git 仓库' }, 400);
        const repoN = path.resolve(repo);
        gitRun(repoN, ['branch', '--format=%(HEAD)%09%(refname:short)'], (err, out) => {
          if (err) return json({ error: String(out || err.message) }, 500);
          const branches = []; let current = '';
          for (const ln of out.split(/\r?\n/)) {
            if (!ln.trim()) continue;
            const cur = ln[0] === '*';
            const name = ln.slice(1).replace(/^\t/, '').trim();
            if (name) { branches.push({ name, current: cur }); if (cur) current = name; }
          }
          let main = '';
          if (branches.some((b) => b.name === 'main')) main = 'main';
          else if (branches.some((b) => b.name === 'master')) main = 'master';
          json({ branches, current, main });
        });
      });
    }
    // 文件树操作：重命名 / 删除 / 新建文件 / 新建目录 / 在文件资源管理器中显示
    if (u.pathname === '/api/fs-action') {
      if (req.method !== 'POST') return send(405, 'method');
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let pj; try { pj = JSON.parse(body); } catch { return send(400, 'invalid json'); }
        const action = pj.action;
        if (!action) return json({ error: 'missing action' }, 400);
        const abs = pj.path != null ? safeJoin(root, pj.path) : root;
        if (!abs) return json({ error: '路径越界' }, 400);
        const parent = fs.existsSync(abs) ? (fs.statSync(abs).isDirectory() ? abs : path.dirname(abs)) : path.dirname(abs);
        const finish = (err) => { if (err) return json({ error: String(err.message || err) }, 400); json({ ok: true }); };
        if (action === 'rename') {
          if (!pj.name || !pj.name.trim()) return json({ error: '缺少新名称' }, 400);
          const target = path.join(parent, pj.name.trim());
          if (target !== root && !target.startsWith(root + path.sep)) return json({ error: '目标越界' }, 400);
          if (fs.existsSync(target)) return json({ error: '已存在同名项' }, 400);
          return fsp.rename(abs, target).then(() => finish(null)).catch(finish);
        }
        if (action === 'delete') return fsp.rm(abs, { recursive: true, force: true }).then(() => finish(null)).catch(finish);
        if (action === 'mkdir') {
          const target = path.join(parent, (pj.name || '').trim());
          if (!target.startsWith(root + path.sep)) return json({ error: '名称无效' }, 400);
          return fsp.mkdir(target, { recursive: true }).then(() => finish(null)).catch(finish);
        }
        if (action === 'newfile') {
          const target = path.join(parent, (pj.name || '').trim());
          if (!target.startsWith(root + path.sep)) return json({ error: '名称无效' }, 400);
          return fsp.writeFile(target, '').then(() => finish(null)).catch(finish);
        }
        if (action === 'reveal') {
          try {
            if (process.platform === 'win32') spawn('explorer', ['/select,' + abs], { detached: true, stdio: 'ignore' }).unref();
            else if (process.platform === 'darwin') spawn('open', ['-R', abs], { detached: true, stdio: 'ignore' }).unref();
            else spawn('xdg-open', [fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs)], { detached: true, stdio: 'ignore' }).unref();
          } catch (e) { return finish(e); }
          return json({ ok: true });
        }
        return json({ error: '未知 action: ' + action }, 400);
      });
      return;
    }
    if (u.pathname === '/api/git-log') {
      const abs = safeJoin(root, q.get('path') || '');
      if (!abs) return json({ error: 'outside root' }, 400);
      const probe = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
      return findRepoRoot(probe, (repo) => {
        if (!repo) return json({ repo: null, commits: [] });
        gitRun(repo, ['log', '--oneline', '--decorate', '-n', '50'], (err, out) => {
          json({ repo, commits: err ? [] : out.split(/\r?\n/).filter(Boolean) });
        });
      });
    }
    if (u.pathname === '/api/git-graph') {
      const abs = safeJoin(root, q.get('path') || '');
      if (!abs) return json({ error: 'outside root' }, 400);
      const probe = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
      return findRepoRoot(probe, (repo) => {
        if (!repo) return json({ repo: null, commits: [] });
        const N = Math.min(400, Math.max(10, parseInt(q.get('limit') || '200', 10) || 200));
        gitRun(repo, ['log', '--all', '--date-order', '-n', String(N),
          '--pretty=format:%H%x09%h%x09%P%x09%an%x09%at%x09%s%x09%D'], (err, out) => {
          if (err) return json({ repo, error: out || err.message, commits: [] });
          const commits = [];
          for (const ln of out.split(/\r?\n/)) {
            if (!ln.trim()) continue;
            const c = ln.split('\t');
            if (c.length < 7) continue;
            commits.push({
              hash: c[0], short: c[1],
              parents: c[2] ? c[2].split(' ') : [],
              author: c[3], at: +c[4] || 0, subject: c[5],
              refs: c[6] ? c[6].split(', ').map((s) => s.replace(/^HEAD -> /, '')).filter(Boolean) : [],
            });
          }
          gitRun(repo, ['status', '--porcelain=v1', '-b'], (e2, out2) => {
            let branch = '', ahead = 0, behind = 0;
            if (!e2) {
              for (const ln of out2.split(/\r?\n/)) {
                if (ln.startsWith('## ')) {
                  const body = ln.slice(3);
                  branch = body.split('...')[0].trim().replace(/^\(no branch.*\)$/, 'DETACHED');
                  const a = body.match(/ahead (\d+)/); const b = body.match(/behind (\d+)/);
                  ahead = a ? +a[1] : 0; behind = b ? +b[1] : 0;
                }
              }
            }
            json({ repo, repoRel: relFrom(root, repo) || '.', branch, ahead, behind, commits });
          });
        });
      });
    }
    if (u.pathname === '/api/git-show') {
      const abs = safeJoin(root, q.get('path') || '');
      const hash = String(q.get('hash') || '').trim();
      if (!abs || !/^[0-9a-f]{4,40}$/i.test(hash)) return json({ error: 'bad params' }, 400);
      const probe = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
      return findRepoRoot(probe, (repo) => {
        if (!repo) return json({ repo: null });
        gitRun(repo, ['show', '--name-status', '--find-renames', '--pretty=format:%H%x09%an%x09%at%x09%s%x09%b%x09%G?', hash], (err, out) => {
          if (err) return json({ repo, error: out || err.message });
          const lines = out.split(/\r?\n/);
          const head = (lines.shift() || '').split('\t');
          const files = [];
          for (const ln of lines) {
            if (!ln.trim() || ln.startsWith('\t')) continue;
            const parts = ln.split('\t');
            const st = parts[0].trim();
            const name = parts.length > 2 && (st[0] === 'R' || st[0] === 'C') ? parts[2] : parts[1];
            if (name) files.push({ st, name });
          }
          json({ repo, hash: head[0], author: head[1], at: +head[2] || 0, subject: head[3], body: head[4] || '', gpg: head[5] || '', files });
        });
      });
    }
    send(404, 'not found');
  }

  /* ---- WebSocket upgrades ---- */
  server.on('upgrade', (req, socket) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const ck = String(req.headers.cookie || '').split(';').some((kv) => kv.trim() === 'buddy_token=' + token);
    if (u.searchParams.get('token') !== token && !ck) { socket.destroy(); return; }
    if (u.pathname === '/ws/term') return termWS(req, socket);
    if (u.pathname === '/ws/chat') return chatWS(req, socket);
    socket.destroy();
  });

  /* ---- terminal ---- */
  function termWS(req, socket) {
    let proc = null;
    const ws = attachWS(req, socket, (msg, send) => {
      let m; try { m = JSON.parse(msg); } catch { return; }
      if (m.type === 'spawn') {
        if (!pty) { send({ type: 'error', message: 'node-pty 不可用（当前 Node 环境缺少 ConPTY 原生模块）' }); return; }
        if (proc) { try { proc.kill(); } catch {} proc = null; }
        const shell = m.shell && fs.existsSync(m.shell) ? m.shell : (process.env.COMSPEC || 'cmd.exe');
        const cols = Math.max(20, m.cols || 80), rows = Math.max(5, m.rows || 24);
        try {
          proc = pty.spawn(shell, m.args || [], {
            name: 'xterm-256color', cols, rows, cwd: safeJoin(root, m.cwd || '') || root,
            env: Object.assign({}, process.env, { TERM: 'xterm-256color', COLORTERM: 'truecolor' }),
          });
        } catch (e) { send({ type: 'error', message: '启动终端失败: ' + e.message }); return; }
        proc.onData((d) => send({ type: 'data', data: d }));
        proc.onExit(({ exitCode }) => { send({ type: 'exit', exitCode }); proc = null; });
        send({ type: 'spawned', shell });
      } else if (m.type === 'input' && proc) {
        proc.write(String(m.data || ''));
      } else if (m.type === 'resize' && proc) {
        try { proc.resize(Math.max(20, m.cols | 0), Math.max(5, m.rows | 0)); } catch {}
      } else if (m.type === 'kill' && proc) {
        try { proc.kill(); } catch {} proc = null;
      }
    }, () => { if (proc) { try { proc.kill(); } catch {} proc = null; } });
    if (ws) ws.send({ type: 'hello', pty: !!pty });
  }

  /* ---- chat (codex exec bridge) —— 支持多会话并发 ---- */
  function chatWS(req, socket) {
    const sessions = new Map(); // sid -> { child, threadId }
    const killChildProc = (c) => { try { if (IS_WIN) execFile('taskkill', ['/PID', String(c.pid), '/T', '/F'], hidden(), () => {}); else c.kill(); } catch {} };
    const ws = attachWS(req, socket, (msg, send) => {
      let m; try { m = JSON.parse(msg); } catch { return; }
      const sid = m.session || 'default';
      if (m.type === 'abort') {
        const s = sessions.get(sid);
        if (s && s.child) { killChildProc(s.child); s.child = null; }
        send({ type: 'status', state: 'aborted', session: sid });
        return;
      }
      if (m.type !== 'send') return;
      if (!sessions.has(sid)) sessions.set(sid, { child: null, threadId: null });
      const sess = sessions.get(sid);
      if (sess.child) { send({ type: 'error', message: '该会话已有任务在运行，请等待完成或先中止', session: sid }); return; }
      const emit = (o) => send(Object.assign({}, o, { session: sid }));
      const prompt = String(m.text || '').trim();
      if (!prompt) return;
      const sandbox = m.sandbox || 'workspace-write';
      const baseArgs = ['exec', '--json', '-C', root, '--skip-git-repo-check', '-s', sandbox,
        '-c', 'mcp_servers={}', '-c', 'plugins={}', '-c', 'features.apps=false',
        '-c', 'features.browser_use=false', '-c', 'features.remote_plugin=false',
        '-c', 'features.unbounded_connection_retries=false'];
      const provider = readCodexProvider();
      if (provider) baseArgs.push('-c', 'model_provider=' + provider);
      // 附件：图片走 codex -i（仅首轮生效），故含图片时放弃续聊、开新会话
      const codexHome = path.join(os.homedir(), '.codex');
      const imgArgs = [];
      for (const a of (Array.isArray(m.attachments) ? m.attachments : [])) {
        let abs = safeJoin(root, a.path || '');
        if (!abs) {
          const cand = path.resolve(codexHome, String(a.path || '').replace(/^[\\/]/, ''));
          if (cand.startsWith(codexHome + path.sep)) abs = cand;
        }
        if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
        if (a.kind === 'image') imgArgs.push('-i', abs);
      }
      for (const x of imgArgs) baseArgs.push(x);
      const hasImg = imgArgs.length > 0;
      const chosenModel = (m.model && typeof m.model === 'string' && m.model.trim()) ? m.model.trim() : '';
      const fallbackModel = process.env.BUDDY_FALLBACK_MODEL || 'auto/auto';
      const isRateLimit = (s) => /429|too many requests|rate limit|exceeded retry limit/i.test(String(s || ''));
      const startOnce = (model, isRetry) => {
        const args = baseArgs.slice();
        if (model) args.push('-m', model);
        const threadId = sess.threadId;
        if (!isRetry && threadId && m.resume !== false && !hasImg) args.push('resume', threadId, prompt);
        else args.push(prompt);
        if (hasImg && threadId && !isRetry) emit({ type: 'note', text: '检测到图片附件，已开启新会话（图片仅首轮生效）' });
        let child;
        const launch = resolveCodexLaunch();
        if (!launch) {
          emit({ type: 'error', message: CODEX_MISSING });
          emit({ type: 'status', state: 'failed' });
          return;
        }
        try {
          child = spawn(launch.cmd, [...launch.prefix, ...args], hidden({ cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }));
        } catch (e) { emit({ type: 'error', message: '无法启动 codex: ' + e.message }); return; }
        sess.child = child;
        emit({ type: 'status', state: 'running', threadId: sess.threadId });
        let lineBuf = '', errBuf = '', sawLimit = false;
        child.stdout.on('data', (d) => {
          lineBuf += d.toString('utf8');
          let i;
          while ((i = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, i).trim(); lineBuf = lineBuf.slice(i + 1);
            if (!line.startsWith('{')) continue;
            let ev; try { ev = JSON.parse(line); } catch { continue; }
            if (ev.type === 'thread.started') { sess.threadId = ev.thread_id || ev.id || sess.threadId; }
            if (ev.type === 'error' && isRateLimit(ev.message)) sawLimit = true;
            if (ev.type === 'turn.failed' && isRateLimit(ev.error && ev.error.message)) sawLimit = true;
            emit({ type: 'codex', event: ev, threadId: sess.threadId });
            // 检测到限流就提前结束本次（避免 codex 无谓重试 5 次拖很久），交给 close 触发回退
            if (sawLimit && !isRetry && fallbackModel && fallbackModel !== model && !child.__fbKilled) {
              child.__fbKilled = true;
              killChildProc(child);
            }
          }
        });
        child.stderr.on('data', (d) => { errBuf += d.toString('utf8'); });
        child.on('close', (code) => {
          if (errBuf.trim()) emit({ type: 'codex-stderr', text: errBuf.slice(0, 4000) });
          // 限流（429）且可用回退模型时，自动改用回退模型重试一次
          if (code !== 0 && !isRetry && fallbackModel && fallbackModel !== model && (sawLimit || isRateLimit(errBuf))) {
            sess.child = null;
            emit({ type: 'note', text: '当前模型触发限流（429），已自动改用 ' + fallbackModel + ' 重试一次…' });
            startOnce(fallbackModel, true);
            return;
          }
          emit({ type: 'status', state: code === 0 ? 'done' : 'failed', code, threadId: sess.threadId });
          sess.child = null;
        });
        child.on('error', (e) => { emit({ type: 'error', message: 'codex 进程错误: ' + e.message }); sess.child = null; });
      };
      startOnce(chosenModel, false);
    }, () => {
      for (const s of sessions.values()) { if (s.child) killChildProc(s.child); }
    });
    if (ws) ws.send({ type: 'hello' });
  }
  try { startScheduler(); } catch {}
  return server;
}

/* ---------------- 打开浏览器（不产生命令行窗口） ----------------
 * Windows 上原来的 cmd /c start + shell:true 会连开两层 cmd.exe，是启动工作台时
 * 黑框闪现的主因。rundll32 / explorer / open / xdg-open 都是 GUI 程序，不会创建
 * 控制台窗口；它们不能带 windowsHide，否则正常窗口也会被隐藏。
 */
function openBrowser(url) {
  const guiSpawn = (cmd, args) => {
    try {
      const c = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      c.on('error', () => {});
      c.unref();
      return c;
    } catch { return null; }
  };
  if (IS_WIN) {
    const c = guiSpawn('rundll32', ['url.dll,FileProtocolHandler', url]);
    if (c) c.on('error', () => guiSpawn('explorer', [url]));
    else guiSpawn('explorer', [url]);
  } else if (process.platform === 'darwin') guiSpawn('open', [url]);
  else guiSpawn('xdg-open', [url]);
}

/* ---------------- main ---------------- */
(async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.stop) { await stopDaemon(); return; }
  if (a.daemon && !process.env.BUDDY_DAEMON) {
    const st = readState();
    if (st && pidAlive(st.pid)) { console.log('ALREADY_RUNNING ' + st.url); return; }
    spawnDaemon(a.root, a.port, a.open, a.token);
    return;
  }
  process.on('uncaughtException', (e) => { console.error('UNCAUGHT', e && e.stack || e); });
  process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e && e.stack || e); });
  const root = a.root;
  try { await fsp.stat(root); } catch { console.error('root not found: ' + root); process.exit(2); }
  const token = a.token || crypto.randomBytes(12).toString('hex');
  const server = createServer(root, token);
  let port = a.port;
  const tryListen = () => new Promise((res, rej) => {
    const s = server.listen(port, '127.0.0.1', () => res());
    s.once('error', (e) => { if (e.code === 'EADDRINUSE' && port < a.port + 20) { port++; tryListen().then(res, rej); } else rej(e); });
  });
  try { await tryListen(); } catch (e) { console.error('listen failed', e.message); process.exit(3); }
  const url = 'http://127.0.0.1:' + port + '/';
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port, url, token, root, ready: true, startedAt: new Date().toISOString() }, null, 2));
  console.log('BUDDY_READY ' + url + ' token=' + token);
  if (a.open) openBrowser(url + '?token=' + token);
  const shutdown = () => { try { fs.unlinkSync(STATE_FILE); } catch {} process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
})();
