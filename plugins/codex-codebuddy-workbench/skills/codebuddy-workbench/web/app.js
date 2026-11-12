'use strict';
/* CodeBuddy Workbench 前端 */
(() => {
const $ = (s) => document.querySelector(s);
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const api = async (p, params) => {
  const u = new URL(p, location.origin);
  u.searchParams.set('token', TOKEN);
  if (params) for (const k in params) u.searchParams.set(k, params[k]);
  const r = await fetch(u);
  if (!r.ok) throw new Error(p + ' -> ' + r.status);
  return r.json();
};
const apiPost = async (p, body) => {
  const u = new URL(p, location.origin); u.searchParams.set('token', TOKEN);
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(p + ' -> ' + r.status);
  return r.json();
};
const rawURL = (p) => location.origin + '/api/raw?token=' + TOKEN + '&path=' + encodeURIComponent(p);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toast = ((el) => { let t; return (m) => { el.textContent = m; el.classList.add('show'); clearTimeout(t); t = setTimeout(() => el.classList.remove('show'), 2600); }; })($('#toast'));
const log = (s) => { $('#output').textContent += s + '\n'; $('#output').scrollTop = 1e9; };
// 应用内弹窗，替代原生 confirm/prompt
function openDialog(opts) {
  const mask = $('#dlg-mask'), title = $('#dlg-title'), msg = $('#dlg-msg'), inp = $('#dlg-input'), ok = $('#dlg-ok'), cancel = $('#dlg-cancel');
  const isPrompt = opts.mode === 'prompt';
  title.textContent = opts.title || '确认';
  msg.textContent = opts.message || '';
  msg.style.whiteSpace = 'pre-line';
  msg.style.display = opts.message ? 'block' : 'none';
  inp.style.display = isPrompt ? 'block' : 'none';
  if (isPrompt) inp.value = opts.value != null ? opts.value : '';
  ok.className = 'dlg-btn primary' + (opts.danger ? ' danger' : '');
  mask.style.display = 'flex';
  return new Promise((resolve) => {
    const okVal = () => (isPrompt ? (inp.value.trim() || null) : true);
    const cancelVal = () => (isPrompt ? null : false);
    const done = (val) => { mask.style.display = 'none'; document.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); done(okVal()); } else if (e.key === 'Escape') { e.preventDefault(); done(cancelVal()); } };
    ok.onclick = () => done(okVal());
    cancel.onclick = () => done(cancelVal());
    mask.onclick = (e) => { if (e.target === mask) done(cancelVal()); };
    document.addEventListener('keydown', onKey);
    if (isPrompt) setTimeout(() => { inp.focus(); inp.select(); }, 30); else ok.focus();
  });
}
const dlgConfirm = (message, opts) => openDialog({ mode: 'confirm', title: (opts && opts.title) || '确认', message, danger: !!(opts && opts.danger) });
const dlgPrompt = (title, value, message) => openDialog({ mode: 'prompt', title, message: message || '', value });

let ROOT = '', INFO = null, GIT = { repo: null, files: {} };
const LS = {
  get(k, d) { try { const v = localStorage.getItem('buddy.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('buddy.' + k, JSON.stringify(v)); } catch {} },
};

/* ================= 布局尺寸 / 显隐 ================= */
function applyLayout() {
  document.documentElement.style.setProperty('--tree-w', LS.get('treeW', 270) + 'px');
  document.documentElement.style.setProperty('--chat-w', LS.get('chatW', 480) + 'px');
  document.documentElement.style.setProperty('--term-h', LS.get('termH', 38) + '%');
  for (const k of ['tree', 'term', 'chat']) {
    const on = LS.get('show-' + k, k === 'term' ? false : true);
    document.body.classList.toggle('hide-' + k, !on);
    $('#tg-' + k).classList.toggle('on', on);
  }
  if (term.fit) term.fit.fit();
}
function setupResizer(el, onDrag) {
  el.addEventListener('mousedown', (e) => {
    e.preventDefault(); el.classList.add('act');
    const mv = (ev) => onDrag(ev);
    const up = () => { el.classList.remove('act'); document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); if (term.fit) term.fit.fit(); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });
}
setupResizer($('#rz-tree'), (e) => { const w = Math.min(560, Math.max(160, e.clientX)); document.documentElement.style.setProperty('--tree-w', w + 'px'); LS.set('treeW', w); });
setupResizer($('#rz-chat'), (e) => { const w = Math.min(720, Math.max(280, innerWidth - e.clientX)); document.documentElement.style.setProperty('--chat-w', w + 'px'); LS.set('chatW', w); });
setupResizer($('#rz-term'), (e) => {
  const c = $('#center').getBoundingClientRect();
  const h = Math.min(85, Math.max(10, ((c.bottom - e.clientY) / c.height) * 100));
  document.documentElement.style.setProperty('--term-h', h + '%'); LS.set('termH', h);
});
for (const k of ['tree', 'term', 'chat']) $('#tg-' + k).addEventListener('click', () => {
  const on = !document.body.classList.contains('hide-' + k);
  LS.set('show-' + k, !on); applyLayout();
  if (k === 'term' && !document.body.classList.contains('hide-term')) ensureTermSpawned();
});
$('#btn-reload').addEventListener('click', () => { refreshGit(); refreshOpenDirs(); });
$('#btn-open-dir').addEventListener('click', () => {
  $('#root-err').textContent = '';
  $('#root-input').value = ROOT || '';
  $('#modal-root').style.display = 'flex';
  setTimeout(() => $('#root-input').focus(), 30);
});
$('#root-cancel').addEventListener('click', () => { $('#modal-root').style.display = 'none'; });
$('#modal-root').addEventListener('click', (e) => { if (e.target.id === 'modal-root') $('#modal-root').style.display = 'none'; });
$('#root-ok').addEventListener('click', submitDir);
$('#root-browse').addEventListener('click', async () => {
  $('#root-err').textContent = '请在弹出的系统对话框中选择目录…';
  try {
    const u = new URL('/api/pickdir', location.origin); u.searchParams.set('token', TOKEN);
    const r = await fetch(u); const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.path) { $('#root-err').textContent = j.error || '已取消'; return; }
    $('#root-input').value = j.path; $('#root-err').textContent = '';
    submitDir(); // 选完直接切换
  } catch (e) { $('#root-err').textContent = '选择失败：' + e.message; }
});
$('#root-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitDir(); });
async function submitDir() {
  const v = ($('#root-input').value || '').trim();
  if (!v) return;
  $('#root-err').textContent = '正在切换…';
  try {
    const u = new URL('/api/setroot', location.origin);
    u.searchParams.set('token', TOKEN);
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: v }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $('#root-err').textContent = j.error || ('失败：' + r.status); return; }
    $('#modal-root').style.display = 'none';
    location.reload();
  } catch (e) { $('#root-err').textContent = '请求失败：' + e.message; }
}
$('#btn-collapse').addEventListener('click', () => { for (const d of Object.keys(expanded)) if (d !== '') delete expanded[d]; renderTree(); });
$('#btn-refresh-tree').addEventListener('click', () => refreshOpenDirs());

/* ================= 文件树 ================= */
const expanded = LS.get('expanded', { '': true });
const children = {}; // dir -> items[]
let selectedPath = null;

function iconFor(name, isDir) {
  if (isDir) return '';
  const ext = name.split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext)) return '🖼';
  if (ext === 'md' || ext === 'txt') return '📝';
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx'].includes(ext)) return '𝒥';
  if (['json', 'jsonl'].includes(ext)) return '{}';
  if (['html', 'htm', 'css'].includes(ext)) return '🌐';
  if (['py'].includes(ext)) return '🐍';
  if (['java', 'kt', 'gradle'].includes(ext)) return '☕';
  if (['pdf'].includes(ext)) return '📕';
  if (['sh', 'ps1', 'bat', 'cmd'].includes(ext)) return '＞_';
  return '📄';
}
function gitStatusFor(rel) {
  const f = GIT.files;
  if (f[rel]) return f[rel].trim()[0] || '?';
  // 目录：聚合子状态
  let ch = null;
  for (const k in f) if (k.startsWith(rel + '/')) { ch = f[k].trim()[0] || '?'; if (ch !== 'M') break; }
  return ch;
}
async function loadDir(dir) {
  const r = await api('/api/ls', { dir });
  if (r.error) { toast('读取失败: ' + r.error); return []; }
  r.items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'en', { numeric: true }));
  children[dir] = r.items;
  return r.items;
}
function rowEl(item, dir) {
  const rel = dir ? dir + '/' + item.name : item.name;
  const d = document.createElement('div');
  d.className = 'row' + (item.dir ? ' dir' : '') + (rel === selectedPath ? ' sel' : '') + (item.dir && expanded[rel] ? ' open' : '');
  const st = gitStatusFor(rel);
  const twHtml = item.dir
    ? '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M4 2.5 L8 6 L4 9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '';
  d.innerHTML =
    '<span class="tw">' + twHtml + '</span>' +
    '<span class="ic">' + (item.dir ? '' : iconFor(item.name, false)) + '</span>' +
    '<span class="nm">' + esc(item.name) + '</span>' +
    (st ? '<span class="st st-' + esc(st) + '">' + esc(st) + '</span>' : '');
  d.dataset.rel = rel; d.dataset.dir = String(item.dir);
  d.addEventListener('click', async (e) => {
    e.stopPropagation();
    selectedPath = rel;
    if (item.dir) {
      if (expanded[rel]) delete expanded[rel];
      else { expanded[rel] = true; if (!children[rel]) { try { await loadDir(rel); } catch {} } }
      LS.set('expanded', expanded); renderTree();
    } else {
      renderTree(); openTab(rel);
    }
  });
  d.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    selectedPath = rel; renderTree();
    treeCtxMenu(rel, item.dir, e.clientX, e.clientY, false);
  });
  return d;
}
function renderTree() {
  const body = $('#tree-body');
  body.innerHTML = '';
  const walk = (dir, depth) => {
    for (const it of children[dir] || []) {
      const row = rowEl(it, dir);
      row.style.paddingLeft = (6 + depth * 13) + 'px';
      body.appendChild(row);
      const rel = dir ? dir + '/' + it.name : it.name;
      if (it.dir && expanded[rel]) walk(rel, depth + 1);
    }
  };
  walk('', 0);
}
async function refreshOpenDirs() {
  const dirs = new Set(['']);
  for (const d of Object.keys(expanded)) {
    const parts = d.split('/'); dirs.add('');
    let acc = '';
    for (const p of parts) { acc = acc ? acc + '/' + p : p; dirs.add(acc); }
  }
  await Promise.all([...dirs].map(async (d) => { try { await loadDir(d); } catch {} }));
  renderTree();
}

/* ================= 文件树右键菜单 ================= */
const ctxEl = $('#ctx');
function absPath(rel) { return rel ? (ROOT.replace(/[\\/]$/, '') + '\\' + rel.replace(/\//g, '\\')) : ROOT; }
function copyText(t) { if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast('已复制路径'), () => toast('复制失败')); else toast('当前环境不支持剪贴板'); }
function refToChat(rel) { const i = $('#inp'); i.value = (i.value ? i.value + ' ' : '') + '`' + rel + '`'; i.focus(); i.dispatchEvent(new Event('input', { bubbles: true })); toast('已引用到对话'); }
function hideCtx() { ctxEl.style.display = 'none'; }
function showCtx(items, x, y) {
  ctxEl.innerHTML = '';
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'sep'; ctxEl.appendChild(s); continue; }
    const el = document.createElement('div');
    el.className = 'ci' + (it.danger ? ' danger' : '');
    el.innerHTML = '<span>' + esc(it.label) + '</span>' + (it.key ? '<span class="k">' + esc(it.key) + '</span>' : '');
    el.addEventListener('click', () => { hideCtx(); it.fn(); });
    ctxEl.appendChild(el);
  }
  ctxEl.style.display = 'block';
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  ctxEl.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
document.addEventListener('click', hideCtx);
window.addEventListener('scroll', hideCtx, true);
document.addEventListener('contextmenu', (e) => { if (!ctxEl.contains(e.target)) hideCtx(); });
async function fsAction(action, rel, name) {
  const u = new URL('/api/fs-action', location.origin); u.searchParams.set('token', TOKEN);
  const res = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, path: rel || '', name: name || '' }) });
  const j = await res.json().catch(() => ({}));
  if (j.error) toast('⚠ ' + j.error);
  await refreshOpenDirs(); refreshGit();
  return j;
}
function treeCtxMenu(rel, isDir, x, y, isRoot) {
  const dirOf = isDir ? rel : rel.split('/').slice(0, -1).join('/');
  const items = [];
  if (!isDir && !isRoot) items.push({ label: '打开预览', fn: () => openTab(rel) });
  items.push({ label: '在文件资源管理器中显示', fn: () => fsAction('reveal', rel || '') });
  if (!isRoot) {
    items.push({ label: '复制路径', fn: () => copyText(absPath(rel)) });
    items.push({ label: '复制相对路径', fn: () => copyText(rel) });
    items.push({ label: '引用到对话', fn: () => refToChat(rel) });
    if (!isDir) items.push({ label: '附到对话', fn: () => addTreeAttachment(rel) });
  }
  items.push({ sep: true });
  items.push({ label: '新建文件', fn: () => promptNew('newfile', dirOf) });
  items.push({ label: '新建文件夹', fn: () => promptNew('mkdir', dirOf) });
  items.push({ sep: true });
  items.push({ label: '在终端中打开', fn: () => openInTerm(isRoot ? '' : dirOf) });
  if (!isRoot) {
    items.push({ sep: true });
    items.push({ label: '重命名', key: 'F2', fn: () => renameItem(rel) });
    items.push({ label: '删除', key: 'Delete', danger: true, fn: () => deleteItem(rel) });
  }
  showCtx(items, x, y);
}
async function promptNew(action, dirOf) {
  const name = await dlgPrompt(action === 'mkdir' ? '新建文件夹' : '新建文件', '', '输入名称：');
  if (!name) return;
  fsAction(action, dirOf, name).then((j) => {
    if (j.error) return;
    if (dirOf && !expanded[dirOf]) { expanded[dirOf] = true; LS.set('expanded', expanded); }
    refreshOpenDirs();
    if (action === 'newfile') openTab(dirOf ? dirOf + '/' + name : name);
  });
}
async function renameItem(rel) {
  const old = rel.split('/').pop();
  const name = await dlgPrompt('重命名', old, '输入新的名称：');
  if (!name || name === old) return;
  fsAction('rename', rel, name).then((j) => {
    if (j.error) return;
    const np = rel.split('/').slice(0, -1).concat(name).join('/');
    if (selectedPath === rel) selectedPath = np;
    refreshOpenDirs();
  });
}
async function deleteItem(rel) {
  if (!(await dlgConfirm('确定删除 ' + rel + ' ？此操作不可撤销。', { title: '删除确认', danger: true }))) return;
  fsAction('delete', rel).then((j) => { if (!j.error && selectedPath === rel) selectedPath = null; });
}
function openInTerm(dirOf) {
  termPane('term'); ensureTermSpawned();
  setTimeout(() => { if (term.ws && term.ws.readyState === 1) term.ws.send(JSON.stringify({ type: 'input', data: 'cd "' + absPath(dirOf).replace(/\\/g, '/') + '"\r' })); }, 500);
}

