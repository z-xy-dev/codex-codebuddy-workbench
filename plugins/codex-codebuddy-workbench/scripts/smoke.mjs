#!/usr/bin/env node
'use strict';
/*
 * CodeBuddy Workbench 自检脚本（零第三方依赖）
 *
 *   node scripts/smoke.mjs
 *
 * 自动在临时目录里造一个 git 仓库和假的 codex，启动一个完全隔离的服务实例
 * （BUDDY_STATE_DIR / BUDDY_CODEX_BIN），覆盖 HTTP、WebSocket、git、定时任务、
 * PTY 终端与 codex 桥接；结束后停服务并清理临时目录，不触碰用户真实数据。
 * Node >= 22 才会跑 WebSocket 用例（用到内置 WebSocket），旧版本会跳过。
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PLUG = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SERVER = path.join(PLUG, 'skills', 'codebuddy-workbench', 'server', 'server.js');
const PTY_AGENT = path.join(PLUG, 'skills', 'codebuddy-workbench', 'server', 'node-pty', 'lib', 'windowsPtyAgent.js');
const PORT0 = 5599;
const TOKEN = 'smoke-' + crypto.randomBytes(6).toString('hex');
const IS_WIN = process.platform === 'win32';
const HIDE = IS_WIN ? { windowsHide: true } : {};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-smoke-'));
const stateDir = path.join(tmp, 'state');
const fixture = path.join(tmp, 'project');
const fakeCodex = path.join(tmp, 'fake-codex.js');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail && !ok ? '  → ' + detail : ''));
};
const skip = (name, why) => console.log('SKIP  ' + name + '  → ' + why);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 隔离的测试素材 ----
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(fixture, { recursive: true });
fs.writeFileSync(path.join(fixture, 'hello.txt'), 'hello\n');
fs.writeFileSync(fakeCodex, [
  "const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
  "out({ type: 'thread.started', thread_id: 'smoke-thread' });",
  "out({ type: 'item.completed', item: { type: 'agent_message', text: 'SMOKE_OK' } });",
  "out({ type: 'turn.completed' });",
].join('\n'));
const git = (args) => execFileSync('git', ['-C', fixture, ...args], { ...HIDE, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
try {
  git(['init', '-q']);
  git(['add', 'hello.txt']);
  git(['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', 'commit', '-q', '-m', 'init']);
} catch (e) {
  console.error('无法创建 git 测试仓库：' + e.message);
  process.exit(1);
}

// ---- 启动隔离服务 ----
const serverLog = [];
const srv = spawn(process.execPath, [SERVER, '--root', fixture, '--port', String(PORT0), '--no-open', '--token', TOKEN], {
  ...HIDE,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    BUDDY_STATE_DIR: stateDir,
    BUDDY_CODEX_BIN: fakeCodex,
    GIT_AUTHOR_NAME: 'Smoke', GIT_AUTHOR_EMAIL: 'smoke@example.com',
    GIT_COMMITTER_NAME: 'Smoke', GIT_COMMITTER_EMAIL: 'smoke@example.com',
  },
});
srv.stdout.on('data', (d) => serverLog.push(String(d)));
srv.stderr.on('data', (d) => serverLog.push(String(d)));

let BASE = '';
const req = async (p, init) => {
  const sep = p.includes('?') ? '&' : '?';
  try {
    const r = await fetch(BASE + p + sep + 'token=' + TOKEN, init);
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, json, headers: r.headers };
  } catch (e) { return { status: 0, text: e.message, json: null, headers: new Map() }; }
};
const post = (p, body) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function wsSession(url, steps, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (typeof WebSocket === 'undefined') { resolve({ frames: [], unavailable: true }); return; }
    let ws;
    try { ws = new WebSocket(url); } catch (e) { resolve({ frames: [], error: e.message }); return; }
    const frames = [];
    let settled = false;
    const done = (extra) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch {} resolve({ frames, ...extra }); };
    const timer = setTimeout(() => done({ timedOut: true }), timeoutMs);
    ws.onmessage = (ev) => { let o; try { o = JSON.parse(ev.data); } catch { o = { type: 'text', data: String(ev.data) }; } frames.push(o); };
    ws.onerror = () => {};
    ws.onclose = () => done({});
    ws.onopen = async () => {
      for (const [ms, msg] of steps) { await sleep(ms); try { ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch {} }
    };
  });
}

let stoppedByCli = false;
try {
  // 等待服务就绪（端口占用时 server 会自动 +1，逐个探测）
  let ready = null;
  for (let i = 0; i < 40 && !ready; i++) {
    for (let port = PORT0; port < PORT0 + 20 && !ready; port++) {
      BASE = 'http://127.0.0.1:' + port;
      const r = await req('/api/info');
      if (r.status === 200 && r.json && path.resolve(r.json.root) === path.resolve(fixture)) ready = port;
    }
    if (!ready) await sleep(150);
  }
  check('服务启动并监听', ready !== null, '未能在 6 秒内就绪: ' + serverLog.join('').slice(-300));
  if (ready === null) throw new Error('server not ready');
  BASE = 'http://127.0.0.1:' + ready;
  const WS = 'ws://127.0.0.1:' + ready;

  // ---- HTTP / 鉴权 / 静态资源 ----
  check('无 token 的请求被拒绝', (await fetch(BASE + '/api/info')).status === 403);
  const home = await fetch(BASE + '/?token=' + TOKEN);
  check('首页返回 200 并下发 token Cookie', home.status === 200 && /buddy_token=/.test(home.headers.get('set-cookie') || ''));
  const info = await req('/api/info');
  check('/api/info 返回项目根与 PTY 状态', info.status === 200 && info.json.pty === true && info.json.platform === process.platform, info.text);
  const shells = await req('/api/shells');
  check('/api/shells 探测到可用 shell', shells.status === 200 && shells.json.shells.length > 0, shells.text);
  const ls = await req('/api/ls?dir=');
  check('/api/ls 列出测试文件', ls.status === 200 && ls.json.items.some((x) => x.name === 'hello.txt'), ls.text);
  check('路径穿越被拒绝', (await req('/api/ls?dir=..%2F..')).status === 400);
  const file = await req('/api/file?path=hello.txt');
  check('/api/file 读取文本', file.status === 200 && file.json.text.includes('hello'), file.text);
  const js = await req('/web/app.js');
  check('静态资源 /web/app.js', js.status === 200 && js.text.includes('spawnTerm'), String(js.status));
  check('/api/models', (await req('/api/models')).json.models.length > 0);
  check('/api/codex-config GET', (await req('/api/codex-config')).json.ok === true);
  check('/api/skills GET', Array.isArray((await req('/api/skills')).json.skills));
  check('/api/codex-memories GET', (await req('/api/codex-memories')).json.ok === true);
  check('/api/history GET', Array.isArray((await req('/api/history')).json.history));
  check('/api/history POST', (await post('/api/history', { history: [{ id: 'smoke' }] })).json.ok === true);
  check('/api/setroot 拒绝不存在的目录', (await post('/api/setroot', { root: path.join(tmp, 'nope') })).status === 400);
  check('/api/setroot 切换目录', (await post('/api/setroot', { root: fixture })).json.ok === true);

  // ---- git 相关 API ----
  const g = await req('/api/git?path=');
  check('/api/git 识别测试仓库', g.status === 200 && !!g.json.repo && g.json.branch, g.text);
  const branches = await req('/api/git-branches?path=hello.txt');
  check('/api/git-branches 列出分支', branches.status === 200 && branches.json.branches.length > 0, branches.text);
  check('/api/git-log 读取提交', (await req('/api/git-log?path=hello.txt')).json.commits.length > 0);
  const graph = await req('/api/git-graph?path=hello.txt');
  check('/api/git-graph 读取提交图', graph.status === 200 && graph.json.commits.length > 0, graph.text);
  const sha = graph.json.commits[0].hash;
  const show = await req('/api/git-show?path=hello.txt&hash=' + sha);
  check('/api/git-show 读取提交详情', show.status === 200 && show.json.files.length > 0, show.text);
  check('/api/git-diff 读取改动', (await req('/api/git-diff?path=hello.txt')).status === 200);

  // ---- 文件写入 / 附件 / git 操作 ----
  check('/api/save 写入文件', (await post('/api/save', { path: 'hello.txt', text: 'hello smoke\n' })).json.ok === true);
  check('/api/file 读回新内容', (await req('/api/file?path=hello.txt')).json.text.includes('hello smoke'));
  check('/api/raw 返回文件内容', (await req('/api/raw?path=hello.txt')).text.includes('hello smoke'));
  const up = await post('/api/upload', { name: 'note.txt', data: Buffer.from('attachment').toString('base64') });
  check('/api/upload 写入附件', up.json.ok !== false && fs.existsSync(path.join(fixture, '.buddy-attachments', 'note.txt')), up.text);
  const stage = await post('/api/git-action', { action: 'stage', path: 'hello.txt' });
  check('/api/git-action 暂存', stage.status === 200 && !stage.json.error, stage.text);
  const unstage = await post('/api/git-action', { action: 'unstage', path: 'hello.txt' });
  check('/api/git-action 取消暂存', unstage.status === 200 && !unstage.json.error, unstage.text);
  const commit = await post('/api/git-action', { action: 'commit', message: 'smoke update', all: true });
  check('/api/git-action 提交', commit.status === 200 && !commit.json.error, commit.text);
  check('/api/rollback 可调用', (await post('/api/rollback', { changes: [] })).json.ok === true);

  // ---- 定时任务（shell 动作） ----
  const created = await post('/api/tasks', {
    name: 'smoke-shell', schedule: { type: 'once', at: new Date(Date.now() + 86400000).toISOString() },
    action: { type: 'shell', command: 'echo SMOKE_SHELL_OK' },
  });
  check('/api/tasks 创建 shell 任务', created.status === 200 && created.json.task.id, created.text);
  const taskId = created.json.task && created.json.task.id;
  if (taskId) {
    check('/api/tasks/run 立即运行', (await req('/api/tasks/run?id=' + taskId, { method: 'POST' })).json.ok === true);
    await sleep(700);
    const list = await req('/api/tasks');
    const t = list.json.tasks.find((x) => x.id === taskId);
    check('shell 任务输出正确（无 cmd 弹窗路径）', !!(t && t.lastRun && t.lastRun.ok && /SMOKE_SHELL_OK/.test(t.lastRun.summary)), JSON.stringify(t && t.lastRun));
    check('/api/tasks 删除任务', (await req('/api/tasks?id=' + taskId, { method: 'DELETE' })).json.ok === true);
  }

  // ---- WebSocket：PTY 终端 ----
  if (typeof WebSocket === 'undefined') skip('WebSocket 用例', '当前 Node 无内置 WebSocket');
  else {
    for (let i = 0; i < 2; i++) {
      const term = await wsSession(WS + '/ws/term?token=' + TOKEN, [
        [80, { type: 'spawn', shell: IS_WIN ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh', cols: 80, rows: 24, cwd: '' }],
        [600, { type: 'input', data: 'echo SMOKE_TERM\r' }],
        [700, { type: 'kill' }],
      ], 2500);
      const all = term.frames.map((f) => JSON.stringify(f)).join('\n');
      check('终端 spawn/kill 周期 ' + (i + 1), term.frames.some((f) => f.type === 'spawned') && /SMOKE_TERM/.test(all), all.slice(0, 200));
    }
    const chat = await wsSession(WS + '/ws/chat?token=' + TOKEN, [
      [80, { type: 'send', text: 'ping', session: 'smoke-1' }],
    ], 3000);
    const types = chat.frames.map((f) => f.type + ':' + (f.state || (f.event && f.event.type) || ''));
    check('聊天桥接跑通一轮 codex exec', types.includes('status:running') && types.some((x) => x.startsWith('codex:')) && types.includes('status:done'), types.join(','));
  }

  // ---- 静态检查：弹窗隐患 ----
  const raw = fs.readFileSync(SERVER, 'utf8');
  const code = raw.split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\s*\/\/.*$/, ''))
    .join('\n');
  check('server.js 已无 shell:true', !/shell:\s*true/.test(code));
  check('server.js 已无 cmd /c start', !/\['\/c',\s*'start'/.test(code));
  const agent = fs.readFileSync(PTY_AGENT, 'utf8');
  check('node-pty 关闭终端不再 fork 子进程', !/\.fork\(/.test(agent));
  check('console 类 spawn 均带 hidden()/windowsHide',
    code.split('\n').filter((l) => /\b(spawn|execFile)\(/.test(l) && !/explorer|osascript|zenity|xdg-open|'open'|rundll32|guiSpawn|spawn\(cmd, args/.test(l))
      .every((l) => /hidden\(|windowsHide|pty\.spawn/.test(l)));
  const log = serverLog.join('');
  check('服务日志无 DEP0190 / AttachConsole 崩溃 / 未捕获异常',
    !/DEP0190|AttachConsole failed|UNCAUGHT|UNHANDLED|Error:/.test(log), log.slice(-300));

  // ---- --stop 停止命令（隔离状态目录，不影响用户实例） ----
  try {
    const out = execFileSync(process.execPath, [SERVER, '--stop'], {
      ...HIDE, encoding: 'utf8', env: { ...process.env, BUDDY_STATE_DIR: stateDir },
    });
    check('--stop 能停止服务', /STOPPED/.test(out), out.trim());
    stoppedByCli = true;
  } catch (e) { check('--stop 能停止服务', false, e.message); }
} catch (e) {
  check('自检执行过程无异常', false, e.stack);
} finally {
  if (!stoppedByCli) {
    try { srv.kill(); } catch {}
    if (IS_WIN && srv.pid) {
      try { execFileSync('taskkill', ['/PID', String(srv.pid), '/T', '/F'], { ...HIDE, stdio: 'ignore' }); } catch {}
    }
  }
  await sleep(200);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 项通过' + (failed.length ? '，失败：' + failed.map((r) => r.name).join('、') : '，全部通过'));
  process.exit(failed.length ? 1 : 0);
}
