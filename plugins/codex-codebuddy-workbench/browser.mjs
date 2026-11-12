'use strict';
/*
 * browser.mjs — 零依赖的 Chromium CDP 驱动（Node 内置 WebSocket 直连）
 * 用途：让 AI 能自己拉起 Chromium、打开本地页面、执行 JS、按坐标/选择器点击、截图、取 HTML。
 * 前提：本机装了 Playwright 的 Chromium 内核（自动探测 ~/.../ms-playwright/chromium-*，找不到时用 BROWSER_MJS_CHROME 环境变量），且 Chrome 支持 --remote-debugging-port。
 *
 * 子命令：
 *   node browser.mjs start [--headful] [--port 0]   启动守护（默认无头），就绪后打印 READY <port>
 *   node browser.mjs open <url>                     在当前页面导航到 url（等待 load）
 *   node browser.mjs eval <js>                       执行 JS，打印返回值(JSON)
 *   node browser.mjs click <x> <y>                  按坐标点击
 *   node browser.mjs click <selector>               按 CSS 选择器点击（取元素中心）
 *   node browser.mjs screenshot [out.png]            整页截图，写入文件并打印路径
 *   node browser.mjs html [out.html]                 导出当前页 outerHTML，写入文件并打印路径
 *   node browser.mjs stop                            关闭守护
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/* 自动探测 Playwright 的 Chromium 可执行文件；找不到时回退到 BROWSER_MJS_CHROME 环境变量。 */
function resolveChrome() {
  if (process.env.BROWSER_MJS_CHROME) return process.env.BROWSER_MJS_CHROME;
  const home = os.homedir();
  const bases = [
    path.join(home, 'AppData', 'Local', 'ms-playwright'), // Windows
    path.join(home, 'Library', 'Caches', 'ms-playwright'), // macOS
    path.join(home, '.cache', 'ms-playwright'), // Linux
  ];
  const subPaths = [
    ['chrome-win64', 'chrome.exe'],
    ['chrome-win', 'chrome.exe'],
    ['chrome-linux', 'chrome'],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
  ];
  for (const base of bases) {
    let entries = [];
    try { entries = fs.readdirSync(base); } catch { continue; }
    const dirs = entries.filter((d) => /^chromium-\d/.test(d)).sort().reverse();
    const headlessDirs = entries.filter((d) => /^chromium_headless_shell-\d/.test(d)).sort().reverse();
    for (const d of [...dirs, ...headlessDirs]) {
      for (const sp of subPaths) {
        const p = path.join(base, d, ...sp);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  throw new Error(
    '未找到 Playwright 的 Chromium。请先安装：npm i -D playwright && npx playwright install chromium，' +
    '或用环境变量 BROWSER_MJS_CHROME 指向 chrome 可执行文件。'
  );
}

const STATE_DIR = path.join(os.homedir(), '.codex', 'codebuddy-workbench');
const STATE_FILE = path.join(STATE_DIR, 'browser.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function writeState(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/* ---- 通用 CDP 调用（单条命令，自动开关连接） ---- */
function cdp(wsUrl, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('cdp timeout: ' + method)); }, 20000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id === 1) {
        clearTimeout(timer);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
        try { ws.close(); } catch {}
      }
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cdp ws error: ' + method)); });
  });
}

async function createPage(browserWs) {
  const { targetId } = await cdp(browserWs, 'Target.createTarget', { url: 'about:blank' });
  return targetId;
}

/* ---- 启动守护 ---- */
function start({ headless }) {
  const userData = path.join(os.tmpdir(), 'browser-cdp-' + Date.now());
  const args = [
    headless ? '--headless=new' : '--headful',
    '--no-sandbox',
    '--disable-gpu',
    '--use-angle=swiftshader',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    '--user-data-dir=' + userData,
  ];
  if (!headless) args.push('--window-size=1280,900');

  const child = spawn(resolveChrome(), args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.unref();

  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      try { child.stderr.destroy(); } catch {}
      reject(new Error('等待 DevTools 端口超时'));
    }, 15000);
    const onData = (buf) => {
      const s = buf.toString();
      const m = /ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/([\w-]+)/.exec(s);
      if (m) {
        clearTimeout(to);
        child.stderr.removeListener('data', onData);
        try { child.stderr.destroy(); } catch {}
        resolve({ port: +m[1], browserWs: `ws://127.0.0.1:${m[1]}/devtools/browser/${m[2]}` });
      }
    };
    child.stderr.on('data', onData);
    child.on('exit', (c) => { clearTimeout(to); reject(new Error('Chromium 异常退出, code=' + c)); });
  }).then(async ({ port, browserWs }) => {
    const targetId = await createPage(browserWs);
    const state = {
      pid: child.pid, port, browserWs, targetId,
      headless, startedAt: new Date().toISOString(),
    };
    writeState(state);
    return state;
  });
}

function stop() {
  const st = readState();
  if (!st || !pidAlive(st.pid)) { fs.rmSync(STATE_FILE, { force: true }); return 'NOT_RUNNING'; }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(st.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(-st.pid, 'SIGKILL'); } catch { try { process.kill(st.pid, 'SIGKILL'); } catch {} }
  }
  fs.rmSync(STATE_FILE, { force: true });
  return 'STOPPED pid=' + st.pid;
}