/* ================= Git ================= */
async function refreshGit() {
  try {
    const r = await api('/api/git', { path: '' });
    GIT = r.repo ? r : { repo: null, files: {} };
  } catch { GIT = { repo: null, files: {} }; }
  const bar = $('#gitbar'), st = $('#st-git'), chg = $('#st-changes');
  if (!GIT.repo) {
    if (bar) bar.innerHTML = '<span style="color:var(--fg3)">非 Git 仓库</span>';
    if (st) st.textContent = '⊘ git';
    if (chg) chg.textContent = '';
  } else {
    const n = Object.keys(GIT.files).length;
    const rel = GIT.repoRel && GIT.repoRel !== '.' ? ' · ' + esc(GIT.repoRel) : '';
    if (bar) bar.innerHTML = '<span>⑂</span><b>' + esc(GIT.branch || '?') + '</b>' +
      (GIT.ahead || GIT.behind ? '<span class="ab">↑' + GIT.ahead + ' ↓' + GIT.behind + '</span>' : '') +
      (n ? '<span class="ab">' + n + ' 处更改</span>' : '') + rel;
    if (st) st.innerHTML = '<span>⑂</span> <b>' + esc(GIT.branch || '?') + '</b>' + (GIT.ahead ? ' ↑' + GIT.ahead : '') + (GIT.behind ? ' ↓' + GIT.behind : '');
    if (chg) chg.innerHTML = n ? '<span class="g">' + n + ' ▲</span>' : '';
    // 问题面板
    const pl = $('#problems');
    pl.innerHTML = n ? Object.entries(GIT.files).map(([f, xy]) =>
      '<div class="tool" style="cursor:pointer" data-open="' + esc(f) + '"><span class="dot" style="background:' +
      ({ A: 'var(--green)', D: 'var(--red)', U: 'var(--green)', R: 'var(--purple)', C: 'var(--purple)' }[(xy || '').trim()[0]] || 'var(--yellow)') +
      '"></span><span class="t">' + esc((xy || '').trim()) + '  ' + esc(f) + '</span></div>').join('')
      : '<div style="color:var(--fg3);font-size:12px">工作区干净（无未提交更改）</div>';
    pl.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => { openTab(el.dataset.open); jumpToInTree(el.dataset.open); }));
  }
  updateGitBadge(GIT.repo ? Object.keys(GIT.files).length : 0);
  if (GIT.repo) api('/api/git-branches').then(fillBranchSel).catch(() => {});
  renderTree();
  if (term.pane === 'gitws') refreshGitWS();
}
// 暂存区标签上的红色角标：有未提交更改时显示数量
function updateGitBadge(n) {
  const b = $('#gw-badge'); if (!b) return;
  if (n > 0) { b.textContent = n > 99 ? '99+' : String(n); b.style.display = 'inline-block'; }
  else b.style.display = 'none';
}

/* ===== Git 工作区面板（暂存 / 提交） ===== */
async function refreshGitWS() {
  const el = $('#gitws'); if (!el || el.classList.contains('term-hidden')) return;
  const r = await api('/api/git', { path: '' }).catch(() => null);
  if (!r || !r.repo) {
    $('#gw-body').innerHTML = '<div class="gw-empty">非 Git 仓库</div>';
    const s0 = $('#gw-branch-sel'); if (s0) s0.innerHTML = '<option value="">—</option>';
    $('#gw-ab').textContent = '';
    return;
  }
  $('#gw-ab').textContent = (r.ahead || r.behind) ? ('↑' + r.ahead + ' ↓' + r.behind) : '';
  api('/api/git-branches').then(fillBranchSel).catch(() => {});
  const { staged, unstaged, untracked, conflicts } = parseGit(r.files || {});
  fillGWList('#gw-staged', '#gw-staged-n', '#gw-staged-wrap', staged, 'staged');
  fillGWList('#gw-unstaged', '#gw-unstaged-n', '#gw-unstaged-wrap', unstaged, 'unstaged');
  fillGWList('#gw-untracked', '#gw-untracked-n', '#gw-untracked-wrap', untracked, 'untracked');
  fillGWList('#gw-conflicts', '#gw-conflicts-n', '#gw-conflicts-wrap', conflicts, 'conflict');
  const total = staged.length + unstaged.length + untracked.length + conflicts.length;
  $('#gw-empty').style.display = total ? 'none' : 'block';
}
function parseGit(files) {
  const staged = [], unstaged = [], untracked = [], conflicts = [];
  for (const [f, xy] of Object.entries(files)) {
    const X = xy[0], Y = xy[1];
    if (X === '?' && Y === '?') { untracked.push({ path: f, xy }); continue; }
    if (X === 'U' || Y === 'U' || xy === 'DD' || xy === 'AA' || xy === 'AU' || xy === 'UA') { conflicts.push({ path: f, xy }); continue; }
    if (X !== ' ' && X !== '?') staged.push({ path: f, xy });
    if (Y !== ' ' && Y !== '?') unstaged.push({ path: f, xy });
  }
  return { staged, unstaged, untracked, conflicts };
}
function gwStatusLabel(xy) {
  if (xy === '??') return '新';
  const map = { M: '改', A: '增', D: '删', R: '名', C: '拷', U: '冲突', ' ': '' };
  const a = map[xy[0]] || xy[0], b = map[xy[1]] || xy[1];
  const s = (a || '') + (b && b !== a ? (a ? ' ' : '') + b : '');
  return s || '改';
}
function fillGWList(listSel, nSel, wrapSel, items, kind) {
  const list = $(listSel), n = $(nSel), wrap = $(wrapSel);
  list.innerHTML = '';
  n.textContent = items.length;
  wrap.style.display = items.length ? '' : 'none';
  for (const it of items) {
    const row = document.createElement('div'); row.className = 'gw-row';
    row.innerHTML = '<span class="gw-ico">' + esc(iconFor(it.path, false)) + '</span><span class="gw-badge">' + esc(gwStatusLabel(it.xy)) + '</span><span class="gw-name" title="' + esc(it.path) + '">' + esc(it.path) + '</span>';
    const deleted = (it.xy || '').trim().startsWith('D');
    if (deleted) {
      row.title = '文件已删除，无法查看';
    } else {
      row.classList.add('gw-open');
      row.title = '点击查看内容：' + it.path;
      row.addEventListener('click', (e) => { if (e.target.closest('.gw-acts')) return; openDiffTab(it.path); selectedPath = it.path; renderTree(); });
    }
    const acts = document.createElement('span'); acts.className = 'gw-acts';
    const mk = (label, fn) => { const b = document.createElement('button'); b.className = 'gw-b'; b.textContent = label; b.addEventListener('click', fn); acts.appendChild(b); };
    if (kind === 'staged') { mk('取消暂存', () => gitAction('unstage', it.path)); mk('查看', () => openTab(it.path)); }
    else if (kind === 'unstaged') { mk('暂存', () => gitAction('stage', it.path)); mk('放弃', async () => { if (await dlgConfirm('放弃更改：' + it.path + '？', { title: '放弃更改', danger: true })) gitAction('discard', it.path); }); }
    else if (kind === 'untracked') { mk('暂存', () => gitAction('stage', it.path)); mk('删除', async () => { if (await dlgConfirm('删除文件：' + it.path + '？', { title: '删除文件', danger: true })) gitAction('delete', it.path); }); }
    else if (kind === 'conflict') { mk('暂存', () => gitAction('stage', it.path)); }
    row.appendChild(acts);
    list.appendChild(row);
  }
}
function zhGitErr(msg) {
  const m = String(msg || '');
  if (/no changes added to commit/i.test(m) || /nothing to commit/i.test(m)) return '没有已暂存的更改：请先「暂存」文件，或使用「暂存并提交」';
  if (/Please tell me who you are|unable to auto-detect email|user\.email/i.test(m)) return '未配置 Git 用户信息，请先设置 user.name / user.email';
  if (/not a git repository/i.test(m)) return '当前目录不是 Git 仓库';
  if (/did not match any file/i.test(m)) return '要操作的文件不存在（可能已被删除）';
  return m;
}
async function gitAction(action, p, message, all) {
  const u = new URL('/api/git-action', location.origin); u.searchParams.set('token', TOKEN);
  const res = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, path: p || '', message: message || '', all: !!all }) });
  const j = await res.json().catch(() => ({}));
  if (j.error) { toast('⚠ ' + zhGitErr(j.error)); refreshGitWS(); refreshGit(); return j; }
  refreshGitWS(); refreshGit();
  reloadTabsForBranch();   // 操作后刷新已打开的 diff/文件标签，避免显示旧内容
  return j;
}

function jumpToInTree(rel) {
  const parts = rel.split('/'); let acc = '';
  const chain = parts.slice(0, -1).map((p) => { acc = acc ? acc + '/' + p : p; return acc; });
  let i = 0;
  const step = async () => {
    if (i >= chain.length) { renderTree(); const el = $('#tree-body').querySelector('[data-rel="' + CSS.escape(rel) + '"]'); if (el) el.scrollIntoView({ block: 'center' }); return; }
    const d = chain[i++];
    if (!expanded[d]) { expanded[d] = true; if (!children[d]) { try { await loadDir(d); } catch {} } LS.set('expanded', expanded); }
    step();
  };
  step();
}

/* ================= 预览标签页 ================= */
let tabs = [], activeTab = null;
const isMd = (p) => /\.(md|markdown)$/i.test(p);
const isImg = (p) => /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(p);
const isPdf = (p) => /\.pdf$/i.test(p);

function renderTabs() {
  const el = $('#tabs');
  el.innerHTML = '';
  for (const t of tabs) {
    const d = document.createElement('div');
    d.className = 'tab' + (t.path === activeTab ? ' act' : '');
    d.innerHTML = '<span class="ic" style="font-size:11px">' + iconFor(t.name, false) + '</span><span class="p">' + esc(t.name) + '</span>' + (t.dirty ? '<span class="dirty">●</span>' : '') + '<span class="x">×</span>';
    d.title = t.path;
    d.addEventListener('click', (e) => { if (e.target.classList.contains('x')) closeTab(t.path); else setActive(t.path); });
    el.appendChild(d);
  }
}
async function closeTab(p) {
  const ct = tabs.find((x) => x.path === p);
  if (ct && ct.dirty && !(await dlgConfirm('「' + ct.name + '」有未保存的修改，仍要关闭吗？', { title: '未保存的修改' }))) return;
  tabs = tabs.filter((t) => t.path !== p);
  if (activeTab === p) { activeTab = tabs.length ? tabs[tabs.length - 1].path : null; }
  renderTabs(); showActive();
}
function setActive(p) { activeTab = p; renderTabs(); showActive(); }
function loadTabData(t) {
  if (!t || t.loaded || t.loading || isImg(t.path) || isPdf(t.path)) return;
  t.loading = true;
  api('/api/file', { path: t.path }).then((r) => {
    t.data = r; t.loaded = true; t.loading = false;
    if (!r.binary) t.text = r.text || '';
    t.dirty = false;
    if (t.path === activeTab) showActive();
  }, (e) => { t.loading = false; toast('打开失败: ' + e.message); });
}
async function openTab(p) {
  let t = tabs.find((x) => x.path === p);
  if (!t) { t = { path: p, name: p.split('/').pop() }; tabs.push(t); }
  setActive(p);
  loadTabData(t);
}
function renderDiff(text) {
  const lines = String(text || '').split('\n');
  let html = '<div class="diff">';
  for (const ln of lines) {
    let cls = '';
    if (ln.startsWith('+++') || ln.startsWith('---')) cls = 'dh';
    else if (ln.startsWith('@@')) cls = 'dhun';
    else if (ln.startsWith('+')) cls = 'dadd';
    else if (ln.startsWith('-')) cls = 'ddel';
    else if (/^(diff |index |new file|deleted file|similarity|rename )/.test(ln)) cls = 'dh';
    html += '<div class="dl ' + cls + '">' + (ln === '' ? '&nbsp;' : esc(ln)) + '</div>';
  }
  html += '</div>';
  return html;
}
function openDiffTab(rel, hash) {
  const p = hash ? ('diff:' + hash.slice(0, 12) + ':' + rel) : ('diff:' + rel);
  let t = tabs.find((x) => x.path === p);
  if (t) { activeTab = p; renderTabs(); showActive(); return; }
  const suffix = hash ? ' · ' + hash.slice(0, 7) : ' · diff';
  t = { path: p, rel, hash: hash || '', name: rel.split('/').pop() + suffix, kind: 'diff', loaded: false, loading: true, mode: 'view', dirty: false, diffText: '' };
  tabs.push(t); activeTab = p; renderTabs(); showActive();
  const params = { path: rel }; if (hash) params.hash = hash;
  api('/api/git-diff', params).then((r) => {
    t.diffText = r.diff || ''; t.loaded = true; t.loading = false;
    if (activeTab === p) showActive();
  }, (e) => { t.loaded = true; t.loading = false; t.diffText = '(获取 diff 失败: ' + e.message + ')'; if (activeTab === p) showActive(); });
}
function showActive() {
  const md = $('#md'), code = $('#code'), imgv = $('#imgv'), pdfv = $('#pdfv'), empty = $('#pv-empty');
  const ce = $('#codeedit'), bar = $('#pv-bar'), toggle = $('#pv-toggle'), saveBtn = $('#pv-save'), dirtyEl = $('#pv-dirty');
  const bv = $('#browser-view');
  if (activeTab === '__browser__') {
    md.style.display = code.style.display = imgv.style.display = 'none';
    ce.style.display = 'none'; bar.style.display = 'none';
    pdfv.style.display = 'none'; pdfv.src = '';
    empty.style.display = 'none';
    if (bv) bv.style.display = 'flex';
    $('#st-file').textContent = '浏览器';
    return;
  }
  if (bv) bv.style.display = 'none';
  md.style.display = code.style.display = imgv.style.display = 'none';
  ce.style.display = 'none';
  bar.style.display = 'none';
  pdfv.style.display = 'none'; pdfv.src = '';
  empty.style.display = 'none';
  const t = tabs.find((x) => x.path === activeTab);
  $('#st-file').textContent = t ? (t.kind === 'diff' ? t.rel + (t.hash ? ' @ ' + t.hash.slice(0, 7) : '') + '（diff）' : t.path) : '';
  if (!t) { empty.style.display = 'flex'; return; }
  if (isImg(t.path)) { $('#imgtag').src = rawURL(t.path); imgv.style.display = 'block'; return; }
  if (isPdf(t.path)) { pdfv.src = rawURL(t.path); pdfv.style.display = 'block'; return; }
  if (t.kind === 'diff') {
    if (!t.loaded) { md.style.display = 'block'; md.innerHTML = '<blockquote>加载 diff…</blockquote>'; return; }
    code.style.display = 'block';
    code.innerHTML = t.diffText ? renderDiff(t.diffText) : '<div class="diff"><div class="dl dh">(无更改)</div></div>';
    return;
  }
  if (!t.loaded) {
    md.style.display = 'block';
    md.innerHTML = t.loading ? '<blockquote>加载中…</blockquote>' : '';
    loadTabData(t);
    return;
  }
  const d = t.data || {};
  if (d.binary) { md.style.display = 'block'; md.innerHTML = '<blockquote>二进制文件（' + (d.size / 1024).toFixed(1) + ' KB），无法预览文本。</blockquote>'; return; }
  const text = t.text != null ? t.text : (d.text || '');
  const editable = !d.truncated;
  if (editable) {
    bar.style.display = 'flex';
    dirtyEl.textContent = t.dirty ? '● 未保存' : '';
    toggle.textContent = t.mode === 'edit' ? '完成' : '编辑';
    saveBtn.style.display = (t.mode === 'edit' || t.dirty) ? 'inline-block' : 'none';
  }
  if (t.mode === 'edit' && editable) {
    ce.style.display = 'block';
    if (ce.value !== text) ce.value = text;
    return;
  }
  if (isMd(t.path)) {
    md.style.display = 'block';
    let html = marked.parse(text, { async: false });
    md.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
    md.querySelectorAll('a[href]').forEach((a) => {
      const h = a.getAttribute('href');
      if (h && !/^https?:|^#|^data:/.test(h)) {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          let rel = h.split('#')[0];
          const base = t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/') + 1) : '';
          let np = (base + rel).replace(/\\/g, '/');
          // 处理 ../
          const segs = []; for (const s of np.split('/')) { if (s === '..') segs.pop(); else if (s !== '.' && s !== '') segs.push(s); }
          openTab(segs.join('/'));
        });
      }
    });
  } else {
    code.style.display = 'block';
    const lines = text.split('\n');
    let html = '<table><tr><td class="ln">';
    html += lines.map((_, i) => i + 1).join('<br>');
    html += '</td><td class="src">' + esc(lines.join('\n')) + (d.truncated ? '\n… (已截断)' : '') + '</td></tr></table>';
    code.innerHTML = html;
  }
}
// 编辑态：输入即标记未保存；Ctrl+S 保存
$('#codeedit').addEventListener('input', () => {
  const t = tabs.find((x) => x.path === activeTab); if (!t) return;
  t.text = $('#codeedit').value;
  if (!t.dirty) { t.dirty = true; renderTabs(); }
  const de = $('#pv-dirty'); if (de) de.textContent = '● 未保存';
  const sb = $('#pv-save'); if (sb) sb.style.display = 'inline-block';
});
$('#pv-toggle').addEventListener('click', () => {
  const t = tabs.find((x) => x.path === activeTab); if (!t) return;
  t.mode = t.mode === 'edit' ? 'view' : 'edit';
  showActive();
});
$('#pv-save').addEventListener('click', () => saveActiveTab());
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveActiveTab(); }
});
async function saveActiveTab() {
  const t = tabs.find((x) => x.path === activeTab);
  if (!t || !t.loaded || t.kind === 'diff' || isImg(t.path) || isPdf(t.path)) return;
  if (t.data && (t.data.binary || t.data.truncated)) return;
  const text = t.text != null ? t.text : ((t.data && t.data.text) || '');
  const u = new URL('/api/save', location.origin); u.searchParams.set('token', TOKEN);
  const res = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: t.path, text }) });
  const j = await res.json().catch(() => ({}));
  if (j.error) { toast('保存失败: ' + j.error); return; }
  t.text = text; t.dirty = false;
  if (t.data) t.data.text = text;
  renderTabs(); showActive(); refreshGit(); toast('已保存 ✓');
}

/* ================= 终端 ================= */
const term = { ws: null, x: null, fit: null, pane: 'term' };
function termPane(name) {
  term.pane = name;
  $('#term-host').style.display = name === 'term' ? '' : 'none';
  // 这些面板用 .term-hidden{display:none!important} 控制，必须切 class（内联 display 会被 !important 压掉）
  $('#problems').classList.toggle('term-hidden', name !== 'problems');
  $('#output').classList.toggle('term-hidden', name !== 'output');
  $('#gitgraph').classList.toggle('term-hidden', name !== 'gitgraph');
  $('#gitws').classList.toggle('term-hidden', name !== 'gitws');
  document.querySelectorAll('#term-tabs .tt[data-pane]').forEach((b) => b.classList.toggle('act', b.dataset.pane === name));
  if (name === 'term' && term.fit) term.fit.fit();
  if (name === 'gitgraph') refreshGraph();
  if (name === 'gitws') refreshGitWS();
}
document.querySelectorAll('#term-tabs .tt[data-pane]').forEach((b) => b.addEventListener('click', () => termPane(b.dataset.pane)));
$('#gw-refresh').addEventListener('click', refreshGitWS);
$('#gw-stageall').addEventListener('click', () => gitAction('stage-all', ''));
$('#gw-clean-untracked').addEventListener('click', async () => {
  const n = document.querySelectorAll('#gw-untracked .gw-row').length;
  if (!n) { toast('未跟踪列表为空'); return; }
  if (!(await dlgConfirm('确定删除全部未跟踪文件？共 ' + n + ' 个，删除后不可恢复。', { title: '全部删除', danger: true }))) return;
  gitAction('clean-untracked');
});
/* ================= 定时任务面板 ================= */
let tasksPoll = null;
function tasksApi(method, body, pathSuffix, qs) {
  const u = new URL('/api/tasks' + (pathSuffix || ''), location.origin);
  u.searchParams.set('token', TOKEN);
  if (qs) for (const k in qs) u.searchParams.set(k, qs[k]);
  const opt = { method, headers: {} };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  return fetch(u, opt).then((r) => r.json().catch(() => ({})));
}
function fmtDate(iso) { if (!iso) return '—'; const d = new Date(iso); if (isNaN(d)) return String(iso); return d.toLocaleString('zh-CN', { hour12: false }); }
function scheduleText(t) {
  const s = t.schedule || {};
  if (s.type === 'once') return '一次性 · ' + (s.at ? fmtDate(s.at) : '未设时间');
  if (s.type === 'daily') return '每天 ' + (s.time || '09:00');
  if (s.type === 'weekly') { const w = ['日', '一', '二', '三', '四', '五', '六']; return '每周' + (w[s.dow] != null ? w[s.dow] : s.dow) + ' ' + (s.time || '09:00'); }
  if (s.type === 'interval') { const u2 = s.unit === 'hours' ? '小时' : s.unit === 'days' ? '天' : '分钟'; return '每隔 ' + (s.every || 1) + ' ' + u2; }
  return '未知';
}
function actionText(t) { const a = t.action || {}; return a.type === 'chat' ? '💬 发消息给 Codex' : a.type === 'shell' ? '⚡ 执行命令' : '—'; }
async function refreshTasks() {
  const j = await tasksApi('GET');
  const list = (j && j.tasks) || [];
  const box = $('#tasks-list');
  if (!list.length) { box.innerHTML = '<div class="ts-empty">还没有定时任务。点右上角「＋ 新建」，例如「每天 9 点让 Codex 总结昨天改动」。</div>'; return; }
  box.innerHTML = list.map((t) => {
    const lr = t.lastRun;
    const meta = '下次: ' + (t.nextRun ? fmtDate(new Date(t.nextRun).toISOString()) : '—') +
      (lr ? ' ｜ 上次: ' + fmtDate(lr.at) + ' ' + (lr.ok ? '<span class="ts-ok">✓</span>' : '<span class="ts-err">✗</span>') : '');
    const sum = lr && lr.summary ? '<div class="ts-meta">' + esc(lr.summary.slice(0, 320)) + '</div>' : '';
    return '<div class="ts-row" data-id="' + t.id + '">' +
      '<div class="ts-top"><span class="ts-name">' + esc(t.name) + '</span>' +
      '<span class="ts-toggle" data-act="toggle" title="启用/暂停">' + (t.enabled ? '🟢' : '⚪') + '</span>' +
      '<span class="ts-acts"><button class="gw-b" data-act="run">运行</button><button class="gw-b" data-act="edit">编辑</button><button class="gw-b" data-act="del">删除</button></span></div>' +
      '<div class="ts-sched">' + esc(scheduleText(t)) + ' ｜ ' + esc(actionText(t)) + (t.enabled ? '' : ' ｜ 已暂停') + '</div>' +
      '<div class="ts-meta">' + meta + '</div>' + sum + '</div>';
  }).join('');
  box.querySelectorAll('.ts-row').forEach((row) => {
    const id = row.dataset.id;
    row.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'run') { await tasksApi('POST', null, '/run', { id }); toast('已触发运行'); await refreshTasks(); }
      else if (act === 'del') { if (await dlgConfirm('删除该定时任务？', { title: '删除确认', danger: true })) { await tasksApi('DELETE', null, '', { id }); await refreshTasks(); } }
      else if (act === 'toggle') { const all = await tasksApi('GET'); const t = all.tasks.find((x) => x.id === id); if (!t) return; await tasksApi('POST', { id: t.id, name: t.name, enabled: !t.enabled, schedule: t.schedule, action: t.action }); await refreshTasks(); }
      else if (act === 'edit') { openTaskForm(id); }
    }));
  });
}
function openTasks() {
  $('#tasks-mask').style.display = 'flex';
  $('#tasks-form').style.display = 'none';
  refreshTasks();
  if (tasksPoll) clearInterval(tasksPoll);
  tasksPoll = setInterval(refreshTasks, 10000);
}
function closeTasks() { $('#tasks-mask').style.display = 'none'; if (tasksPoll) { clearInterval(tasksPoll); tasksPoll = null; } }
$('#btn-tasks').addEventListener('click', openTasks);
$('#ts-close').addEventListener('click', closeTasks);
$('#tasks-mask').addEventListener('click', (e) => { if (e.target.id === 'tasks-mask') closeTasks(); });
$('#ts-new').addEventListener('click', () => openTaskForm(null));
function openTaskForm(id, prefill) {
  const form = $('#tasks-form'); form.style.display = 'block'; form.innerHTML = '';
  const load = id ? tasksApi('GET').then((j) => (j.tasks || []).find((x) => x.id === id)) : Promise.resolve(null);
  const pf = prefill || {};
  load.then((t) => {
    const s = (t && t.schedule) || { type: 'daily', time: '09:00' };
    const a = (t && t.action) || Object.assign({ type: 'chat', prompt: '', sandbox: 'workspace-write' }, pf.action || {});
    form.innerHTML =
      '<div class="tf-field"><label>任务名称</label><input id="tf-name" value="' + esc(t ? t.name : (pf.name || '')) + '" placeholder="例如：每天总结 git 改动"></div>' +
      '<div class="tf-field"><label>调度方式</label><select id="tf-stype">' +
      '<option value="once">一次性（指定时间）</option><option value="daily">每天</option><option value="weekly">每周</option><option value="interval">间隔循环</option></select></div>' +
      '<div id="tf-sched-fields"></div>' +
      '<div class="tf-field"><label>执行动作</label><select id="tf-atype">' +
      '<option value="chat">💬 发消息给 Codex（复用本应用同一条 Codex 引擎）</option><option value="shell">⚡ 执行命令（在仓库目录运行）</option></select></div>' +
      '<div id="tf-action-fields"></div>' +
      '<div class="tf-field"><label><input type="checkbox" id="tf-enabled" ' + ((t ? t.enabled : true) ? 'checked' : '') + '> 启用</label></div>' +
      '<div class="tf-actions"><button class="gw-b" id="tf-cancel">取消</button><button class="gw-b" id="tf-save" style="background:var(--accent);color:#fff;border-color:transparent">保存</button></div>';
    const stype = $('#tf-stype'); stype.value = s.type;
    const atype = $('#tf-atype'); atype.value = a.type;
    function renderSched() {
      const sf = $('#tf-sched-fields'); const ty = stype.value;
      if (ty === 'once') sf.innerHTML = '<div class="tf-field"><label>执行时间</label><input type="datetime-local" id="tf-at"></div>';
      else if (ty === 'daily') sf.innerHTML = '<div class="tf-field"><label>每天时间 (HH:MM)</label><input id="tf-time" value="' + esc(s.time || '09:00') + '"></div>';
      else if (ty === 'weekly') sf.innerHTML = '<div class="tf-field"><label>星期</label><select id="tf-dow">' + [0, 1, 2, 3, 4, 5, 6].map((d) => '<option value="' + d + '">' + ['日', '一', '二', '三', '四', '五', '六'][d] + '</option>').join('') + '</select></div><div class="tf-field"><label>时间 (HH:MM)</label><input id="tf-time" value="' + esc(s.time || '09:00') + '"></div>';
      else sf.innerHTML = '<div class="tf-row"><div class="tf-field"><label>每隔</label><input type="number" id="tf-every" min="1" value="' + esc(s.every || 30) + '"></div><div class="tf-field"><label>单位</label><select id="tf-unit"><option value="minutes">分钟</option><option value="hours">小时</option><option value="days">天</option></select></div></div>';
      if (ty === 'weekly' && s.dow != null) $('#tf-dow').value = s.dow;
      if (ty === 'interval' && s.unit) $('#tf-unit').value = s.unit;
    }
    function renderAction() {
      const af = $('#tf-action-fields');
      if (atype.value === 'chat') af.innerHTML = '<div class="tf-field"><label>要让 Codex 执行的指令 / 问题</label><textarea id="tf-prompt" placeholder="例如：总结仓库里昨天的 git 改动并列出风险">' + esc(a.prompt || '') + '</textarea></div><div class="tf-field"><label>权限</label><select id="tf-sandbox"><option value="workspace-write">workspace-write（可读写）</option><option value="read-only">read-only（只读）</option></select></div><div class="tf-field"><label>模型（留空=跟 Codex 默认）</label><input id="tf-model" value="' + esc(a.model || '') + '" placeholder="可选，如 auto/auto"></div>';
      else af.innerHTML = '<div class="tf-field"><label>命令（在仓库根目录执行）</label><input id="tf-cmd" value="' + esc(a.command || '') + '" placeholder="例如：npm test"></div>';
      if (atype.value === 'chat' && a.sandbox) $('#tf-sandbox').value = a.sandbox;
    }
    stype.addEventListener('change', renderSched);
    atype.addEventListener('change', renderAction);
    renderSched(); renderAction();
    $('#tf-cancel').addEventListener('click', () => { form.style.display = 'none'; form.innerHTML = ''; });
    $('#tf-save').addEventListener('click', async () => {
      const name = $('#tf-name').value.trim(); if (!name) { toast('请输入任务名称'); return; }
      const ty = stype.value; let schedule;
      if (ty === 'once') schedule = { type: 'once', at: $('#tf-at').value || '' };
      else if (ty === 'daily') schedule = { type: 'daily', time: $('#tf-time').value || '09:00' };
      else if (ty === 'weekly') schedule = { type: 'weekly', dow: +$('#tf-dow').value, time: $('#tf-time').value || '09:00' };
      else { schedule = { type: 'interval', every: (+$('#tf-every').value || 1), unit: $('#tf-unit').value }; }
      let action;
      if (atype.value === 'chat') { const p = $('#tf-prompt').value.trim(); if (!p) { toast('请输入要给 Codex 的指令'); return; } action = { type: 'chat', prompt: p, sandbox: $('#tf-sandbox').value, model: $('#tf-model').value.trim() }; }
      else { const c = $('#tf-cmd').value.trim(); if (!c) { toast('请输入命令'); return; } action = { type: 'shell', command: c }; }
      const payload = { name, enabled: $('#tf-enabled').checked, schedule, action };
      if (id) payload.id = id;
      await tasksApi('POST', payload);
      form.style.display = 'none'; form.innerHTML = '';
      await refreshTasks();
    });
  });
}
$('#gw-commit-btn').addEventListener('click', () => {
  const msg = $('#gw-msg').value;
  if (!msg.trim()) { toast('请输入提交信息'); return; }
  gitAction('commit', '', msg).then((j) => { if (!j.error) $('#gw-msg').value = ''; });
});
$('#gw-commit-all').addEventListener('click', () => {
  const msg = $('#gw-msg').value;
  if (!msg.trim()) { toast('请输入提交信息'); return; }
  gitAction('commit', '', msg, true).then((j) => { if (!j.error) $('#gw-msg').value = ''; });
});

function wsURL(p) { return (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + p + '?token=' + TOKEN; }
function spawnTerm() {
  if (!window.Terminal) { showTermMsg('xterm.js 未加载'); return; }
  if (!INFO.pty) { showTermMsg('node-pty 原生模块不可用<br>（需要 x64 Node；或重装插件）'); return; }
  $('#term-msg').style.display = 'none';
  if (term.x) { try { term.x.dispose(); } catch {} term.x = null; }
  if (term.ws) { try { term.ws.close(); } catch {} term.ws = null; }
  const x = new Terminal({
    fontFamily: 'Cascadia Code, Consolas, "Sarasa Mono SC", monospace',
    fontSize: 13, cursorBlink: true, scrollback: 5000,
    theme: { background: '#f6f0e1', foreground: '#3f3828', cursor: '#b8860b', selectionBackground: '#e6d7ac' },
  });
  const fit = new FitAddon.FitAddon();
  x.loadAddon(fit);
  x.open($('#term-host'));
  fit.fit();
  term.x = x; term.fit = fit;
  const ws = new WebSocket(wsURL('/ws/term'));
  term.ws = ws;
  ws.onopen = () => {
    const shell = $('#shell-sel').value || undefined;
    ws.send(JSON.stringify({ type: 'spawn', shell, cols: x.cols, rows: x.rows, cwd: GIT.cwdHint || '' }));
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'data') x.write(m.data);
    else if (m.type === 'error') { x.write('\x1b[31m' + m.message + '\x1b[0m\r\n'); log('[term] ' + m.message); }
    else if (m.type === 'exit') { x.write('\r\n\x1b[90m[进程已结束 — 点 ＋ 新建终端]\x1b[0m\r\n'); }
  };
  ws.onclose = () => { x.write('\x1b[90m[连接断开]\x1b[0m\r\n'); };
  x.onData((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: d })); });
  x.onResize(({ cols, rows }) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
}
// 仅在终端真正可见时才创建 PTY，避免页面加载/刷新时无谓地拉起 shell 进程
function ensureTermSpawned() {
  if (document.body.classList.contains('hide-term')) return;
  if (term.ws && term.ws.readyState === 1) return;
  spawnTerm();
}
function showTermMsg(h) { const el = $('#term-msg'); el.innerHTML = h; el.style.display = 'flex'; }
$('#btn-newterm').addEventListener('click', () => { termPane('term'); ensureTermSpawned(); });
$('#btn-killterm').addEventListener('click', () => { if (term.ws) term.ws.send(JSON.stringify({ type: 'kill' })); });
window.addEventListener('resize', () => { if (term.fit && term.pane === 'term' && !document.body.classList.contains('hide-term')) term.fit.fit(); });