/* 每次命令重新 attach 一个会话（CDP 会话跟连接绑定，独立进程必须重建） */
function withSession(browserWs, targetId, work) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(browserWs);
    let sessionId = null;
    let idc = 1;
    let attachId = 0;
    const pending = new Map();
    const send = (method, params) => new Promise((res, rej) => {
      const id = ++idc;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const finish = (val) => { try { ws.close(); } catch {} resolve(val); };
    const fail = (e) => { try { ws.close(); } catch {} reject(e); };
    ws.addEventListener('open', () => {
      attachId = ++idc;
      ws.send(JSON.stringify({ id: attachId, method: 'Target.attachToTarget', params: { targetId, flatten: true } }));
    });
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id === attachId) {
        if (m.error) return fail(new Error(m.error.message));
        sessionId = m.result.sessionId;
        Promise.resolve(work(send)).then(finish).catch(fail);
        return;
      }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
      }
    });
    ws.addEventListener('error', () => fail(new Error('cdp ws error')));
    setTimeout(() => fail(new Error('withSession timeout')), 20000);
  });
}

async function navigateWait(st, url) {
  return withSession(st.browserWs, st.targetId, async (send) => {
    await send('Page.enable');
    await send('Page.navigate', { url });
    for (let i = 0; i < 40; i++) {
      const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (r && r.result && r.result.value === 'complete') return 'OPENED ' + url;
      await new Promise((s) => setTimeout(s, 200));
    }
    return 'OPENED(timeout) ' + url;
  });
}

function rectForSelector(st, sel) {
  return withSession(st.browserWs, st.targetId, (send) =>
    send('Runtime.evaluate', {
      expression: `(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;var r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};})()`,
      returnByValue: true,
    }).then((r) => r.result && r.result.value)
  );
}

async function doClick(st, a, b) {
  let x, y;
  if (b === undefined && /^-?\d+(\.\d+)?$/.test(a)) {
    throw new Error('坐标点击需要两个数字: click <x> <y>');
  }
  if (b !== undefined) {
    x = parseFloat(a); y = parseFloat(b);
  } else {
    const rect = await rectForSelector(st, a);
    if (!rect) throw new Error('找不到选择器: ' + a);
    x = rect.x; y = rect.y;
  }
  await withSession(st.browserWs, st.targetId, async (send) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  });
  return { x, y };
}

function requireState() {
  const st = readState();
  if (!st || !pidAlive(st.pid)) throw new Error('浏览器未运行，请先执行: node browser.mjs start');
  return st;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  const flags = rest.filter((x) => x.startsWith('--'));
  const args = rest.filter((x) => !x.startsWith('--'));

  if (cmd === 'start') {
    const headless = !flags.includes('--headful');
    const st = await start({ headless });
    console.log(`READY http://127.0.0.1:${st.port}/  headless=${st.headless}`);
    return;
  }
  if (cmd === 'stop') { console.log(stop()); return; }

  if (cmd === 'open') {
    const st = requireState();
    const url = args[0];
    if (!url) throw new Error('用法: open <url>');
    console.log(await navigateWait(st, url));
    return;
  }
  if (cmd === 'eval') {
    const st = requireState();
    const js = args.join(' ');
    if (!js) throw new Error('用法: eval <js>');
    const r = await withSession(st.browserWs, st.targetId, (send) =>
      send('Runtime.evaluate', { expression: js, returnByValue: true }));
    console.log(JSON.stringify(r.result ? r.result.value : r, null, 2));
    return;
  }
  if (cmd === 'click') {
    const st = requireState();
    const res = await doClick(st, args[0], args[1]);
    console.log('CLICKED', JSON.stringify(res));
    return;
  }
  if (cmd === 'screenshot') {
    const st = requireState();
    const out = path.resolve(args[0] || 'browser-shot.png');
    const r = await withSession(st.browserWs, st.targetId, (send) =>
      send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }));
    fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
    console.log('SAVED ' + out + ' (' + (r.data.length * 3 / 4 / 1024).toFixed(0) + ' KB)');
    return;
  }
  if (cmd === 'html') {
    const st = requireState();
    const out = path.resolve(args[0] || 'browser-page.html');
    const r = await withSession(st.browserWs, st.targetId, (send) =>
      send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true }));
    const html = (r.result && r.result.value) || '';
    fs.writeFileSync(out, html);
    console.log('SAVED ' + out + ' (' + (html.length / 1024).toFixed(0) + ' KB)');
    return;
  }

  console.log(`browser.mjs — 零依赖 Chromium CDP 驱动
用法:
  node browser.mjs start [--headful]     启动守护(默认无头)
  node browser.mjs open <url>            打开/导航到页面
  node browser.mjs eval <js>             执行 JS
  node browser.mjs click <x> <y>         坐标点击
  node browser.mjs click <selector>      选择器点击
  node browser.mjs screenshot [out.png]  截图
  node browser.mjs html [out.html]       导出 HTML
  node browser.mjs stop                  关闭守护`);
}

main().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