/* ================= 聊天（多会话 / codex exec 桥） ================= */
const chatConn = { ws: null, sandbox: LS.get('sandbox', 'workspace-write') };
let SESSIONS = [];
let activeSid = null;
let _saveT = null;
const LS_SESS = 'buddy_sessions_v1';
function uid() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function getSession(id) { return SESSIONS.find((s) => s.id === id); }
function activeSession() { return getSession(activeSid); }
function newSession(title) { const s = { id: uid(), title: title || 'New Chat', thread: null, running: false, cur: null, lastInput: '', att: [], logEl: null, logHtml: '', ts: Date.now(), turnChanges: [], pendingStop: false }; SESSIONS.push(s); return s; }
function saveSessions() {
  try {
    const data = SESSIONS.filter((s) => !s.hidden).map((s) => ({ id: s.id, title: s.title, thread: s.thread, ts: s.ts, logHtml: s.logEl ? s.logEl.innerHTML : (s.logHtml || '') }));
    LS.set(LS_SESS, JSON.stringify({ active: activeSid, list: data }));
    const hist = loadHistory();
    for (const d of data) upsertHistRec(hist, d);
    saveHistory(hist);
  } catch {}
}
function scheduleSave() { clearTimeout(_saveT); _saveT = setTimeout(saveSessions, 800); }
/* ---- 会话历史记录：持久化在服务端（~/.codex/codebuddy-workbench/chat-history.json），本地仅作缓存兜底 ---- */
const LS_HIST = 'buddy_history_v1';
let HIST_CACHE = null;
function loadHistLocal() { try { const a = JSON.parse(LS.get(LS_HIST, '[]') || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function loadHistory() { if (HIST_CACHE === null) HIST_CACHE = loadHistLocal(); return HIST_CACHE; }
// 启动 / 刷新时与服务端同步：合并本地与服务端（以较新 ts 为准），保证不丢数据
async function syncHistoryFromServer() {
  let server = [];
  try { const j = await api('/api/history'); if (j && Array.isArray(j.history)) server = j.history; } catch {}
  const m = {};
  for (const h of server) m[h.id] = h;
  for (const h of loadHistLocal()) { const e = m[h.id]; if (!e || (h.ts || 0) > (e.ts || 0)) m[h.id] = h; }
  HIST_CACHE = Object.values(m).slice(0, 500);
  try { LS.set(LS_HIST, JSON.stringify(HIST_CACHE)); } catch {}
}
let _histSaveT = null;
function saveHistory(a) {
  HIST_CACHE = a.slice(0, 500);
  try { LS.set(LS_HIST, JSON.stringify(HIST_CACHE)); } catch {}
  clearTimeout(_histSaveT);
  _histSaveT = setTimeout(() => { apiPost('/api/history', { history: HIST_CACHE }).catch(() => {}); }, 700);
}
function upsertHistRec(hist, rec) {
  const merged = { id: rec.id, title: rec.title, thread: rec.thread, logHtml: rec.logHtml, ts: rec.ts || Date.now() };
  if (rec.pinned !== undefined) merged.pinned = rec.pinned;
  const i = hist.findIndex((h) => h.id === rec.id);
  if (i >= 0) hist[i] = Object.assign({}, hist[i], merged);
  else hist.push(merged);
}
function dayKey(d) { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
function dayLabel(d) {
  const now = new Date(); const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const t1 = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((t0 - t1) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}
function relTime(ts) {
  const now = Date.now(); const diff = Math.max(0, now - (ts || now));
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' 小时前';
  const d = new Date(ts || now); const t0 = new Date();
  const dd = Math.round((new Date(t0.getFullYear(), t0.getMonth(), t0.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (dd === 1) return '昨天';
  if (dd < 7) return dd + ' 天前';
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}
function renderHistory() {
  const box = $('#hist-list'); if (!box) return;
  const q = ($('#hist-q').value || '').trim().toLowerCase();
  const map = {};
  for (const h of loadHistory()) map[h.id] = h;
  for (const s of SESSIONS) {
    const rec = { id: s.id, title: s.title, thread: s.thread, ts: s.ts, logHtml: s.logEl ? s.logEl.innerHTML : (s.logHtml || '') };
    map[rec.id] = Object.assign({}, map[rec.id] || {}, rec);
  }
  let hist = Object.values(map).filter((h) => h.logHtml && h.logHtml.trim());
  if (q) hist = hist.filter((h) => ((h.title || '') + ' ' + (h.logHtml || '')).toLowerCase().includes(q));
  hist.sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || ((b.ts || 0) - (a.ts || 0)));
  if (!hist.length) { box.innerHTML = '<div class="hist-empty">' + (q ? '没有匹配的历史对话' : '暂无历史对话') + '</div>'; return; }
  const groups = {}; const order = [];
  for (const h of hist) {
    const d = new Date(h.ts || Date.now()); const k = dayKey(d);
    if (!groups[k]) { groups[k] = { label: dayLabel(d), items: [] }; order.push(k); }
    groups[k].items.push(h);
  }
  box.innerHTML = order.map((k) => {
    const g = groups[k];
    return '<div class="hist-group"><div class="hist-gh">' + esc(g.label) + '</div>' + g.items.map((h) => {
      const cur = (h.id === activeSid) ? ' <span class="hist-cur">当前对话</span>' : '';
      return '<div class="hist-row" data-id="' + esc(h.id) + '">' +
        '<div class="hist-title2" title="' + esc(h.title || '') + '">' + (h.pinned ? '📌 ' : '') + esc(h.title || '未命名对话') + cur + '</div>' +
        '<div class="hist-meta">' + esc(relTime(h.ts)) + '</div>' +
        '<div class="hist-acts">' +
          '<button class="hist-imp" data-imp="' + esc(h.id) + '" title="导入到当前对话（继承上下文）">导入</button>' +
          '<button class="hist-del" data-del="' + esc(h.id) + '" title="删除">🗑</button>' +
        '</div>' +
        '</div>';
    }).join('') + '</div>';
  }).join('');
  box.querySelectorAll('.hist-row').forEach((row) => row.addEventListener('click', (e) => { if (e.target.closest('.hist-acts')) return; openHistoryItem(row.dataset.id); }));
  box.querySelectorAll('.hist-row').forEach((row) => row.addEventListener('contextmenu', (e) => { e.preventDefault(); showConvMenu(row.dataset.id, e.clientX, e.clientY); }));
  box.querySelectorAll('.hist-imp').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); importHistoryToCurrent(b.dataset.imp); }));
  box.querySelectorAll('.hist-del').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!(await dlgConfirm('删除这条历史对话？', { title: '删除确认', danger: true }))) return;
    deleteHistoryItem(b.dataset.del);
  }));
}
function openHistory() { $('#hist-panel').style.display = 'flex'; $('#hist-q').value = ''; renderHistory(); }
function closeHistory() { $('#hist-panel').style.display = 'none'; }
function openHistoryItem(id) {
  const open = getSession(id);
  if (open) { switchSession(id); closeHistory(); return; }
  const h = loadHistory().find((x) => x.id === id);
  if (!h) return;
  SESSIONS.forEach((x) => { if (x.logEl) x.logHtml = x.logEl.innerHTML; });
  const ns = { id: h.id, title: h.title || 'New Chat', thread: h.thread || null, running: false, cur: null, lastInput: '', att: [], logEl: null, logHtml: h.logHtml || '', ts: h.ts || Date.now() };
  SESSIONS.push(ns);
  renderSessionLogs();
  switchSession(ns.id);
  closeHistory();
}
function deleteHistoryItem(id) {
  const s = getSession(id);
  if (s && s.running) { toast('该会话正在运行，请先停止'); return; }
  SESSIONS.forEach((x) => { if (x.logEl) x.logHtml = x.logEl.innerHTML; });
  saveHistory(loadHistory().filter((h) => h.id !== id));
  if (s) {
    const idx = SESSIONS.indexOf(s); SESSIONS.splice(idx, 1);
    if (s.logEl) s.logEl.remove();
    if (!SESSIONS.length) { const ns = newSession(); activeSid = ns.id; renderSessionLogs(); switchSession(ns.id); }
    else if (id === activeSid) { activeSid = SESSIONS[Math.min(idx, SESSIONS.length - 1)].id; switchSession(activeSid); }
    else renderSessionTabs();
    saveSessions();
  }
  renderHistory();
}
function importHistoryToCurrent(id) {
  let rec = loadHistory().find((h) => h.id === id);
  if (!rec) { const ss = getSession(id); if (ss) rec = { id: ss.id, title: ss.title, thread: ss.thread, ts: ss.ts, logHtml: ss.logEl ? ss.logEl.innerHTML : (ss.logHtml || '') }; }
  if (!rec) { toast('未找到该历史对话'); return; }
  const s = activeSession();
  if (!s) return;
  if (id === activeSid) { toast('这已经是当前对话，无需导入'); closeHistory(); return; }
  if (!s.logEl) renderSessionLogs();
  if (!s.logEl) { toast('当前会话不可用，无法导入'); return; }
  const block = document.createElement('div');
  block.className = 'msg imp-block';
  block.innerHTML = '<div class="imp-title">⬇ 已导入历史对话：' + esc(rec.title || '未命名对话') + '（' + esc(relTime(rec.ts)) + '）作为上下文</div>' + (rec.logHtml || '');
  s.logEl.appendChild(block);
  s.logEl.scrollTop = 1e9;
  // 接管该历史的 codex 会话线程，下一次发送即可真正续聊、继承上下文
  if (rec.thread) { s.thread = rec.thread; LS.set('thread', rec.thread); if (s.id === activeSid) $('#thread-hint').textContent = '会话 ' + rec.thread.slice(0, 8); }
  saveSessions();
  closeHistory();
  toast('已导入到当前对话，可直接继续（已继承上下文）');
}
/* ================= 会话右键菜单（对标 Codex 会话操作） ================= */
function convById(id) {
  const s = getSession(id);
  if (s) return { id, title: s.title, logHtml: s.logEl ? s.logEl.innerHTML : (s.logHtml || ''), pinned: !!s.pinned, isOpen: true };
  const r = loadHistory().find((h) => h.id === id);
  if (r) return { id, title: r.title, logHtml: r.logHtml || '', pinned: !!r.pinned, isOpen: false };
  return null;
}
function htmlToText(html) {
  const d = document.createElement('div'); d.innerHTML = html || '';
  const msgs = d.querySelectorAll('.msg');
  if (!msgs.length) return (d.textContent || '').trim();
  return Array.from(msgs).map((m) => (m.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n');
}
function fnSafe(n) { return String(n || 'conv').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').slice(0, 60) || 'conv'; }
function downloadFile(name, content, mime) {
  try {
    const blob = new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  } catch { toast('下载失败'); }
}
function wrapShareHtml(title, html) {
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>' + esc(title || '对话') + '</title><style>body{font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:880px;margin:24px auto;padding:0 16px;color:#222;line-height:1.7}.msg{margin:14px 0;padding:10px 14px;border-radius:10px}.a{background:#f1f3f5}.q{background:#e7f0ff}.tool{background:#fafafa;border:1px solid #eee;font-size:13px}.imp-block{border-left:3px solid #2a9d8f;background:#f6fffa;padding:8px 10px;margin:14px 0}.imp-title{font-weight:600;font-size:12px;color:#2a7}.body{white-space:pre-wrap}.summary{cursor:pointer}.hint{color:#888;font-size:12px}</style></head><body><h2>' + esc(title || '对话') + '</h2>' + (html || '') + '</body></html>';
}
function renameConv(id) {
  const t = convById(id); if (!t) return;
  const v = prompt('重命名会话', t.title || 'New Chat'); if (v == null) return;
  const name = v.trim(); if (!name) return;
  const s = getSession(id); if (s) s.title = name;
  const hist = loadHistory(); const r = hist.find((h) => h.id === id);
  if (r) r.title = name; else if (s) upsertHistRec(hist, { id, title: name, thread: s.thread, logHtml: (s.logEl ? s.logEl.innerHTML : (s.logHtml || '')), ts: s.ts || Date.now() });
  saveHistory(hist);
  if (sideChatSession && sideChatSession.id === id) { const st = $('#sc-title'); if (st) st.textContent = name; }
  renderSessionTabs(); renderHistory(); saveSessions(); refreshSessionToolbar();
  toast('已重命名');
}
function pinConv(id, val) {
  const s = getSession(id); if (s) s.pinned = val;
  const hist = loadHistory(); const r = hist.find((h) => h.id === id);
  if (r) r.pinned = val; else if (s) upsertHistRec(hist, { id, title: s.title, thread: s.thread, logHtml: (s.logEl ? s.logEl.innerHTML : (s.logHtml || '')), ts: s.ts || Date.now(), pinned: val });
  saveHistory(hist);
  renderSessionTabs(); renderHistory(); saveSessions(); refreshSessionToolbar();
  toast(val ? '已置顶' : '已取消置顶');
}
function copyConv(id) { const t = convById(id); if (!t) return; copyText(htmlToText(t.logHtml)); }
function openConvWindow(id) { const url = location.pathname + '?s=' + encodeURIComponent(id) + (TOKEN ? '&token=' + encodeURIComponent(TOKEN) : ''); window.open(url, '_blank'); }
function addScheduledForConv(id) {
  const t = convById(id); if (!t) return;
  openTasks();
  openTaskForm(null, { name: t.title || 'New Chat', action: { type: 'chat', prompt: '（基于会话「' + (t.title || '') + '」继续）' } });
}
function forkConv(id) {
  const t = convById(id); if (!t) return;
  const ns = newSession(t.title ? (t.title + '（副本）') : 'New Chat');
  ns.logHtml = t.logHtml || ''; ns.thread = null;
  renderSessionLogs(); switchSession(ns.id); saveSessions();
  toast('已分叉为新会话（独立线程，可独立继续）');
}
let sideChatSession = null;
function openSideChat() {
  if (sideChatSession) { const i = SESSIONS.indexOf(sideChatSession); if (i >= 0) SESSIONS.splice(i, 1); sideChatSession = null; }
  $('#side-chat').classList.add('sc-open');
}
function closeSideChat() {
  if (sideChatSession) {
    if (sideChatSession.running && chatConn.ws) chatConn.ws.send(JSON.stringify({ type: 'abort', session: sideChatSession.id }));
    const i = SESSIONS.indexOf(sideChatSession); if (i >= 0) SESSIONS.splice(i, 1);
    sideChatSession = null;
  }
  $('#side-chat').classList.remove('sc-open');
}
function sideConv(id) {
  const t = convById(id); if (!t) return;
  openSideChat();
  const ns = { id: uid(), title: (t.title || 'New Chat') + ' · 侧边', thread: null, running: false, cur: null, lastInput: '', att: [], logEl: null, logHtml: '', ts: Date.now(), turnChanges: [], pendingStop: false, hidden: true, isSide: true, boundSid: id };
  SESSIONS.push(ns);
  const log = $('#sc-log');
  log.innerHTML = '<div class="imp-block" id="sc-note"><div class="imp-title">🔗 已绑定主会话的实时上下文</div>每次提问会自动带上主会话「' + esc(t.title || 'New Chat') + '」的最新记录，用来查进度 / 确认是否卡住。</div>';
  ns.logEl = log; sideChatSession = ns;
  $('#sc-title').textContent = ns.title;
  $('#sc-input').value = '';
  const b = $('#sc-send'); if (b) b.textContent = '发送';
  toast('侧边对话已就绪（提问会自动带上主会话最新记录）');
}
// 取主会话当前实时记录，作为旁路问题附带的上下文
function sideMainContext() {
  const s = sideChatSession; if (!s) return { text: '', state: '未知', len: 0 };
  const main = s.boundSid ? getSession(s.boundSid) : null;
  let txt = '';
  if (main && main.logEl) {
    const parts = [];
    main.logEl.querySelectorAll('.msg, .tool').forEach((el) => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('.msg-actions').forEach((x) => x.remove());
      const t = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) parts.push(t);
    });
    txt = parts.join('\n').trim();
  }
  const CAP = 12000;
  if (txt.length > CAP) txt = '…（前面内容已省略，仅保留最近部分）\n' + txt.slice(-CAP);
  const state = main ? (main.running ? '运行中' : '已结束') : '未知';
  const prefix = '你是「主会话」的旁路助手，用于回答关于主会话当前进度、是否卡住 / 是否正常推进的问题。\n主会话状态：' + state + '\n下面是主会话当前的实时记录（可能不完整，且可能仍在更新）：\n"""\n' + (txt || '（暂无记录）') + '\n"""\n请优先依据以上记录回答，简洁直接；若记录不足以判断，请明确说明「记录不足，无法判断」。';
  return { text: prefix, state, len: txt.length };
}
function sendSideChat() {
  const s = sideChatSession; if (!s) return;
  const ta = $('#sc-input'); const q = (ta.value || '').trim(); if (!q) return;
  if (s.running) { s.pendingStop = true; s.aborted = true; chatConn.ws && chatConn.ws.send(JSON.stringify({ type: 'abort', session: s.id })); return; }
  ta.value = '';
  const ctx = sideMainContext();
  const note = $('#sc-note');
  if (note) note.innerHTML = '<div class="imp-title">🔗 主会话上下文 · ' + ctx.state + '（本次带入 ' + ctx.len + ' 字）</div>每次提问会自动带上主会话最新实时记录。';
  const ok = sendChat(q, false, [], s.id, { contextPrefix: ctx.text });
  const b = $('#sc-send'); if (b) b.textContent = ok ? '■ 停止' : '发送';
}
function persistSide() {
  const s = sideChatSession; if (!s) return;
  const hist = loadHistory();
  upsertHistRec(hist, { id: s.id, title: s.title, thread: s.thread, logHtml: s.logEl ? s.logEl.innerHTML : (s.logHtml || ''), ts: s.ts || Date.now() });
  saveHistory(hist);
}
function promoteSide() {
  const s = sideChatSession; if (!s) return;
  if (s.logEl) { const note = s.logEl.querySelector('#sc-note'); if (note) note.remove(); }
  s.logHtml = s.logEl ? s.logEl.innerHTML : (s.logHtml || '');
  s.hidden = false; s.isSide = false; s.logEl = null;
  sideChatSession = null;
  $('#side-chat').classList.remove('sc-open');
  switchSession(s.id);
  saveSessions();
  toast('已转为普通会话，可在会话标签中查看');
}
function bindSideActions() {
  const root = $('#side-chat'); if (!root) return;
  root.querySelectorAll('[data-sact]').forEach((b) => b.addEventListener('click', async () => {
    const s = sideChatSession; if (!s) return;
    const act = b.dataset.sact;
    if (act === 'rename') renameConv(s.id);
    else if (act === 'pin') pinConv(s.id, !s.pinned);
    else if (act === 'copy') copyConv(s.id);
    else if (act === 'newwin') { persistSide(); openConvWindow(s.id); }
    else if (act === 'sched') addScheduledForConv(s.id);
    else if (act === 'fork') forkConv(s.id);
    else if (act === 'share') shareConv(s.id);
    else if (act === 'promote') promoteSide();
    else if (act === 'delete') closeSideChat();
  }));
}
$('#sc-close').addEventListener('click', closeSideChat);
$('#sc-send').addEventListener('click', sendSideChat);
$('#sc-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendSideChat(); } });
bindSideActions();
/* 标题栏「视图」下拉菜单（左上角：显示 / 隐藏面板） */
(function () {
  const btn = $('#btn-views'), menu = $('#views-menu');
  if (!btn || !menu) return;
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target) && e.target !== btn) menu.classList.remove('open'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.classList.remove('open'); });
  menu.querySelectorAll('.mi').forEach((it) => it.addEventListener('click', () => menu.classList.remove('open')));
})();
(function () {
  const win = $('#side-chat'), bar = $('#sc-bar'); if (!win || !bar) return;
  let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
  bar.addEventListener('mousedown', (e) => { if (e.target.closest('.sc-x')) return; drag = true; sx = e.clientX; sy = e.clientY; const r = win.getBoundingClientRect(); ox = r.left; oy = r.top; win.style.right = 'auto'; win.style.left = ox + 'px'; win.style.top = oy + 'px'; e.preventDefault(); });
  document.addEventListener('mousemove', (e) => { if (!drag) return; let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy); nx = Math.max(0, Math.min(window.innerWidth - 120, nx)); ny = Math.max(0, Math.min(window.innerHeight - 40, ny)); win.style.left = nx + 'px'; win.style.top = ny + 'px'; });
  document.addEventListener('mouseup', () => { drag = false; });
})();
function shareConv(id) {
  const t = convById(id); if (!t) return;
  downloadFile(fnSafe(t.title) + '.html', wrapShareHtml(t.title, t.logHtml), 'text/html');
  copyText(htmlToText(t.logHtml));
  toast('已导出 HTML 文件并复制文本到剪贴板');
}
function showConvMenu(id, x, y) {
  const t = convById(id); if (!t) return;
  const items = [
    { label: '重命名', fn: () => renameConv(id) },
    { label: t.pinned ? '取消置顶' : '置顶', fn: () => pinConv(id, !t.pinned) },
    { label: '复制内容', fn: () => copyConv(id) },
    { label: '在新窗口打开', fn: () => openConvWindow(id) },
    { label: '添加定时任务', fn: () => addScheduledForConv(id) },
    { label: '分叉（独立副本）', fn: () => forkConv(id) },
    { label: '新建侧边对话', fn: () => sideConv(id) },
    { label: '分享（导出 / 复制）', fn: () => shareConv(id) }
  ];
  showCtx(items, x, y);
}
function refreshSessionToolbar() {
  const s = activeSession(); if (!s) return;
  const t = $('#stb-title'); if (t) t.textContent = s.title;
  const th = $('#stb-thread'); if (th) th.textContent = s.thread ? ('会话 ' + s.thread.slice(0, 8)) : '';
  const pb = $('#session-toolbar [data-act="pin"]'); if (pb) pb.title = s.pinned ? '取消置顶' : '置顶';
}
function bindSessionToolbar() {
  const root = $('#session-toolbar'); if (!root) return;
  root.querySelectorAll('.stb-btn').forEach((b) => b.addEventListener('click', async () => {
    const s = activeSession(); if (!s) return;
    const act = b.dataset.act;
    if (act === 'rename') renameConv(s.id);
    else if (act === 'pin') pinConv(s.id, !s.pinned);
    else if (act === 'copy') copyConv(s.id);
    else if (act === 'newwin') openConvWindow(s.id);
    else if (act === 'sched') addScheduledForConv(s.id);
    else if (act === 'fork') forkConv(s.id);
    else if (act === 'side') sideConv(s.id);
    else if (act === 'share') shareConv(s.id);
    else if (act === 'delete') { if (await dlgConfirm('删除当前会话？将从会话标签与历史中移除。', { title: '删除会话', danger: true })) deleteHistoryItem(s.id); }
  }));
  refreshSessionToolbar();
}
$('#btn-hist').addEventListener('click', openHistory);
$('#hist-back').addEventListener('click', closeHistory);
$('#hist-q').addEventListener('input', renderHistory);
$('#hist-clear').addEventListener('click', async () => {
  if (!(await dlgConfirm('清空所有历史对话？此操作不可恢复（不影响已打开的会话）。', { title: '清空历史', danger: true }))) return;
  saveHistory([]);
  renderHistory();
});
function loadSessions() {
  let saved = null; try { saved = JSON.parse(LS.get(LS_SESS, '') || '{}'); } catch {}
  const list = (saved && saved.list) || [];
  if (!list.length) { const s = newSession('New Chat'); activeSid = s.id; return; }
  SESSIONS = list.map((d) => ({ id: d.id, title: d.title || 'New Chat', thread: d.thread || null, running: false, cur: null, lastInput: '', att: [], logEl: null, logHtml: d.logHtml || '', ts: d.ts || Date.now() }));
  activeSid = (saved.active && getSession(saved.active)) ? saved.active : SESSIONS[0].id;
}
function renderSessionTabs() {
  const box = $('#session-tabs'); if (!box) return; box.innerHTML = '';
  const arr = SESSIONS.slice().filter((s) => !s.hidden).sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || ((a.ts || 0) - (b.ts || 0)));
  arr.forEach((s) => {
    const b = document.createElement('div'); b.className = 's-tab' + (s.id === activeSid ? ' active' : '');
    const t = document.createElement('span'); t.className = 's-tab-t'; t.textContent = (s.pinned ? '📌 ' : '') + s.title; t.title = s.title;
    b.appendChild(t);
    const x = document.createElement('span'); x.className = 's-tab-x'; x.textContent = '×';
    x.addEventListener('click', (e) => { e.stopPropagation(); closeSession(s.id); });
    b.appendChild(x);
    b.addEventListener('click', () => switchSession(s.id));
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); showConvMenu(s.id, e.clientX, e.clientY); });
    box.appendChild(b);
  });
  const add = document.createElement('div'); add.className = 's-tab-add'; add.textContent = '＋'; add.title = '新会话'; add.addEventListener('click', () => { const s = newSession(); switchSession(s.id); });
  box.appendChild(add);
}
// 会话标题：首条真实消息发出后，若仍是默认名「会话 N」则改为对话首句（对齐 CodeBuddy 用对话标题做标签）
function maybeAutoTitle(s, text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return;
  if (/^(New Chat|会话\s*\d+)$/.test(s.title)) {
    s.title = t.length > 24 ? t.slice(0, 24) + '…' : t;
    renderSessionTabs();
    saveSessions();
  }
}
function renderSessionLogs() {
  const box = $('#chat-sessions'); if (!box) return; box.innerHTML = '';
  SESSIONS.forEach((s) => {
    if (s.hidden) return;
    const d = document.createElement('div'); d.className = 'chat-log'; d.id = 'log-' + s.id; d.innerHTML = s.logHtml || '';
    d.style.display = (s.id === activeSid) ? 'flex' : 'none';
    box.appendChild(d); s.logEl = d;
  });
}
function switchSession(id) {
  activeSid = id;
  const box = $('#chat-sessions');
  if (box) {
    const ids = new Set(SESSIONS.map((x) => x.id));
    Array.from(box.children).forEach((el) => {
      if (!el.classList || !el.classList.contains('chat-log')) return;
      const lid = el.id.indexOf('log-') === 0 ? el.id.slice(4) : '';
      if (!ids.has(lid)) { el.remove(); return; }
      el.style.display = 'none';
    });
  }
  const s = getSession(id);
  if (s && !s.hidden) {
    if (!s.logEl || !s.logEl.isConnected) {
      const d = document.createElement('div'); d.className = 'chat-log'; d.id = 'log-' + s.id; d.innerHTML = s.logHtml || '';
      box.appendChild(d); s.logEl = d;
    }
    s.logEl.style.display = 'flex';
  }
  renderSessionTabs();
  if (!s) return;
  if (!s.hidden) {
    setRunning(s.running, id);
    $('#thread-hint').textContent = s.thread ? '会话 ' + s.thread.slice(0, 8) : '';
  }
  refreshSessionToolbar();
  saveSessions();
}
function closeSession(id) {
  const s = getSession(id); if (!s) return;
  if (s.running) { toast('该会话正在运行，请先停止'); return; }
  if (SESSIONS.length <= 1) { toast('至少保留一个会话'); return; }
  const idx = SESSIONS.indexOf(s); SESSIONS.splice(idx, 1);
  if (s.logEl && s.logEl.parentNode) s.logEl.parentNode.removeChild(s.logEl);
  if (id === activeSid) { const nx = SESSIONS[Math.min(idx, SESSIONS.length - 1)]; activeSid = nx.id; switchSession(activeSid); }
  else renderSessionTabs();
  saveSessions();
}
function chatState(html) { $('#chat-state').innerHTML = html || ''; }
function chatConnect() {
  const ws = new WebSocket(wsURL('/ws/chat'));
  chatConn.ws = ws;
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return }; handleChatMsg(m); };
  ws.onclose = () => { const s = activeSession(); if (s && s.running) setRunning(false, s.id); chatState('<span style="color:var(--red)">断开</span>'); setTimeout(chatConnect, 1200); };
  ws.onopen = () => chatState('<span style="color:var(--green)">就绪</span>');
}
function setRunning(b, sid) {
  const s = getSession(sid); if (s) s.running = b;
  if (sid === activeSid) {
    $('#send').disabled = !b && !$('#inp').value.trim();
    $('#send').classList.toggle('stop', b);
    $('#send').textContent = b ? '■' : '↑';
    $('#send').title = b ? '停止 (Esc)' : '发送 (Enter)';
  }
}
function addMsg(cls, html, s) {
  const el = document.createElement('div'); el.className = 'msg ' + cls; el.innerHTML = html;
  s.logEl.appendChild(el); s.logEl.scrollTop = 1e9;
  return el;
}
function handleChatMsg(m) {
  const sid = m.session;
  const s = sid ? getSession(sid) : (m.type === 'status' ? activeSession() : null);
  if (!s) return;
  handleSessionMsg(s, m);
}
function handleSessionMsg(s, m) {
  if (m.type === 'status') {
    setRunning(m.state === 'running', s.id);
    if (m.threadId) { s.thread = m.threadId; LS.set('thread', m.threadId); }
    if (m.state === 'running') { s.aborted = false; s.pendingStop = false; }
    const st = (m.state === 'failed' && s.aborted) ? 'aborted' : m.state;
    if (m.state === 'failed' && s.aborted) s.aborted = false;
    if (s.id === activeSid) { $('#thread-hint').textContent = s.thread ? '会话 ' + s.thread.slice(0, 8) : ''; chatState(st === 'running' ? '<span class="spin"></span> 运行中' : st === 'failed' ? '<span style="color:var(--red)">失败</span>' : st === 'aborted' ? '<span style="color:var(--fg2)">已停止</span>' : '<span style="color:var(--green)">就绪</span>'); }
    if (st === 'aborted' && s.pendingStop && !s.hidden) { s.pendingStop = false; setTimeout(() => promptStopRollback(s), 120); }
    if (s.isSide) { const b = $('#sc-send'); if (b) b.textContent = (m.state === 'running') ? '■ 停止' : '发送'; }
    return;
  }
  if (m.type === 'error') { addMsg('a', '<div class="err">' + esc(m.message) + '</div>', s); scheduleSave(); return; }
  if (m.type === 'note') { addMsg('a', '<div class="hintmsg">' + esc(m.text) + '</div>', s); scheduleSave(); return; }
  if (m.type === 'codex-stderr') { log('[codex stderr] ' + m.text); return; }
  if (m.type !== 'codex') return;
  const e = m.event;
  if (e.type === 'thread.started') { s.thread = e.thread_id; LS.set('thread', e.thread_id); if (s.id === activeSid) $('#thread-hint').textContent = '会话 ' + e.thread_id.slice(0, 8); return; }
  if (e.type === 'turn.started') { s.cur = null; s.turnChanges = []; s.pendingStop = false; return; }
  if (e.type === 'item.started') { ensureItemEl(e.item || {}, s); return; }
  if (e.type === 'item.updated') { const el = findItemEl((e.item || {}).id, s); if (el) fillItemEl(el, e.item || {}); return; }
  if (e.type === 'item.completed') {
    const it = e.item || {};
    if (it.type === 'error') {
      const msg = it.message || JSON.stringify(it);
      const cls = /Model metadata|fallback metadata|Reconnecting|timed out/i.test(msg) ? 'warn' : 'err';
      addMsg('a', '<div class="' + cls + '">' + esc(msg) + '</div>', s); scheduleSave(); return;
    }
    const el = ensureItemEl(it, s); fillItemEl(el, it);
    if (it.type === 'file_change') {
      for (const c of (it.changes || [])) { if (c && c.path && !(s.turnChanges || []).some((x) => x.path === c.path)) { (s.turnChanges = s.turnChanges || []).push({ path: c.path, kind: c.kind || 'update' }); } }
      refreshGit(); refreshOpenDirs();
    }
    else if (it.type === 'agent_message' || it.type === 'command_execution') refreshGit();
    scheduleSave(); return;
  }
  if (e.type === 'error') {
    const msg = e.message || (e.error && e.error.message) || '未知错误';
    const cls = /Reconnecting|429|Too Many Requests|rate limit|timed out|metadata/i.test(msg) ? 'warn' : 'err';
    addMsg('a', '<div class="' + cls + '">' + esc(msg) + '</div>', s); scheduleSave(); return;
  }
  if (e.type === 'turn.failed') { setRunning(false, s.id); if (s.id === activeSid) chatState('<span style="color:var(--red)">失败</span>'); addMsg('a', '<div class="err">' + esc((e.error && e.error.message) || '本轮失败') + '</div>', s); if (s.isSide) { const b = $('#sc-send'); if (b) b.textContent = '发送'; } scheduleSave(); return; }
  if (e.type === 'turn.completed') { setRunning(false, s.id); if (s.id === activeSid) chatState('<span style="color:var(--green)">就绪</span>'); refreshGit(); refreshOpenDirs(); attachLatestActions(s); if (s.isSide) { const b = $('#sc-send'); if (b) b.textContent = '发送'; } notifyDone(); scheduleSave(); return; }
}

function findItemEl(id, s) { return id ? s.logEl.querySelector('[data-iid="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]') : null; }
function ensureItemEl(it, s) {
  const log = s.logEl; const id = it.id || '';
  let el = findItemEl(id, s); if (el) return el;
  if (it.type === 'agent_message') {
    el = addMsg('a', '<div class="body"><span class="spin"></span></div>', s); el.setAttribute('data-iid', id);
  } else if (it.type === 'reasoning') {
    el = document.createElement('details'); el.className = 'msg a'; el.open = true;
    el.innerHTML = '<summary style="color:var(--fg3);font-size:11.5px;cursor:pointer">🧠 思考过程 <span class="spin"></span></summary><div class="think"></div>';
    log.appendChild(el); log.scrollTop = 1e9; el.setAttribute('data-iid', id);
  } else {
    // command_execution / file_change / web_search / 其它工具统一用 .tool 卡片
    el = document.createElement('div'); el.className = 'tool';
    el.innerHTML = '<span class="dot"></span><span class="t"></span>' + (it.type === 'web_search' ? '' : '<span class="mk"></span><pre></pre>');
    log.appendChild(el); log.scrollTop = 1e9; el.setAttribute('data-iid', id);
  }
  return el;
}
function fillItemEl(el, it) {
  if (it.type === 'agent_message') {
    const b = el.querySelector('.body'); if (b) b.innerHTML = DOMPurify.sanitize(marked.parse(it.text || '', { async: false }));
    el.dataset.raw = it.text || '';
  } else if (it.type === 'reasoning') {
    const t = el.querySelector('.think'); if (t) t.textContent = it.text || '';
    const sp = el.querySelector('summary .spin'); if (sp) sp.remove();
  } else if (it.type === 'command_execution') {
    const t = el.querySelector('.t'); if (t) t.textContent = '$ ' + (it.command || '');
    const p = el.querySelector('pre'); if (p) p.textContent = it.aggregated_output || '';
    const mk = el.querySelector('.mk'); if (mk) { const ok = it.status === 'completed' && it.exit_code === 0; mk.textContent = (it.exit_code != null ? (ok ? '✓' : '✗ ' + it.exit_code) : '…'); }
  } else if (it.type === 'file_change') {
    const t = el.querySelector('.t'); if (t) t.textContent = '📝 文件变更 ' + (it.changes || []).length + ' 个';
    const p = el.querySelector('pre'); if (p) p.textContent = (it.changes || []).map((c) => c.kind + ' ' + c.path).join('\n');
  } else if (it.type === 'web_search') {
    const t = el.querySelector('.t'); if (t) t.textContent = '🔍 搜索: ' + (it.query || '');
  } else {
    const t = el.querySelector('.t'); if (t) t.textContent = esc((it.type || '') + (it.title ? ' ' + it.title : ''));
    const p = el.querySelector('pre'); if (p) p.textContent = JSON.stringify(it).slice(0, 2000);
  }
}
function ensureMsgActions(el, s) {
  if (!el || el.querySelector('.msg-actions')) return;
  // 只保留最新一条助手消息的操作栏，避免每条消息都出现一排在视觉上重复
  s.logEl.querySelectorAll('.msg-actions').forEach((x) => x.remove());
  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  const copy = document.createElement('button');
  copy.className = 'ma'; copy.textContent = '复制';
  copy.addEventListener('click', () => {
    const t = el.dataset.raw || '';
    const fallback = () => { try { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('已复制'); } catch { toast('复制失败'); } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(() => toast('已复制'), fallback);
    else fallback();
  });
  const regen = document.createElement('button');
  regen.className = 'ma'; regen.textContent = '重新生成';
  regen.addEventListener('click', () => regenInSession(s.id));
  bar.appendChild(copy); bar.appendChild(regen);
  el.appendChild(bar);
}
function regenInSession(sid) {
  const s = getSession(sid); if (!s) return;
  if (s.running) { toast('正在运行，请稍候'); return; }
  if (!s.lastInput) { toast('没有可重新生成的输入'); return; }
  sendChat(s.lastInput, true, [], sid);
}
// 只给「最后一条助手消息」附加复制/重新生成操作栏（整轮结束后）
function attachLatestActions(s) {
  let target = null;
  s.logEl.querySelectorAll('.msg.a[data-iid]').forEach((m) => { if (m.querySelector('.body')) target = m; });
  if (target) ensureMsgActions(target, s);
}
// 手动停止后：可选回退本轮产物或保留
function promptStopRollback(s) {
  const ch = (s.turnChanges || []).filter((c) => c && c.path);
  if (!ch.length) { toast('已停止，本轮没有产生文件改动'); return; }
  const lines = ch.slice(0, 25).map((c) => '· ' + c.kind + '  ' + c.path).join('\n') + (ch.length > 25 ? '\n… 共 ' + ch.length + ' 个文件' : '');
  (async () => {
    const ok = await dlgConfirm('已停止本次生成。本轮改动了 ' + ch.length + ' 个文件：\n' + lines + '\n\n【确定】回退这些改动（新增文件删除；修改/删除的文件用 git checkout 还原到最近提交）\n【取消】保留现状', { title: '停止后处理', danger: true });
    if (!ok) { toast('已保留本次改动'); return; }
    try {
      const r = await apiPost('/api/rollback', { changes: ch });
      const rev = (r && r.reverted) || []; const fail = (r && r.failed) || [];
      toast('已回退 ' + rev.length + ' 个文件' + (fail.length ? '，' + fail.length + ' 个未能回退（非 git 仓库或未跟踪）' : ''));
      s.turnChanges = [];
      refreshGit(); refreshOpenDirs();
      if (typeof refreshTree === 'function') refreshTree();
    } catch { toast('回退失败'); }
  })();
}
function notifyDone() {
  toast('✓ 任务完成');
  const base = document.title.replace(/^✓\s*/, '');
  document.title = '✓ ' + base;
  try { if (window.Notification && Notification.permission === 'granted') new Notification('任务完成', { body: '本轮已完成' }); } catch {}
  setTimeout(() => { if (document.title.indexOf('✓ ') === 0) document.title = base; }, 5000);
}
function toolRow(title, mark, detail, s) {
  const d = document.createElement('div'); d.className = 'tool';
  d.innerHTML = '<span class="dot"></span><span class="t">' + esc(title) + '</span>' + (mark ? '<span>' + esc(mark) + '</span>' : '') + (detail ? '<pre>' + esc(detail.slice(0, 20000)) + '</pre>' : '');
  if (detail) d.addEventListener('click', () => d.classList.toggle('open'));
  s.logEl.appendChild(d); s.logEl.scrollTop = 1e9;
}
function addUserMsg(text, atts, s) {
  let html = '<div class="bubble">' + (text ? esc(text) : '<span style="color:#bcd">（仅附件）</span>');
  if (atts && atts.length) {
    html += '<div class="att-sent">';
    for (const a of atts) html += '<span class="att-chip2">' + (a.kind === 'image' ? '🖼 ' : '📄 ') + esc(a.name) + '</span>';
    html += '</div>';
  }
  html += '</div>';
  addMsg('u', html, s);
}
function sendChat(text, quiet, attachments, sid, opts) {
  sid = sid || activeSid;
  const s = getSession(sid); if (!s) return false;
  attachments = attachments || [];
  if ((!text || !text.trim()) && attachments.length === 0) return false;
  if (s.running) return false;
  if (!chatConn.ws || chatConn.ws.readyState !== 1) {
    chatState('<span style="color:var(--red)">未连接</span>');
    addMsg('a', '<div class="err">聊天连接未就绪（服务可能刚重启）。消息未发送 —— 请稍等几秒或刷新页面后重试。</div>', s);
    return false;
  }
  const sent = attachments.filter((a) => a.relPath && !a.err).map((a) => ({ name: a.name, kind: a.kind, path: a.relPath }));
  let body = text || '';
  for (const a of sent) {
    if (a.kind === 'image') body += '\n\n[图片附件] ' + a.name + '（已作为图片附上，codex 可直接查看）';
    else if (a.inline && a.text != null) body += '\n\n--- 附件文件：' + a.name + ' ---\n' + a.text;
    else body += '\n\n[附件文件] ' + a.path + '（已保存到项目内 .buddy-attachments，请按需读取）';
  }
  let finalText = body.trim() || (sent.length ? '请查看我附加的文件 / 图片并据此回答。' : '');
  if (opts && opts.contextPrefix) finalText = opts.contextPrefix + '\n\n' + finalText;
  s.lastInput = finalText;
  s.ts = Date.now();
  if (!quiet) { maybeAutoTitle(s, text); addUserMsg(text || '', sent, s); }
  const model = $('#model-sel').value || '';
  chatConn.ws.send(JSON.stringify({ type: 'send', session: sid, text: finalText, sandbox: chatConn.sandbox, model, resume: !!s.thread, attachments: sent }));
  return true;
}
$('#send').addEventListener('click', () => {
  const s = activeSession(); if (!s) return;
  if (s.running) { s.pendingStop = true; s.aborted = true; chatConn.ws && chatConn.ws.send(JSON.stringify({ type: 'abort', session: s.id })); return; }
  const i = $('#inp');
  const atts = s.att.slice();
  if (sendChat(i.value, false, atts, s.id)) { i.value = ''; i.style.height = 'auto'; s.att = []; renderAttList(); }
});
$('#inp').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#send').click(); }
});
$('#inp').addEventListener('input', (e) => {
  const i = e.target; i.style.height = 'auto'; i.style.height = Math.min(170, i.scrollHeight) + 'px';
  setRunning(activeSession().running, activeSid);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const s = activeSession(); if (s && s.running && chatConn.ws) { s.pendingStop = true; s.aborted = true; chatConn.ws.send(JSON.stringify({ type: 'abort', session: activeSid })); } } });

/* ================= 附件（上传 / 拖拽 / 从文件树附） ================= */
const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'];
const TXT_EXT = ['txt', 'md', 'markdown', 'json', 'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rb', 'rs', 'php', 'sh', 'bat', 'ps1', 'yml', 'yaml', 'toml', 'ini', 'html', 'htm', 'css', 'scss', 'less', 'xml', 'csv', 'log', 'sql', 'tex', 'env', 'gitignore'];
function uploadFile(file) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => { const b64 = (r.result || '').split(',')[1] || ''; apiPost('/api/upload', { name: file.name, data: b64 }).then(resolve, (e) => resolve({ error: e.message || '上传失败' })); };
    r.onerror = () => resolve({ error: '读取文件失败' });
    r.readAsDataURL(file);
  });
}
function fmtSize(n) { if (!n) return ''; if (n < 1024) return n + 'B'; if (n < 1024 * 1024) return (n / 1024).toFixed(0) + 'KB'; return (n / 1048576).toFixed(1) + 'MB'; }
function addFileAttachment(file) {
  const kind = (file.type && file.type.indexOf('image/') === 0) ? 'image' : 'file';
  const att = { id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6), name: file.name, kind, file, size: file.size, relPath: null, text: null, inline: false, err: null, url: (kind === 'image' ? URL.createObjectURL(file) : null) };
  activeSession().att.push(att); renderAttList();
  uploadFile(file).then((j) => {
    if (j.error) { att.err = j.error; renderAttList(); toast('⚠ 附件上传失败：' + j.error); return; }
    att.relPath = j.path;
    if (kind === 'file' && file.size <= 30000 && TXT_EXT.includes((file.name.split('.').pop() || '').toLowerCase())) {
      file.text().then((t) => { att.text = t; att.inline = t.length <= 20000; renderAttList(); }).catch(() => {});
    }
    renderAttList();
  });
  return att;
}
function addTreeAttachment(rel) {
  const ext = (rel.split('.').pop() || '').toLowerCase();
  const kind = IMG_EXT.includes(ext) ? 'image' : 'file';
  if (activeSession().att.some((a) => a.relPath === rel)) { toast('已在附件中'); return; }
  activeSession().att.push({ id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6), name: rel.split('/').pop(), kind, relPath: rel, size: 0, text: null, inline: false, err: null, fromTree: true });
  renderAttList();
}
function removeAtt(id) { activeSession().att = activeSession().att.filter((a) => a.id !== id); renderAttList(); }
function renderAttList() {
  const box = $('#att-list'); if (!box) return;
  if (!activeSession().att.length) { box.innerHTML = ''; return; }
  box.innerHTML = activeSession().att.map((a) => {
    const thumb = a.url ? '<img src="' + esc(a.url) + '">' : (a.kind === 'image' ? '🖼' : '📄');
    const sz = a.size ? '<span class="sz">' + fmtSize(a.size) + '</span>' : '';
    const status = a.err ? '<span class="sz" style="color:var(--red)">✗</span>' : (a.relPath ? '' : '<span class="spinmini"></span>');
    return '<span class="att-chip' + (a.err ? ' err' : '') + '" title="' + esc(a.name) + '">' + thumb +
      '<span class="nm">' + esc(a.name) + '</span>' + sz + status +
      '<span class="x" data-id="' + a.id + '">×</span></span>';
  }).join('');
  box.querySelectorAll('.x').forEach((x) => x.addEventListener('click', () => removeAtt(x.dataset.id)));
}
$('#btn-attach').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => { for (const f of e.target.files) addFileAttachment(f); e.target.value = ''; });
['#chat-sessions', '#composer'].forEach((sel) => {
  const el = $(sel); if (!el) return;
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag'); });
  el.addEventListener('dragleave', (e) => { if (e.target === el) el.classList.remove('drag'); });
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drag'); const files = e.dataTransfer && e.dataTransfer.files; if (files) for (const f of files) addFileAttachment(f); });
});

/* ================= 设置面板（插件 / MCP / 规则 / 记忆 / 生成 / 技能 / Agent） ================= */
let settingsTab = 'plug';
let _skillsCache = null;
function loadSkillsData() {
  if (_skillsCache) return Promise.resolve(_skillsCache);
  return api('/api/skills').then((r) => { _skillsCache = (r && r.skills) || []; return _skillsCache; }, () => { _skillsCache = []; return []; });
}
const SET_TABS = [{ id: 'plug', name: '插件' }, { id: 'mcp', name: 'MCP' }, { id: 'rule', name: '规则' }, { id: 'mem', name: '记忆' }, { id: 'gen', name: '生成' }, { id: 'skills', name: '技能' }, { id: 'agent', name: 'Agent' }];
const SKILL_ICON = { pptx: '📊', pdf: '📄', docx: '📝', xlsx: '📈', 'agent-browser': '🌐' };
function skillIcon(n) { const k = String(n || '').toLowerCase(); return SKILL_ICON[k] || '🧩'; }
function openSettings() { $('#settings-panel').style.display = 'flex'; renderSettingsTabs(); renderSettingsBody(); }
function closeSettings() { $('#settings-panel').style.display = 'none'; }
function renderSettingsTabs() {
  const box = $('#set-tabs'); if (!box) return;
  box.innerHTML = SET_TABS.map((t) => '<div class="set-tab' + (t.id === settingsTab ? ' active' : '') + '" data-tab="' + t.id + '">' + esc(t.name) + '</div>').join('');
  box.querySelectorAll('.set-tab').forEach((el) => el.addEventListener('click', () => { settingsTab = el.dataset.tab; renderSettingsTabs(); renderSettingsBody(); }));
}
function insertSkillRef(name, desc) {
  const i = $('#inp'); const ref = '@' + name + (desc ? '：' + desc : '');
  i.value = (i.value ? i.value + '\n' : '') + ref; i.focus(); i.dispatchEvent(new Event('input', { bubbles: true }));
  toast('已插入技能引用：' + name); closeSettings();
}
function safeName(n) { return String(n || '').replace(/[\\/]/g, '').slice(0, 120) || 'untitled'; }
function renderSettingsBody() {
  const body = $('#set-body'); if (!body) return;
  if (settingsTab === 'gen') { renderGenSettings(body); return; }
  if (settingsTab === 'mcp') { renderMcpSettings(body); return; }
  if (settingsTab === 'rule') { renderRulesSettings(body); return; }
  if (settingsTab === 'mem') { renderMemorySettings(body); return; }
  if (settingsTab === 'plug' || settingsTab === 'skills') {
    const isPlug = settingsTab === 'plug';
    body.innerHTML = '<div class="set-h">' + (isPlug ? '插件管理' : '技能') + '</div><div class="set-sub">' + (isPlug ? '管理插件以扩展 CodeBuddy 功能（来自 ~/.codex/skills）。' : '同步自 codex 的 ~/.codex/skills。') + '</div><div class="set-search-wrap"><input id="set-search" class="set-search" placeholder="搜索插件…" spellcheck="false"></div><div id="set-pl-list" class="pl-grid"></div>';
    const list = body.querySelector('#set-pl-list');
    const draw = () => {
      const q = ((body.querySelector('#set-search') || {}).value || '').toLowerCase();
      loadSkillsData().then((arr) => {
        if (!arr.length) { list.innerHTML = '<div class="set-empty">未找到 codex 技能（~/.codex/skills 为空）</div>'; return; }
        const filtered = arr.filter((s) => !q || ((s.name || '') + ' ' + (s.description || '')).toLowerCase().includes(q));
        list.innerHTML = filtered.map((s) => '<div class="pl-card"><div class="pl-ic">' + skillIcon(s.name) + '</div><div class="pl-main"><div class="pl-name">' + esc(s.name || '') + ' <span class="pl-badge">skill</span></div><div class="pl-desc">' + esc(s.description || '（无描述）') + '</div></div><button class="pl-btn" data-ins="' + esc(s.name) + '" data-desc="' + esc(s.description || '') + '">' + (isPlug ? '管理' : '插入对话') + '</button></div>').join('') || '<div class="set-empty">没有匹配的插件</div>';
        list.querySelectorAll('[data-ins]').forEach((b) => b.addEventListener('click', () => insertSkillRef(b.dataset.ins, b.dataset.desc)));
      });
    };
    draw();
    body.querySelector('#set-search').addEventListener('input', draw);
    return;
  }
  const info = {
    agent: ['Agent', 'Codex 通过内置 Agent（由 codex exec 驱动）执行任务。本机 ~/.codex/agents 暂无自定义定义文件；如需自定义 Agent，在其放置定义后此处会列出。']
  }[settingsTab];
  if (info) body.innerHTML = '<div class="set-h">' + esc(info[0]) + '</div><div class="set-sub">' + esc(info[1]) + '</div>';
}
function renderGenSettings(body) {
  body.innerHTML = '<div class="set-h">生成（与 codex 配置双向同步）</div><div class="set-sub">修改会直接写入 ~/.codex/config.toml，codex 下次启动即生效；此处也作为本会话默认。</div><div class="set-field"><label>模型 model（写入 config.toml）</label><select id="set-model"></select></div><div class="set-field"><label>默认模型（本应用优先，覆盖 config.toml）</label><select id="set-default-model"><option value="">跟随 config.toml</option></select><div class="set-note">在此设置后，每次打开页面 / 新会话都会默认用此项；留空则跟随 config.toml 的 model。</div></div><div class="set-field"><label>权限 sandbox（写入 [windows]）</label><select id="set-sandbox"><option value="workspace-write">workspace-write（可读写）</option><option value="read-only">read-only（只读）</option><option value="danger-full-access">danger-full-access</option><option value="elevated">elevated</option></select></div>';
  const sb = $('#set-sandbox'); const ms = $('#set-model');
  Promise.all([api('/api/models').catch(() => null), api('/api/codex-config').catch(() => null)]).then((r) => {
    const m = r[0] || {}; const c = r[1] || {};
    const def = m.default || ''; const cfgModel = c.model || def;
    const models = m.models || [];
    const opts = [];
    if (cfgModel && !models.some((x) => (x.id || x) === cfgModel)) opts.push('<option value="' + esc(cfgModel) + '">' + esc(cfgModel) + '（来自配置）</option>');
    for (const x of models) opts.push('<option value="' + esc(x.id || x) + '">' + esc(x.name || x.id || x) + '</option>');
    ms.innerHTML = opts.join('');
    ms.value = cfgModel;
    const dm = $('#set-default-model');
    if (dm) { dm.innerHTML = '<option value="">跟随 config.toml</option>' + opts.join(''); dm.value = LS.get('defaultModel') || ''; }
    sb.value = c.sandbox || chatConn.sandbox;
    const dmEl = $('#set-default-model');
    if (dmEl) dmEl.addEventListener('change', () => {
      const v = dmEl.value;
      LS.set('defaultModel', v);
      const top = $('#model-sel'); if (top) top.value = v;
      const sm = $('#set-model'); if (sm) sm.value = v || cfgModel;
      toast(v ? ('已设置默认模型：' + v) : '已恢复为跟随 config.toml');
    });
  });
  ms.addEventListener('change', () => {
    const v = ms.value;
    apiPost('/api/codex-config', { model: v }).then(() => { LS.set('model', v); const top = $('#model-sel'); if (top) top.value = v; toast('已写入 ~/.codex/config.toml 的 model'); }, () => toast('写入失败'));
  });
  sb.addEventListener('change', () => {
    const v = sb.value;
    apiPost('/api/codex-config', { sandbox: v }).then(() => { chatConn.sandbox = v; LS.set('sandbox', v); const top = $('#sandbox-sel'); if (top) top.value = v; toast('已写入 ~/.codex/config.toml 的 [windows] sandbox'); }, () => toast('写入失败'));
  });
}
function renderMcpSettings(body) {
  body.innerHTML = '<div class="set-h">MCP 服务器（与 codex 同步）</div><div class="set-sub">来自 ~/.codex/config.toml 的 [mcp_servers]，增删/启停会直接改写该文件（自动备份为 config.toml.bak）。</div><div id="mcp-list" class="pl-grid"></div><div style="margin-top:10px"><button class="pl-btn" id="mcp-add">＋ 新增 MCP 服务器</button></div>';
  const list = body.querySelector('#mcp-list');
  const draw = (arr) => {
    if (!arr || !arr.length) { list.innerHTML = '<div class="set-empty">没有配置 MCP 服务器</div>'; return; }
    list.innerHTML = arr.map((s) => '<div class="pl-card"><div class="pl-ic">🔌</div><div class="pl-main"><div class="pl-name">' + esc(s.name) + ' <span class="pl-badge">' + (s.enabled ? '已启用' : '已停用') + '</span></div><div class="pl-desc">' + esc(s.command || '（无 command）') + '</div></div><div class="pl-acts"><button class="pl-btn" data-tg="' + esc(s.name) + '">' + (s.enabled ? '停用' : '启用') + '</button><button class="pl-btn" data-rm="' + esc(s.name) + '">删除</button></div></div>').join('');
    list.querySelectorAll('[data-tg]').forEach((b) => b.addEventListener('click', () => { apiPost('/api/codex-config', { mcp: [{ op: 'toggle', name: b.dataset.tg }] }).then(mcpLoad, () => toast('操作失败')); }));
    list.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => { if (!(await dlgConfirm('删除 MCP 服务器 ' + b.dataset.rm + '？将改写 config.toml', { title: '删除', danger: true }))) return; apiPost('/api/codex-config', { mcp: [{ op: 'remove', name: b.dataset.rm }] }).then(mcpLoad, () => toast('删除失败')); }));
  };
  const mcpLoad = () => api('/api/codex-config').then((c) => draw(c.mcp), () => draw([]));
  mcpLoad();
  body.querySelector('#mcp-add').addEventListener('click', async () => {
    const name = prompt('MCP 服务器名称（如 my-server）'); if (!name) return;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) { toast('名称仅限字母数字下划线短横'); return; }
    const command = prompt('启动命令（如 npx -y @modelcontextprotocol/server-filesystem）'); if (command == null) return;
    apiPost('/api/codex-config', { mcp: [{ op: 'add', name, command }] }).then(mcpLoad, () => toast('新增失败'));
  });
}
function renderRulesSettings(body) {
  body.innerHTML = '<div class="set-h">规则 AGENTS.md（全局）</div><div class="set-sub">对应 ~/.codex/AGENTS.md，codex 启动时会读取作为系统指令；修改即时写回。</div><textarea id="rule-ta" class="set-ta" placeholder="在此编写全局规则…"></textarea><div style="margin-top:8px"><button class="pl-btn" id="rule-save">保存</button></div>';
  api('/api/codex-agents-md').then((r) => { const ta = $('#rule-ta'); if (ta) ta.value = (r && r.content) || ''; }, () => { const ta = $('#rule-ta'); if (ta) ta.value = ''; });
  body.querySelector('#rule-save').addEventListener('click', () => { apiPost('/api/codex-agents-md', { content: $('#rule-ta').value }).then(() => toast('已写入 ~/.codex/AGENTS.md'), () => toast('保存失败')); });
}
function renderMemorySettings(body) {
  body.innerHTML = '<div class="set-h">记忆 memories</div><div class="set-sub">对应 ~/.codex/memories 下的文件，codex 把长期记忆存这里。可新增 / 编辑 / 删除。</div><div id="mem-list" class="pl-grid"></div><div style="margin-top:10px"><button class="pl-btn" id="mem-new">＋ 新建记忆</button></div><div id="mem-edit" style="margin-top:10px;display:none"><textarea id="mem-ta" class="set-ta"></textarea><div style="margin-top:8px"><button class="pl-btn" id="mem-save">保存</button><button class="pl-btn" id="mem-del">删除</button></div></div>';
  const list = body.querySelector('#mem-list');
  const showEdit = (name, content) => { const e = body.querySelector('#mem-edit'); e.style.display = 'block'; e.querySelector('#mem-ta').value = content || ''; e.querySelector('#mem-ta').dataset.name = name || ''; };
  const refresh = () => api('/api/codex-memories').then((r) => { const files = (r && r.files) || []; list.innerHTML = files.length ? files.map((f) => '<div class="pl-card"><div class="pl-ic">🧠</div><div class="pl-main"><div class="pl-name">' + esc(f.name) + ' <span class="pl-badge">' + (f.size || 0) + ' B</span></div></div><button class="pl-btn" data-open="' + esc(f.name) + '">编辑</button></div>').join('') : '<div class="set-empty">暂无记忆文件</div>'; list.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { const n = b.dataset.open; apiPost('/api/codex-memories', { op: 'read', name: n }).then((r) => showEdit(n, (r && r.content) || ''), () => toast('读取失败')); })); }, () => { list.innerHTML = '<div class="set-empty">读取失败</div>'; });
  refresh();
  body.querySelector('#mem-new').addEventListener('click', async () => { const n = prompt('记忆文件名（如 project-notes.md）'); if (!n) return; showEdit(safeName(n), ''); });
  body.querySelector('#mem-save').addEventListener('click', () => { const e = body.querySelector('#mem-edit'); const ta = e.querySelector('#mem-ta'); const n = ta.dataset.name; if (!n) return; apiPost('/api/codex-memories', { op: 'save', name: n, content: ta.value }).then(() => { toast('已保存'); refresh(); }, () => toast('保存失败')); });
  body.querySelector('#mem-del').addEventListener('click', async () => { const e = body.querySelector('#mem-edit'); const n = e.querySelector('#mem-ta').dataset.name; if (!n) return; if (!(await dlgConfirm('删除记忆 ' + n + '？', { title: '删除', danger: true }))) return; apiPost('/api/codex-memories', { op: 'delete', name: n }).then(() => { e.style.display = 'none'; refresh(); }, () => toast('删除失败')); });
}
/* ================= 中间区内嵌浏览器（CodeBuddy 风格：单浏览器标签 + 地址栏） ================= */
let brHist = []; let brIdx = -1;
function brNorm(u) {
  u = (u || '').trim(); if (!u) return '';
  if (/^(https?:|file:|about:|data:)/i.test(u)) return u;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(u)) return 'http://' + u;
  if (/^[\w.-]+\.[a-z]{2,}(\/|\?|$)/i.test(u)) return 'https://' + u;
  if (/^[\w.-]+:\d+(\/|\?|$)/.test(u)) return 'http://' + u;
  return 'https://' + u;
}
// 把浏览器作为中间预览区的一个标签打开（单浏览器，CodeBuddy 风格）
function openBrowserTab(url) {
  let t = tabs.find((x) => x.path === '__browser__');
  if (!t) { t = { path: '__browser__', name: '浏览器', kind: 'browser' }; tabs.push(t); }
  setActive('__browser__');
  if (url) brNavigate(url);
}
function brNavigate(url) {
  url = brNorm(url); if (!url) return;
  if (brIdx < brHist.length - 1) brHist = brHist.slice(0, brIdx + 1);
  brHist.push(url); brIdx = brHist.length - 1;
  const inp = $('#br-url'); if (inp) inp.value = url;
  const f = $('#br-iframe'); if (f) { f.src = url; const h = $('#br-hint'); if (h) h.style.display = 'none'; }
}
function brBack() { if (brIdx > 0) { brIdx--; const u = brHist[brIdx]; const inp = $('#br-url'); if (inp) inp.value = u; const f = $('#br-iframe'); if (f) f.src = u; } }
function brFwd() { if (brIdx < brHist.length - 1) { brIdx++; const u = brHist[brIdx]; const inp = $('#br-url'); if (inp) inp.value = u; const f = $('#br-iframe'); if (f) f.src = u; } }
function brReload() { const f = $('#br-iframe'); if (f && brHist[brIdx]) f.src = brHist[brIdx]; }
$('#btn-browser').addEventListener('click', () => openBrowserTab(''));
$('#br-back').addEventListener('click', brBack);
$('#br-fwd').addEventListener('click', brFwd);
$('#br-reload').addEventListener('click', brReload);
$('#br-go').addEventListener('click', () => brNavigate($('#br-url').value));
$('#br-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') brNavigate($('#br-url').value); });
$('#br-ext').addEventListener('click', () => { const u = $('#br-url').value; if (u) window.open(u, '_blank'); });
$('#btn-settings').addEventListener('click', openSettings);
$('#set-close').addEventListener('click', closeSettings);
// 文件树快捷键：F2 重命名 / Delete 删除（输入框聚焦时忽略）
const inEditable = () => document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
document.addEventListener('keydown', (e) => {
  if (!selectedPath || inEditable()) return;
  if (e.key === 'F2') { e.preventDefault(); renameItem(selectedPath); }
  else if (e.key === 'Delete' && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); deleteItem(selectedPath); }
});
// 文件树空白区右键：在根目录新建
$('#tree-body').addEventListener('contextmenu', (e) => {
  if (e.target.closest('.row')) return;
  e.preventDefault(); e.stopPropagation();
  treeCtxMenu('', true, e.clientX, e.clientY, true);
});
$('#btn-newchat').addEventListener('click', () => { const s = newSession(); switchSession(s.id); toast('已新建会话'); });
const sandboxSel = $('#sandbox-sel');
if (sandboxSel) {
  sandboxSel.value = chatConn.sandbox;
  sandboxSel.addEventListener('change', () => { chatConn.sandbox = sandboxSel.value; LS.set('sandbox', chatConn.sandbox); });
}
const micBtn = $('#btn-mic');
if (micBtn) micBtn.addEventListener('click', () => toast('语音输入暂未实现'));

/* ================= Git 提交图 ================= */
const gg = { loaded: false, loading: false, currentOnly: LS.get('gg-current', false), uniqueOnly: LS.get('gg-unique', false), open: null, cache: {} };

async function refreshGraph() {
  if (gg.loading) return;
  gg.loading = true;
  try {
    const r = await api('/api/git-graph');
    gg.data = r;
    gg.loaded = true;
    renderGraph();
    api('/api/git-branches').then((br) => fillBranchSel(br)).catch(() => {});
  } catch (e) { $('#gg-list').innerHTML = '<div class="gg-empty">加载失败: ' + esc(e.message) + '</div>'; }
  gg.loading = false;
}

/* 泳道布局（gitk 同款 lane-buffer 算法）：
   按时间倒序处理提交，维护"泳道头部提交"列表；每个提交的第一个父沿用本泳道，
   其余父/被多个子共享的父走合并连接。保证分叉/合并/共享父都画对，无空泳道堆积。 */
const LANE_COLORS = ['#4f9cf0', '#3fb950', '#d7a823', '#a970ff', '#f0786c', '#56d4dd', '#e066b5', '#9aa0a6'];
function laneColor(l) { return LANE_COLORS[l % LANE_COLORS.length]; }
function computeGraph(commits) {
  const idx = {}; commits.forEach((c, i) => { idx[c.hash] = i; });
  const par = commits.map((c) => c.parents.map((p) => idx[p]).filter((p) => p !== undefined));
  const lanes = [];          // 每条泳道头部提交在 commits 里的下标，或 -1 空
  const commitLane = {};     // 提交下标 -> 所在泳道
  const rows = [];
  for (let i = 0; i < commits.length; i++) {
    let lane = lanes.indexOf(i);
    if (lane === -1) { lane = lanes.indexOf(-1); if (lane === -1) { lanes.push(-1); lane = lanes.length - 1; } lanes[lane] = i; }
    commitLane[i] = lane;
    const pcols = [];
    for (let k = 0; k < par[i].length; k++) {
      const p = par[i][k]; let pl;
      if (k === 0 && commitLane[p] === undefined) { pl = lane; lanes[lane] = p; commitLane[p] = pl; }
      else if (commitLane[p] !== undefined) { pl = commitLane[p]; }                 // 已被别的子占用 -> 合并进来
      else { pl = lanes.indexOf(-1); if (pl === -1) { lanes.push(-1); pl = lanes.length - 1; } lanes[pl] = p; commitLane[p] = pl; }
      pcols.push(pl);
    }
    if (par[i].length === 0 && lanes[lane] === i) lanes[lane] = -1;                 // 根提交 -> 释放本泳道
    const active = [];
    for (let l = 0; l < lanes.length; l++) active[l] = lanes[l] !== -1;
    rows.push({ c: commits[i], col: lane, pcols, active, laneCount: 1 });
  }
  let mx = 1;
  for (const r of rows) { const m = Math.max(r.col + 1, ...r.pcols.map((p) => p + 1)); r.laneCount = mx = Math.max(mx, m); }
  for (const r of rows) r.laneCount = mx;
  return rows;
}

function refBadge(r) {
  let cls = 'local';
  if (/^tag:/.test(r)) return '<span class="gg-ref tag">' + esc(r.replace(/^tag: /, '')) + '</span>';
  if (/^HEAD/.test(r)) cls = 'head';
  if (/^origin\//.test(r) || /\/[^/]+\/HEAD$/.test(r)) cls = 'remote';
  const label = cls === 'head' ? r.replace(/^HEAD -> /, '') + ' (HEAD)' : r;
  return '<span class="gg-ref ' + cls + '">' + esc(label) + '</span>';
}

function renderGraph() {
  const d = gg.data || {};
  const list = $('#gg-list');
  $('#gg-title').textContent = d.repo ? '提交图 · ' + (d.branch || '?') : '提交图';
  $('#gg-ab').textContent = d.repo ? (d.ahead ? '↑' + d.ahead + ' 待推送  ' : '') + (d.behind ? '↓' + d.behind + ' 待拉取' : '') : '';
  if (!d.repo) { list.innerHTML = '<div class="gg-empty">非 Git 仓库</div>'; return; }
  let commits = d.commits || [];
  const cur = (d.branch || '').trim();
  const det = cur === 'DETACHED';
  if (gg.uniqueOnly && cur && !det) {
    const byHash = new Map(commits.map((c) => [c.hash, c]));
    const reach = (hs) => { const seen = new Set(); const q = hs.slice(); while (q.length) { const h = q.shift(); if (seen.has(h)) continue; seen.add(h); const c = byHash.get(h); if (!c) continue; for (const p of c.parents) q.push(p); } return seen; };
    const curTips = commits.filter((c) => c.refs.some((r) => r === cur || r.endsWith('/' + cur))).map((c) => c.hash);
    const otherTips = commits.filter((c) => c.refs.some((r) => !r.startsWith('HEAD') && !r.startsWith('tag:') && r !== cur)).map((c) => c.hash);
    const curR = reach(curTips), otherR = reach(otherTips);
    commits = commits.filter((c) => curR.has(c.hash) && !otherR.has(c.hash));
  } else if (gg.currentOnly && cur && !det) {
    const tip = commits.find((c) => c.refs.some((r) => r === cur || r.endsWith('/' + cur)));
    if (tip) { const seen = new Set(); const keep = []; const q = [tip.hash];
      while (q.length) { const h = q.shift(); if (seen.has(h)) continue; seen.add(h);
        const c = commits.find((x) => x.hash === h); if (!c) continue; keep.push(c); for (const p of c.parents) q.push(p); }
      const rank = new Map(keep.map((c, i) => [c.hash, i]));
      commits = keep.sort((a, b2) => (rank.get(a.hash) ?? 1e9) - (rank.get(b2.hash) ?? 1e9));
    }
  }
  if (!commits.length) { list.innerHTML = '<div class="gg-empty">' + (gg.uniqueOnly ? '当前分支无独有提交（与已有分支/标签完全共享）' : '无提交') + '</div>'; return; }
  const rows = computeGraph(commits);
  const X0 = 9, DX = 13, R = 3.4;
  const x = (l) => X0 + l * DX;
  const curBranch = (d.branch || '').trim();
  const frags = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const { c, col, pcols, active, laneCount } = rows[ri];
    const w = Math.max(60, laneCount * 13 + 8);
    let sv = '<svg viewBox="0 0 ' + w + ' 30" preserveAspectRatio="none" style="width:' + w + 'px;height:30px">';
    // 继承自上行的活动泳道竖线（穿过本行）
    for (let l = 0; l < active.length; l++) {
      if (active[l]) { const xl = x(l); sv += '<line x1="' + xl + '" y1="0" x2="' + xl + '" y2="30" stroke="' + laneColor(l) + '" stroke-width="1.5" opacity="0.7"/>'; }
    }
    // 从本行到父格的连接（合并/分叉：曲线；直上：不画，由父行竖线承接）
    for (let k = 0; k < pcols.length; k++) {
      const to = pcols[k]; if (to === col) continue;
      const fx = x(col), tx = x(to);
      sv += '<path d="M' + fx + ' 14 C ' + fx + ' 24, ' + tx + ' 8, ' + tx + ' 14" fill="none" stroke="' + laneColor(col) + '" stroke-width="1.5" opacity="0.85"/>';
    }
    const onCur = c.refs.includes(curBranch);
    sv += '<circle cx="' + x(col) + '" cy="14" r="' + R + '" fill="' + laneColor(col) + '" stroke="' + (onCur ? '#f6f0e1' : 'rgba(0,0,0,.35)') + '" stroke-width="' + (onCur ? 1.6 : 1) + '"/>';
    sv += '</svg>';
    const time = fmtTime(c.at);
    const isOpen = gg.open === c.hash;
    const refs = (c.refs.length ? c.refs.map(refBadge).join('') : '');
    frags.push('<div class="gg-row' + (isOpen ? ' open' : '') + (onCur ? ' on-cur' : '') + '" data-h="' + c.hash + '">' +
      '<div class="gg-cell">' + sv + '</div>' +
      '<span class="gg-hash" title="' + esc(c.hash) + '">' + esc(c.short) + '</span>' +
      '<span class="gg-msg"><b>' + esc(c.subject) + '</b>' + refs + '</span>' +
      '<span class="gg-au">' + esc(c.author) + '</span>' +
      '<span class="gg-tm">' + time + '</span>' +
      '<span class="gg-rev" data-h="' + c.hash + '" title="回退到此版本">⤺</span></div>');
    if (isOpen) frags.push('<div class="gg-detail" id="gg-d">' + (gg.cache[c.hash] || '<div class="spin" style="margin:4px 0"></div>') + '</div>');
  }
  list.innerHTML = frags.join('');
  list.querySelectorAll('.gg-row').forEach((el) => el.addEventListener('click', () => {
    const h = el.dataset.h;
    gg.open = gg.open === h ? null : h;
    renderGraph();
  }));
  list.querySelectorAll('.gg-rev').forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation();
    gitResetTo(el.dataset.h);
  }));
  const dEl = document.getElementById('gg-d');
  if (dEl && gg.open) {
    if (gg.cache[gg.open]) bindDetail(dEl, gg.open);
    else loadGraphDetail(gg.open);
  }
}

function fmtTime(at) {
  const d = new Date(at * 1000), now = Date.now() / 1000;
  const diff = now - at;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 时';
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天';
  return (d.getMonth() + 1) + '-' + d.getDate();
}

async function loadGraphDetail(hash) {
  const el = document.getElementById('gg-d');
  if (!el) return;
  try {
    const r = await api('/api/git-show', { hash });
    let html;
    if (r.error) {
      html = '<div class="err">' + esc(r.error) + '</div>';
    } else {
      const rows = (r.files || []).map((f) =>
        '<div class="gg-f"><span class="st ' + esc((f.st[0] || 'M')) + '">' + esc(f.st[0] || 'M') + '</span>' +
        '<span class="nm" data-p="' + esc(f.name) + '" title="查看该提交对 ' + esc(f.name) + ' 的改动">' + esc(f.name) + '</span></div>').join('');
      html =
        '<div class="gg-dhead"><span class="gg-dmeta">' + esc(r.author || '') + ' · ' + (r.files ? r.files.length : 0) + ' 个文件 · ' + esc(r.hash.slice(0, 10)) + '</span>' +
        '<button class="gg-reset" data-h="' + esc(hash) + '">⤺ 回退到此版本</button></div>' +
        (r.body && r.body.trim() ? '<div class="body">' + esc(r.body.trim()) + '</div>' : '') +
        (rows || '<div style="color:var(--fg3)">无文件改动</div>');
    }
    gg.cache[hash] = html;
    if (el.isConnected) { el.innerHTML = html; bindDetail(el, hash); }
  } catch (e) {
    const html = '<div class="err">' + esc(e.message) + '</div>';
    gg.cache[hash] = html;
    if (el.isConnected) el.innerHTML = html;
  }
}
function bindDetail(el, hash) {
  el.querySelectorAll('.nm').forEach((n) => n.addEventListener('click', () => openDiffTab(n.dataset.p, hash)));
  const rb = el.querySelector('.gg-reset');
  if (rb) rb.addEventListener('click', () => gitResetTo(rb.dataset.h));
}
async function gitResetTo(hash) {
  if (!(await dlgConfirm('将当前分支回退到此提交 ' + String(hash).slice(0, 7) + '？\n未提交的改动会丢失（git reset --hard）。', { title: '回退版本', danger: true }))) return;
  const u = new URL('/api/git-action', location.origin); u.searchParams.set('token', TOKEN);
  const res = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reset', hash }) });
  const j = await res.json().catch(() => ({}));
  if (j.error) { toast('⚠ ' + zhGitErr(j.error)); return; }
  gg.cache = {}; gg.open = null;
  toast('已回退到 ' + String(hash).slice(0, 7));
  refreshGraph(); refreshGit(); refreshGitWS();
}

$('#gg-refresh').addEventListener('click', refreshGraph);
$('#gg-current').addEventListener('change', (e) => { gg.currentOnly = e.target.checked; LS.set('gg-current', gg.currentOnly); renderGraph(); });
$('#gg-current').checked = gg.currentOnly;
$('#gg-unique').addEventListener('change', (e) => { gg.uniqueOnly = e.target.checked; LS.set('gg-unique', gg.uniqueOnly); renderGraph(); });
$('#gg-unique').checked = gg.uniqueOnly;
function fillBranchSel(br) {
  if (!br || !br.branches) return;
  const main = br.main || (br.branches.some((b) => b.name === 'main') ? 'main' : (br.branches.some((b) => b.name === 'master') ? 'master' : ''));
  const html = br.branches.map((b) => {
    const isMain = b.name === main;
    const label = (isMain ? '★ ' : '') + b.name + (b.current ? ' ●' : '');
    return '<option ' + (b.current ? 'selected ' : '') + 'value="' + esc(b.name) + '">' + esc(label) + '</option>';
  }).join('');
  ['#gg-branch', '#gw-branch-sel', '#tree-branch'].forEach((id) => { const sel = $(id); if (sel) sel.innerHTML = html; });
}
function setBranchSelects(name) {
  if (!name) return;
  ['#gg-branch', '#gw-branch-sel', '#tree-branch'].forEach((id) => { const s = $(id); if (s) s.value = name; });
}
async function gitCheckout(name, create) {
  if (!name) return;
  const prev = (GIT && GIT.branch) || '';
  if (!(await dlgConfirm((create ? '新建并切换到分支 ' : '切换到分支 ') + name + (create ? '' : '\n未提交的改动若有冲突会被拒绝'), { title: '切换分支' }))) { setBranchSelects(prev); return; }
  const u = new URL('/api/git-action', location.origin); u.searchParams.set('token', TOKEN);
  const res = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'checkout', name, create: !!create }) });
  const j = await res.json().catch(() => ({}));
  if (j.error) { toast('⚠ ' + zhGitErr(j.error)); setBranchSelects(prev); return; }
  toast((create ? '已新建并切换：' : '已切换分支：') + name);
  gg.cache = {}; gg.open = null;
  await refreshOpenDirs();   // 重新拉取目录，反映新分支的文件
  reloadTabsForBranch();     // 重载已打开的标签（文件/diff）
  refreshGraph(); refreshGit(); refreshGitWS();
}
// 分支切换后重载已打开的标签：非 diff 文件重新读取（未修改时）；当前分支 diff 重算
function reloadTabsForBranch() {
  for (const t of tabs) {
    if (t.kind === 'diff') {
      if (t.hash) continue;
      t.loaded = false; t.loading = true;
      api('/api/git-diff', { path: t.rel }).then((r) => { t.diffText = r.diff || ''; t.loaded = true; t.loading = false; if (t.path === activeTab) showActive(); },
        () => { t.loaded = true; t.loading = false; if (t.path === activeTab) showActive(); });
    } else {
      if (t.dirty || isImg(t.path) || isPdf(t.path)) continue;
      t.loaded = false; t.loading = true;
      api('/api/file', { path: t.path }).then((r) => {
        t.data = r; t.text = r.binary ? '' : (r.text || ''); t.loaded = true; t.loading = false;
        if (t.path === activeTab) showActive();
      }, () => {
        t.loaded = true; t.loading = false;
        t.data = { text: '(当前分支下该文件不存在或读取失败)' }; t.text = '(当前分支下该文件不存在或读取失败)';
        if (t.path === activeTab) showActive();
      });
    }
  }
  if (activeTab) showActive();
}
$('#gg-branch').addEventListener('change', (e) => { const v = e.target.value; if (v) gitCheckout(v, false); });
$('#gg-newbranch').addEventListener('click', async () => { const name = await dlgPrompt('新建分支', '', '新分支名称（基于当前分支）：'); if (name) gitCheckout(name, true); });
$('#gw-branch-sel').addEventListener('change', (e) => { const v = e.target.value; if (v) gitCheckout(v, false); });
$('#gw-newbranch').addEventListener('click', async () => { const name = await dlgPrompt('新建分支', '', '新分支名称（基于当前分支）：'); if (name) gitCheckout(name, true); });
$('#tree-branch').addEventListener('change', (e) => { const v = e.target.value; if (v) gitCheckout(v, false); });
$('#tree-newbranch').addEventListener('click', async () => { const name = await dlgPrompt('新建分支', '', '新分支名称（基于当前分支）：'); if (name) gitCheckout(name, true); });

/* ================= 启动 ================= */
async function boot() {
  try { INFO = await api('/api/info'); }
  catch { toast('无法连接服务（token 失效？重新让 Codex 打开工作台）'); return; }
  ROOT = INFO.root;
  $('#proj-name').textContent = ROOT.split(/[\\/]/).pop() || ROOT;
  $('#proj-root').textContent = ROOT;
  $('#st-node').textContent = 'node ' + processInfo();
  document.title = 'Buddy — ' + $('#proj-name').textContent;
  try {
    const s = await api('/api/shells');
    const sel = $('#shell-sel');
    sel.innerHTML = (s.shells || []).map((x) => '<option value="' + esc(x.file) + '">' + esc(x.label) + '</option>').join('');
    const pref = LS.get('shell', '');
    if (pref) sel.value = pref;
    sel.addEventListener('change', () => { LS.set('shell', sel.value); spawnTerm(); });
  } catch {}
  try {
    const m = await api('/api/models');
    const sel = $('#model-sel');
    const opts = [];
    opts.push('<option value="">跟随配置（' + esc(m.default || '未配置') + '）</option>');
    for (const x of (m.models || [])) {
      const id = typeof x === 'string' ? x : (x.id || x);
      const name = typeof x === 'string' ? x : (x.name || x.id || x);
      opts.push('<option value="' + esc(id) + '">' + esc(name) + '</option>');
    }
    sel.innerHTML = opts.join('');
    // 默认模型优先：用户设置的 defaultModel > config.toml 的 model > 上次选择 > 服务端默认
    let cur = LS.get('defaultModel') || '';
    if (!cur) { try { const c = await api('/api/codex-config'); if (c && c.model) cur = c.model; } catch {} }
    if (!cur) cur = LS.get('model', m.default || '');
    sel.value = cur;
    sel.addEventListener('change', () => LS.set('model', sel.value));
  } catch {}
  applyLayout();
  await refreshOpenDirs();
  await refreshGit();
  termPane('term');
  await syncHistoryFromServer();
  loadSessions();
  renderSessionTabs();
  renderSessionLogs();
  switchSession(activeSid);
  const deepId = new URLSearchParams(location.search).get('s');
  if (deepId) { try { openHistoryItem(deepId); } catch (e) {} }
  bindSessionToolbar();
  chatConnect();
  $('#chat-sessions').addEventListener('click', (e) => { const t = e.target.closest('.tool'); if (t) t.classList.toggle('open'); });
  // 只在页面可见时刷新（后台标签页不启动多余的 git 进程），并避免上一轮未结束时重入
  let _autoRefreshing = false;
  setInterval(async () => {
    if (document.hidden || _autoRefreshing) return;
    _autoRefreshing = true;
    try {
      await refreshGit();
      if (term.pane === 'gitgraph' && !gg.loading) refreshGraph();
      if (term.pane === 'gitws') refreshGitWS();
    } finally { _autoRefreshing = false; }
  }, 12000);
  const a0 = activeSession();
  if (a0 && !a0.logHtml) addMsg('a', '<div class="body" style="color:var(--fg2)">👋 这里是接了 <b>codex exec</b> 的聊天栏。左树 / 中预览 / 下终端全部就位。发消息即可让 Codex 在 <code>' + esc($('#proj-name').textContent) + '</code> 里干活。支持多会话（顶部「＋」开新会话）与定时任务（顶部 🕒）。</div>', a0);
}
function processInfo() { return INFO ? (INFO.pty ? 'PTY ✓' : 'PTY ✗') : ''; }
boot();
})();
