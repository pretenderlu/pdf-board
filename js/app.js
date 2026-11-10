/* ============================================================
   app.js — 外壳装配层
   - 实例化 PdfPane / Board
   - PDF 打开（按钮 / 拖放 / 命令行）
   - 两种持久化模式：
       · 本机模式（无后端）：白板存在浏览器 IndexedDB，由 Board 自己管
       · 服务器模式（容器部署）：白板存在服务器，多设备共用同一块板
   - 白板列表：切换 / 新建 / 重命名 / 删除；自动保存到服务器
   ============================================================ */
import { PdfPane } from './pdf-pane.js';
import { Board } from './board.js';

/* ---------------- toast ---------------- */
const toastHost = document.getElementById('toast');
export function toast(msg, ms = 2400) {
  if (!toastHost) return;
  if (typeof msg !== 'string' || !msg.trim()) return;
  const el = document.createElement('div');
  el.className = 'toast-item';
  el.textContent = msg;
  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 220);
  }, ms);
  while (toastHost.children.length > 4) toastHost.firstElementChild.remove();
}
window.toast = toast;

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const splitEl = $('split');
const pdfHost = $('pdfPane');
const boardHost = $('boardPane');
const filePdf = $('filePdf');
const fileBoard = $('fileBoard');
const pdfNameEl = $('pdfName');
const dropMask = $('dropMask');
const helpDlg = $('helpDlg');
const boardBar = $('boardBar');
const boardSelect = $('boardSelect');
const boardStateEl = $('boardState');

/* ---------------- 服务器状态 ---------------- */
const SERVER = {
  on: false,          // 是否连上了后端
  token: '',          // 访问口令
  tokenRequired: false,
  boards: [],         // [{id,name,updatedAt,itemCount,bytes}]
  cur: null,          // 当前白板 id
  rev: 0,             // 乐观锁版本
  saveTimer: 0,
  saving: false,
  pending: false,
  dirty: false,       // 有未落盘的改动
  lastSig: '',        // 最近一次成功落盘时的内容签名
};

const SAVE_DEBOUNCE = 700;

/* ---------------- 实例 ---------------- */
let appClip = null;          // PDF 内部剪贴板（最近一次框选）
let board = null;            // Board 实例（服务器探测后才创建）

const pdf = new PdfPane(pdfHost, {
  toast,
  onClipAvailable: (clip) => { appClip = clip; },
  onSendToBoard: (clip) => {
    appClip = clip;
    sendToBoard(clip);
  },
  onTextToBoard: (text) => {
    if (!text) { toast('本页无文本层（扫描件）'); return; }
    if (!board || typeof board.addText !== 'function') { toast('白板尚未就绪'); return; }
    board.addText(text, { fontSize: 16, w: 560 });
  },
});

function sendToBoard(clip) {
  if (!clip) { toast('先框选一块区域'); return; }
  if (!board) { toast('白板尚未就绪'); return; }
  board.addClip(clip, { center: true });
}

/* ============================================================
   服务器模式
   ============================================================ */
// 支持放在反向代理的子路径下（如 https://host/pdfboard/）
const API_BASE = (() => {
  let p = location.pathname || '/';
  if (p.endsWith('.html')) p = p.slice(0, p.lastIndexOf('/') + 1);
  if (!p.endsWith('/')) p += '/';
  return p + 'api';
})();

function apiFetch(p, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (SERVER.token) headers['x-board-token'] = SERVER.token;
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return fetch(API_BASE + p, Object.assign({}, opts, { headers, cache: 'no-store' }));
}

async function detectServer() {
  // 判定方式：由后端在页面里注入 window.__PDFBOARD = { server: true }
  //  - 自托管（server.mjs / Docker）会自动注入 → 服务器模式
  //  - 纯静态托管（Vercel / GitHub Pages …）没有任何注入 → 直接用本机模式，
  //    连探测请求都不发，避免控制台出现 /api/health 的 404
  const hint = window.__PDFBOARD;
  if (!hint || hint.server !== true) return false;
  let res;
  try {
    res = await fetch(API_BASE + '/health', { cache: 'no-store' });
  } catch { return false; }
  if (res.status === 401) { SERVER.on = true; SERVER.tokenRequired = true; return true; }
  if (!res.ok) return false;
  let info = null;
  try { info = await res.json(); } catch { return false; }
  if (!info || !info.server) return false;
  SERVER.on = true;
  SERVER.tokenRequired = !!info.tokenRequired;
  return true;
}

function readTokenFromUrl() {
  try {
    const u = new URL(location.href);
    const t = u.searchParams.get('token');
    if (t) {
      SERVER.token = t;
      try { localStorage.setItem('pdfboard.token', t); } catch { /* ignore */ }
      u.searchParams.delete('token');
      history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
      return true;
    }
  } catch { /* ignore */ }
  try { SERVER.token = localStorage.getItem('pdfboard.token') || ''; } catch { SERVER.token = ''; }
  return !!SERVER.token;
}

function setState(text, cls = '') {
  if (!boardStateEl) return;
  boardStateEl.textContent = text || '';
  boardStateEl.className = 'board-state' + (cls ? ' ' + cls : '');
  if (board && typeof board.setSavedState === 'function' && SERVER.on) {
    try { board.setSavedState(text === '保存中…' ? '保存中…' : text); } catch { /* ignore */ }
  }
}

/* ---------- 白板列表 ---------- */
async function refreshBoardList() {
  const res = await apiFetch('/boards');
  if (res.status === 401) {
    const ok = await ensureToken();
    if (!ok) { SERVER.boards = []; renderBoardSelect(); setState('未授权', 'error'); return []; }
    return refreshBoardList();
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  SERVER.boards = Array.isArray(data.boards) ? data.boards : [];
  renderBoardSelect();
  return SERVER.boards;
}

function renderBoardSelect() {
  if (!boardSelect) return;
  boardSelect.innerHTML = '';
  for (const b of SERVER.boards) {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.name || '未命名白板';
    opt.title = `${b.name}（${b.itemCount || 0} 个元素）`;
    boardSelect.appendChild(opt);
  }
  if (SERVER.cur) boardSelect.value = SERVER.cur;
}

async function ensureToken() {
  const t = await askDialog({
    title: '需要访问口令',
    message: '这台服务器开启了访问口令，请输入（只会存在本机浏览器里）。',
    value: SERVER.token || '',
    placeholder: '口令',
    okText: '连接',
  });
  if (!t) { setState('未连接', 'error'); return false; }
  SERVER.token = t;
  try { localStorage.setItem('pdfboard.token', t); } catch { /* ignore */ }
  return true;
}

/* ---------- 打开 / 新建 / 重命名 / 删除 ---------- */
async function openBoard(id, { pushHash = true } = {}) {
  if (!SERVER.on || !id) return;
  await flushSave();
  boardHost.classList.add('is-loading');
  try {
    const res = await apiFetch('/boards/' + encodeURIComponent(id));
    if (res.status === 401) {
      boardHost.classList.remove('is-loading');
      if (await ensureToken()) return openBoard(id, { pushHash });
      return;
    }
    if (!res.ok) { toast('打开白板失败（HTTP ' + res.status + '）'); return; }
    const data = await res.json();
    SERVER.cur = id;
    SERVER.rev = Number(data.rev) || 1;
    board.loadJSON(data.data || { version: 1, view: { x: 0, y: 0, scale: 1 }, items: [] }, { silent: true });
    if (typeof board.markClean === 'function') board.markClean();
    SERVER.dirty = false;
    SERVER.lastSig = docSig();
    if (boardSelect) boardSelect.value = id;
    if (pushHash) {
      try { history.replaceState(null, '', '#b=' + id); } catch { /* ignore */ }
    }
    setState('已保存');
    const name = data.name || (SERVER.boards.find((b) => b.id === id) || {}).name || '';
    document.title = (name ? name + ' · ' : '') + 'PDF 摘录白板';
  } finally {
    boardHost.classList.remove('is-loading');
  }
}

async function createBoard(name) {
  const res = await apiFetch('/boards', { method: 'POST', body: JSON.stringify({ name: name || defaultBoardName() }) });
  if (res.status === 401) { if (await ensureToken()) return createBoard(name); return null; }
  if (!res.ok) { toast('新建白板失败（HTTP ' + res.status + '）'); return null; }
  const { board: b } = await res.json();
  await refreshBoardList();
  await openBoard(b.id);
  toast('已新建白板：' + b.name);
  return b;
}

function defaultBoardName() {
  const n = SERVER.boards.length + 1;
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `白板 ${n}（${p(d.getMonth() + 1)}-${p(d.getDate())}）`;
}

async function renameBoard() {
  if (!SERVER.cur) return;
  const cur = SERVER.boards.find((b) => b.id === SERVER.cur);
  const name = await askDialog({ title: '重命名白板', value: cur ? cur.name : '', okText: '保存' });
  if (name === null) return;
  if (!name) { toast('名字不能为空'); return; }
  const res = await apiFetch('/boards/' + encodeURIComponent(SERVER.cur), { method: 'PATCH', body: JSON.stringify({ name }) });
  if (!res.ok) { toast('重命名失败（HTTP ' + res.status + '）'); return; }
  await refreshBoardList();
  document.title = name + ' · PDF 摘录白板';
  toast('已重命名');
}

async function deleteBoard() {
  if (!SERVER.cur) return;
  const cur = SERVER.boards.find((b) => b.id === SERVER.cur);
  const ok = await askDialog({
    title: '删除白板',
    message: `「${cur ? cur.name : '当前白板'}」里的内容会被永久删除，确定吗？`,
    input: false,
    okText: '删除',
  });
  if (ok !== true) return;
  const res = await apiFetch('/boards/' + encodeURIComponent(SERVER.cur), { method: 'DELETE' });
  if (!res.ok) { toast('删除失败（HTTP ' + res.status + '）'); return; }
  SERVER.cur = null;
  await refreshBoardList();
  if (SERVER.boards.length) await openBoard(SERVER.boards[0].id);
  else await createBoard();
  toast('已删除');
}

/* ---------- 旧版本地白板（IndexedDB / localStorage）一次性迁移 ---------- */
function readLegacyLocalBoard() {
  return new Promise((resolve) => {
    const fromLS = () => {
      try {
        const raw = localStorage.getItem('pdfboard.v1.pending') || localStorage.getItem('pdfboard.v1');
        if (!raw) return null;
        const obj = JSON.parse(raw);
        return obj && Array.isArray(obj.items) ? obj : null;
      } catch { return null; }
    };
    const idb = typeof indexedDB;
    if (!idb) { resolve(fromLS()); return; }
    const go = () => {
      try {
        const req = indexedDB.open('pdfboard');
        req.onerror = () => resolve(fromLS());
        req.onsuccess = () => {
          const db = req.result;
          let done = false;
          const finish = (v) => { if (done) return; done = true; try { db.close(); } catch { /* ignore */ } resolve(v || fromLS()); };
          try {
            if (!db.objectStoreNames.contains('kv')) return finish(null);
            const gr = db.transaction('kv', 'readonly').objectStore('kv').get('main');
            gr.onsuccess = () => finish(gr.result);
            gr.onerror = () => finish(null);
          } catch { finish(null); }
        };
        // 不该发生（我们已确认库存在）
        req.onupgradeneeded = () => { try { req.result.close(); } catch { /* ignore */ } };
      } catch { resolve(fromLS()); }
    };
    // 先确认旧库存在，避免 open() 顺手造一个空库
    if (typeof indexedDB.databases === 'function') {
      indexedDB.databases().then((dbs) => {
        if (Array.isArray(dbs) && dbs.some((d) => d.name === 'pdfboard')) go();
        else resolve(fromLS());
      }).catch(go);
    } else {
      go();
    }
  });
}

async function migrateLocalBoardIfNeeded() {
  const legacy = await readLegacyLocalBoard();
  if (!legacy || !Array.isArray(legacy.items) || !legacy.items.length) return false;
  const res = await apiFetch('/boards', {
    method: 'POST',
    body: JSON.stringify({ name: '本机白板（已迁移）', data: legacy }),
  });
  if (!res.ok) return false;
  await refreshBoardList();
  toast(`已把本机白板（${legacy.items.length} 个元素）迁移到服务器，原数据仍保留在浏览器里`, 5000);
  return true;
}

/* ---------- 保存到服务器 ---------- */
function scheduleSave(delay = SAVE_DEBOUNCE) {
  if (!SERVER.on || !SERVER.cur) return;
  SERVER.dirty = true;
  setState('未保存', 'busy');
  clearTimeout(SERVER.saveTimer);
  SERVER.saveTimer = setTimeout(() => { doSave(); }, delay);
}

async function doSave() {
  clearTimeout(SERVER.saveTimer);
  if (!SERVER.on || !SERVER.cur) return true;
  if (SERVER.saving) { SERVER.pending = true; return false; }
  SERVER.saving = true;
  setState('保存中…', 'busy');
  try {
    const data = board.toJSON();
    const sentSig = docSig(data);
    const res = await apiFetch('/boards/' + encodeURIComponent(SERVER.cur), {
      method: 'PUT',
      body: JSON.stringify({ rev: SERVER.rev, data }),
    });
    if (res.status === 409) {
      const j = await res.json().catch(() => ({}));
      SERVER.rev = Number(j.rev) || SERVER.rev;
      SERVER.saving = false;
      toast('这块板在别处被改过，已用当前内容覆盖');
      return doSave();
    }
    if (res.status === 401) {
      SERVER.saving = false;
      const ok = await ensureToken();
      return ok ? doSave() : false;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    SERVER.rev = Number(j.rev) || SERVER.rev;
    SERVER.dirty = false;
    SERVER.lastSig = sentSig;
    setState('已保存');
    return true;
  } catch (err) {
    setState('保存失败', 'error');
    toast('保存到服务器失败：' + (err?.message || err), 4000);
    SERVER.dirty = true;
    return false;
  } finally {
    SERVER.saving = false;
    if (SERVER.pending) { SERVER.pending = false; scheduleSave(50); }
  }
}

async function flushSave() {
  clearTimeout(SERVER.saveTimer);
  if (!SERVER.on || !SERVER.cur || !SERVER.dirty) return true;
  return doSave();
}

/* 轻量签名：判断"有没有真的改过"，不碰 dataURL，够快（关页时同步调用） */
function docSig(doc) {
  const d = doc || (board ? board.toJSON() : { items: [] });
  const v = d.view || {};
  let s = (d.items || []).length + '|' +
    Math.round(v.x || 0) + ',' + Math.round(v.y || 0) + ',' + Number(v.scale || 1).toFixed(3);
  for (const it of d.items || []) {
    s += '|' + (it.id || '') + ':' + Math.round(it.x || 0) + ',' + Math.round(it.y || 0) + ',' +
      Math.round(it.w || 0) + ',' + Math.round(it.h || 0) + ',' +
      ((it.text || '').length) + ',' + (it.points ? it.points.length : 0) + ',' + (it.z || 0);
  }
  return s;
}

/* 关页前用 sendBeacon 兜底最后一次改动（异步 PUT 可能来不及） */
window.addEventListener('pagehide', () => {
  if (!SERVER.on || !SERVER.cur || !board) return;
  try {
    if (docSig() === SERVER.lastSig) return;         // 没有真改动
    const body = JSON.stringify({ rev: SERVER.rev, data: board.toJSON() });
    const blob = new Blob([body], { type: 'application/json' });
    const url = API_BASE + '/boards/' + encodeURIComponent(SERVER.cur) +
      (SERVER.token ? '?token=' + encodeURIComponent(SERVER.token) : '');
    navigator.sendBeacon(url, blob);
  } catch { /* ignore */ }
});

/* ---------- 通用输入弹窗 ---------- */
function askDialog({ title, message = '', value = '', okText = '确定', input = true, placeholder = '' }) {
  return new Promise((resolve) => {
    const dlg = $('promptDlg');
    const titleEl = $('promptTitle');
    const msgEl = $('promptMsg');
    const inputEl = $('promptInput');
    const okEl = $('promptOk');
    titleEl.textContent = title;
    msgEl.textContent = message;
    msgEl.hidden = !message;
    inputEl.hidden = !input;
    inputEl.value = value;
    inputEl.placeholder = placeholder;
    okEl.textContent = okText;
    dlg.returnValue = '';
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'ok' ? (input ? inputEl.value.trim() : true) : null);
    };
    dlg.addEventListener('close', onClose);
    const onKey = (e) => {
      if (e.key === 'Enter' && input) { e.preventDefault(); dlg.returnValue = 'ok'; dlg.close(); }
    };
    inputEl.onkeydown = onKey;
    dlg.showModal();
    if (input) setTimeout(() => { inputEl.focus(); inputEl.select(); }, 30);
  });
}

/* ---------- 白板栏初始化 ---------- */
function initBoardBar() {
  boardBar.hidden = false;
  boardSelect.addEventListener('change', () => { openBoard(boardSelect.value).catch((e) => toast(String(e))); });
  $('btnNewBoard').addEventListener('click', () => { createBoard().catch((e) => toast(String(e))); });
  $('btnRenameBoard').addEventListener('click', () => { renameBoard().catch((e) => toast(String(e))); });
  $('btnDeleteBoard').addEventListener('click', () => { deleteBoard().catch((e) => toast(String(e))); });
  window.addEventListener('hashchange', () => {
    const id = parseHashId();
    if (id && id !== SERVER.cur) openBoard(id, { pushHash: false }).catch(() => {});
  });
}

function parseHashId() {
  const m = /^#b=([a-z0-9-]{3,40})$/i.exec(location.hash || '');
  return m ? m[1] : null;
}

async function initServer() {
  document.body.classList.add('server-mode');
  initBoardBar();
  const help = $('helpStorage');
  if (help) help.textContent = '白板存在服务器上，任何设备打开都是同一块板';
  try {
    await refreshBoardList();
  } catch (e) {
    toast('读取白板列表失败：' + (e?.message || e), 4000);
    setState('连接失败', 'error');
    return;
  }
  let target = parseHashId();
  if (!target) {
    try { target = localStorage.getItem('pdfboard.lastBoard') || ''; } catch { /* ignore */ }
  }
  if (!target || !SERVER.boards.some((b) => b.id === target)) target = SERVER.boards[0] ? SERVER.boards[0].id : null;
  if (!target) {
    // 服务器上还没有白板：先看浏览器里有没有旧版本存的白板，有就迁移过来
    const migrated = await migrateLocalBoardIfNeeded();
    if (migrated && SERVER.boards.length) {
      await openBoard(SERVER.boards[0].id);
      return;
    }
    await createBoard();
    return;
  }
  await openBoard(target);
  try { localStorage.setItem('pdfboard.lastBoard', SERVER.cur || ''); } catch { /* ignore */ }
}

/* ============================================================
   PDF 打开
   ============================================================ */
function looksLikePdf(file) {
  return !!file && (/\.pdf$/i.test(file.name || '') || file.type === 'application/pdf');
}

async function openPdfFile(file) {
  if (!looksLikePdf(file)) { toast('请选择 PDF 文件'); return; }
  setPdfName(file.name);
  try {
    const ok = await pdf.open(file);
    if (ok === false) setPdfName('');
  } catch (err) {
    console.error(err);
    setPdfName('');
    toast('打开失败：' + (err?.message || err));
  }
}

async function openPdfBuffer(buf, name) {
  setPdfName(name || 'PDF');
  try {
    const ok = await pdf.open(buf);
    if (ok === false) setPdfName('');
  } catch (err) {
    console.error(err);
    toast('打开失败：' + (err?.message || err));
  }
}

function setPdfName(name) {
  pdfNameEl.textContent = name || '未打开文件';
  pdfNameEl.classList.toggle('loaded', !!name);
  if (!name && !SERVER.on) document.title = 'PDF 摘录白板';
}

$('btnOpenPdf').addEventListener('click', () => filePdf.click());
filePdf.addEventListener('change', () => {
  const f = filePdf.files && filePdf.files[0];
  filePdf.value = '';
  if (f) openPdfFile(f);
});

/* ---------------- 拖放打开 ---------------- */
let dragDepth = 0;
function droppedFiles(e) {
  const dt = e.dataTransfer;
  if (!dt) return [];
  return Array.from(dt.files || []);
}
function isImageOnlyDrop(e) {
  const files = droppedFiles(e);
  return files.length > 0 && files.every((f) => /^image\//.test(f.type || ''));
}
function isOverBoard(e) {
  return !!(e.target instanceof Element && e.target.closest('#boardPane'));
}
function hasFiles(e) {
  const dt = e.dataTransfer;
  return !!dt && Array.from(dt.types || []).includes('Files');
}
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  if (isImageOnlyDrop(e) && isOverBoard(e)) return;
  e.preventDefault();
  dragDepth++;
  dropMask.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  if (isImageOnlyDrop(e) && isOverBoard(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget) return;
  dragDepth = 0;
  dropMask.hidden = true;
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  if (isImageOnlyDrop(e) && isOverBoard(e)) { dropMask.hidden = true; dragDepth = 0; return; }
  e.preventDefault();
  dragDepth = 0;
  dropMask.hidden = true;
  const files = droppedFiles(e);
  const pdfFile = files.find(looksLikePdf);
  const jsonFile = files.find((f) => /\.json$/i.test(f.name));
  if (pdfFile) openPdfFile(pdfFile);
  else if (jsonFile) loadBoardFile(jsonFile);
  else toast('只能打开 .pdf 或 .json（图片请拖到右侧白板）');
});

/* ---------------- 白板导出 / 导入（json 备份） ---------------- */
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

$('btnSaveBoard').addEventListener('click', () => {
  try {
    const data = board ? board.toJSON() : { version: 1, view: { x: 0, y: 0, scale: 1 }, items: [] };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `白板-${stamp()}.json`);
    toast('已保存白板文件');
  } catch (err) {
    console.error(err);
    toast('保存失败：' + (err?.message || err));
  }
});

$('btnOpenBoard').addEventListener('click', () => fileBoard.click());
fileBoard.addEventListener('change', () => {
  const f = fileBoard.files && fileBoard.files[0];
  fileBoard.value = '';
  if (f) loadBoardFile(f);
});

async function loadBoardFile(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!board) { toast('白板尚未就绪'); return; }
    board.loadJSON(data, { silent: SERVER.on });   // 本机模式要写回 IndexedDB
    toast('已读取白板文件');
    if (SERVER.on) scheduleSave(200);
  } catch (err) {
    console.error(err);
    toast('读取失败：不是有效的白板文件');
  }
}

/* ---------------- 导出：PNG / PDF ---------------- */
const exportMenu = $('exportMenu');
const btnExport = $('btnExport');

function closeExportMenu() {
  if (!exportMenu || exportMenu.hidden) return;
  exportMenu.hidden = true;
  btnExport?.setAttribute('aria-expanded', 'false');
}
function openExportMenu() {
  if (!exportMenu) return;
  // A4 页面模式下导出语义不同：PNG 只导当前页，PDF 按纸张逐页输出
  const pg = isPageMode();
  const pngBtn = $('btnExportPng');
  const pdfBtn = $('btnExportPdf');
  if (pngBtn) pngBtn.textContent = pg ? '导出为 PNG（当前 A4 页）' : '导出为 PNG 图片';
  if (pdfBtn) pdfBtn.textContent = pg ? '导出为 PDF（按 A4 页输出）' : '导出为 PDF（A4 分页）';
  exportMenu.hidden = false;
  btnExport?.setAttribute('aria-expanded', 'true');
}
if (btnExport && exportMenu) {
  btnExport.addEventListener('click', (e) => {
    e.stopPropagation();
    if (exportMenu.hidden) openExportMenu(); else closeExportMenu();
  });
  document.addEventListener('pointerdown', (e) => {
    if (exportMenu.hidden) return;
    if (!(e.target instanceof Element) || !e.target.closest('#tbExport')) closeExportMenu();
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeExportMenu(); });
}

/* ---- A4 页面模式：按页导出辅助 ---- */
function isPageMode() {
  return !!(board && typeof board.getPageMode === 'function' && board.getPageMode() === 'a4');
}
function pageRectsSafe() {
  try {
    const r = board && typeof board.pageRects === 'function' ? board.pageRects() : null;
    return Array.isArray(r) && r.length ? r : null;
  } catch { return null; }
}
function currentPageIndex(rectCount) {
  const d = board && typeof board.toJSON === 'function' ? board.toJSON() : null;
  const i = Math.floor(Number(d && d.curPage));
  const n = rectCount || 1;
  return Math.min(Math.max(Number.isFinite(i) ? i : 0, 0), n - 1);
}

async function exportPagePNG() {
  const rects = pageRectsSafe();
  if (!rects) return false;
  const idx = currentPageIndex(rects.length);
  const src = await board.renderToCanvas({ rect: rects[idx], scale: 2, background: '#ffffff' });
  if (!src || !src.width) { toast('渲染当前页失败'); return false; }
  const blob = await new Promise((resolve) => src.toBlob(resolve, 'image/png'));
  if (!blob) { toast('PNG 编码失败'); return false; }
  downloadBlob(blob, `白板-第${idx + 1}页-${stamp()}.png`);
  toast(`已导出第 ${idx + 1} 页（A4，${src.width}×${src.height}）`, 2600);
  return true;
}

function pageOrientation() {
  try {
    return board && typeof board.getPageOrientation === 'function' && board.getPageOrientation() === 'landscape'
      ? 'landscape'
      : 'portrait';
  } catch { return 'portrait'; }
}

async function exportPagesPDF() {
  const rects = pageRectsSafe();
  if (!rects) return false;
  // 横向 A4：宽高互换（841.89 × 595.28 pt）
  const landscape = pageOrientation() === 'landscape';
  const pageW = landscape ? A4_PORTRAIT.h : A4_PORTRAIT.w;
  const pageH = landscape ? A4_PORTRAIT.w : A4_PORTRAIT.h;
  const pages = [];
  for (const r of rects) {
    const c = await board.renderToCanvas({ rect: r, scale: 2, background: '#ffffff' });
    if (!c || !c.width) continue;
    const jpeg = await canvasToJpegBytes(c, 0.92);
    // 纸张与 PDF 页面同比例（794:1123 ≈ 595.28:841.89），整页铺满，所见即所得
    pages.push({ jpeg, pxW: c.width, pxH: c.height, drawW: pageW, drawH: pageH, drawX: 0, drawY: 0 });
  }
  if (!pages.length) { toast('没有可导出的页面'); return false; }
  const bytes = buildPdf({ pages, pageW, pageH });
  downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `白板-${stamp()}.pdf`);
  toast(`已导出 PDF（${pages.length} 页 A4${landscape ? ' 横向' : ''}，按页面排版 1:1 输出）`, 3000);
  return true;
}

$('btnExportPng').addEventListener('click', async () => {
  closeExportMenu();
  if (!board) return;
  try {
    const ok = isPageMode() ? await exportPagePNG() : await board.exportPNG();
    if (ok !== false && !isPageMode()) toast('已导出 PNG');
  } catch (err) {
    console.error(err);
    toast('导出失败：' + (err?.message || err));
  }
});

/* ---- 极简 PDF 生成器：白板画布 → 分页 JPEG → PDF（无第三方依赖） ---- */
const A4_PORTRAIT = { w: 595.28, h: 841.89 };
const PDF_MARGIN = 20;      // pt
const PDF_CUT_WINDOW = 120; // 找空白行切页时向上搜索的像素范围

function canvasToJpegBytes(canvas, quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) { reject(new Error('JPEG 编码失败')); return; }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/jpeg', quality);
  });
}

/* 在一段横向像素带里从下往上找"全白行"，用作分页切点 */
function findBlankRow(ctx, w, yStart, bandH) {
  let band;
  try { band = ctx.getImageData(0, yStart, w, bandH); } catch { return -1; }
  const d = band.data;
  for (let ry = bandH - 1; ry >= 0; ry--) {
    let acc = 0, blank = true;
    for (let x = 0; x < w; x += 4) {
      const i = (ry * w + x) * 4;
      acc += (255 - d[i]) + (255 - d[i + 1]) + (255 - d[i + 2]);
      if (acc > 46) { blank = false; break; }
    }
    if (blank) return yStart + ry;
  }
  return -1;
}

function computeSlices(src, maxSliceH) {
  const w = src.width, h = src.height;
  if (h <= maxSliceH) return [{ y0: 0, y1: h }];
  const ctx = src.getContext('2d');
  const slices = [];
  let y = 0, guard = 0;
  while (y < h && guard++ < 400) {
    let end = Math.min(h, y + maxSliceH);
    if (end < h) {
      const from = Math.max(y + Math.floor(maxSliceH * 0.5), end - PDF_CUT_WINDOW);
      if (from < end) {
        const cut = findBlankRow(ctx, w, from, end - from);
        if (cut > y + 20) end = cut;
      }
    }
    if (end <= y) end = Math.min(h, y + maxSliceH);
    slices.push({ y0: y, y1: end });
    y = end;
  }
  return slices;
}

/* 判断一条横向像素带是否全白（用于丢弃空白尾页） */
function bandIsWhite(ctx, w, y0, h) {
  let band;
  try { band = ctx.getImageData(0, y0, w, Math.max(1, h)); } catch { return false; }
  const d = band.data;
  const rows = band.height;
  for (let y = 0; y < rows; y += 2) {
    let acc = 0;
    for (let x = 0; x < w; x += 4) {
      const i = (y * w + x) * 4;
      acc += (255 - d[i]) + (255 - d[i + 1]) + (255 - d[i + 2]);
      if (acc > 46) return false;
    }
  }
  return true;
}

function buildPdf({ pages, pageW, pageH }) {
  const enc = new TextEncoder();
  const parts = [];
  let size = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    parts.push(bytes);
    size += bytes.length;
    return size;
  };
  const offsets = [];
  const startObj = () => { offsets.push(size); };

  const n = pages.length;
  const objCount = 2 + n * 3;

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));  // 二进制标记行

  startObj(); push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  startObj(); push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);

  pages.forEach((pg, i) => {
    const pageObj = 3 + i * 3;
    const contentObj = pageObj + 1;
    const imgObj = pageObj + 2;
    startObj();
    push(`${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] ` +
      `/Resources << /XObject << /Im0 ${imgObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`);
    const content = `q\n${pg.drawW.toFixed(2)} 0 0 ${pg.drawH.toFixed(2)} ${pg.drawX.toFixed(2)} ${pg.drawY.toFixed(2)} cm\n/Im0 Do\nQ\n`;
    startObj();
    push(`${contentObj} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
    startObj();
    push(`${imgObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pg.pxW} /Height ${pg.pxH} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.jpeg.length} >>\nstream\n`);
    push(pg.jpeg);
    push('\nendstream\nendobj\n');
  });

  const xrefOffset = size;
  let xref = `xref\n0 ${objCount + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objCount; i++) xref += String(offsets[i - 1]).padStart(10, '0') + ' 00000 n \n';
  push(xref);
  push(`trailer\n<< /Size ${objCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const out = new Uint8Array(size);
  let p = 0;
  for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
}

async function exportPDF() {
  if (!board) return false;
  if (typeof board.renderToCanvas !== 'function') {
    toast('白板模块版本较旧，暂不支持 PDF 导出');
    return false;
  }
  // A4 页面模式：一张纸 = 一页 PDF，1:1 输出，不再自动切页
  if (isPageMode()) {
    if (!pageRectsSafe()) { toast('页面信息不可用'); return false; }
    toast('正在生成 PDF…', 1200);
    return exportPagesPDF();
  }
  if (!(board.toJSON().items || []).length) { toast('白板还是空的，先贴点内容'); return false; }
  toast('正在生成 PDF…', 1200);
  const src = await board.renderToCanvas({ scale: 2 });
  if (!src || !src.width) { toast('渲染白板失败'); return false; }

  const landscape = src.width > src.height;
  const pageW = landscape ? A4_PORTRAIT.h : A4_PORTRAIT.w;
  const pageH = landscape ? A4_PORTRAIT.w : A4_PORTRAIT.h;
  const availW = pageW - PDF_MARGIN * 2;
  const availH = pageH - PDF_MARGIN * 2;
  let ptPerPx = availW / src.width;
  let maxSliceH = Math.max(40, Math.floor(availH / ptPerPx));

  // 如果只超出一丁点，就把内容稍微缩小塞进更少的页，避免出现一条几乎空白的尾页
  if (src.height > maxSliceH) {
    const nRaw = Math.ceil(src.height / maxSliceH);
    const lastH = src.height - (nRaw - 1) * maxSliceH;
    if (nRaw > 1 && lastH < maxSliceH * 0.22) {
      const wanted = nRaw - 1;
      ptPerPx = Math.min(availW / src.width, (availH * wanted) / src.height);
      maxSliceH = Math.max(40, Math.floor(availH / ptPerPx));
    }
  }

  const srcCtx = src.getContext('2d');
  const slices = computeSlices(src, maxSliceH);
  // 丢掉末尾的空白切片（渲染自带留白，容易多出一张白页）
  while (slices.length > 1) {
    const last = slices[slices.length - 1];
    if (bandIsWhite(srcCtx, src.width, last.y0, last.y1 - last.y0)) slices.pop();
    else break;
  }
  const pages = [];
  for (const s of slices) {
    const sh = Math.max(1, s.y1 - s.y0);
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = sh;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, s.y0, src.width, sh, 0, 0, src.width, sh);
    const jpeg = await canvasToJpegBytes(c, 0.92);
    const drawW = c.width * ptPerPx;
    const drawH = sh * ptPerPx;
    pages.push({
      jpeg,
      pxW: c.width,
      pxH: sh,
      drawW,
      drawH,
      drawX: PDF_MARGIN + (availW - drawW) / 2,
      drawY: pageH - PDF_MARGIN - drawH,
    });
  }
  const bytes = buildPdf({ pages, pageW, pageH });
  downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `白板-${stamp()}.pdf`);
  toast(`已导出 PDF（${pages.length} 页，A4${landscape ? ' 横向' : ''}）`, 3000);
  return true;
}

$('btnExportPdf').addEventListener('click', async () => {
  closeExportMenu();
  try {
    await exportPDF();
  } catch (err) {
    console.error(err);
    toast('导出 PDF 失败：' + (err?.message || err), 4000);
  }
});

/* ---------------- 帮助 ---------------- */
$('btnHelp').addEventListener('click', () => helpDlg.showModal());
$('btnHelpClose').addEventListener('click', () => helpDlg.close());
helpDlg.addEventListener('click', (e) => {
  const r = helpDlg.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) helpDlg.close();
});

/* ---------------- 分栏拖拽 ---------------- */
const SPLIT_KEY = 'pdfboard.split';
(function initSplit() {
  const saved = parseFloat(localStorage.getItem(SPLIT_KEY) || '');
  if (saved > 0.1 && saved < 0.95) splitEl.style.setProperty('--pdf-w', (saved * 100).toFixed(2) + '%');
  const gutter = $('gutter');
  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const r = splitEl.getBoundingClientRect();
    let pct = (e.clientX - r.left) / r.width;
    pct = Math.min(0.86, Math.max(0.2, pct));
    splitEl.style.setProperty('--pdf-w', (pct * 100).toFixed(2) + '%');
    e.preventDefault();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    gutter.classList.remove('dragging');
    document.body.style.cursor = '';
    const v = parseFloat(splitEl.style.getPropertyValue('--pdf-w')) / 100;
    if (v) localStorage.setItem(SPLIT_KEY, String(v));
    window.dispatchEvent(new Event('resize'));
  };
  gutter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    gutter.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    gutter.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  gutter.addEventListener('dblclick', () => {
    splitEl.style.setProperty('--pdf-w', '50%');
    localStorage.setItem(SPLIT_KEY, '0.5');
    window.dispatchEvent(new Event('resize'));
  });
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
})();

/* ---------------- 全局快捷键 ---------------- */
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault();
    filePdf.click();
    return;
  }
  if (mod && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    $('btnSaveBoard').click();
  }
});

/* ---------------- 启动 ---------------- */
(async function boot() {
  const isServer = await detectServer();
  if (isServer) {
    readTokenFromUrl();
    document.body.classList.add('server-mode');
  }
  if (isServer && SERVER.on) {
    // 有后端：白板由服务器托管，Board 自己不做持久化
    boardHost.classList.add('is-loading');   // 加载完之前挡住交互，避免刚贴的内容被随后的加载覆盖
    board = new Board(boardHost, {
      toast,
      getFallbackClip: () => appClip,
      persistence: 'off',
      onChange: () => scheduleSave(),
    });
    try {
      await initServer();
    } catch (err) {
      console.error(err);
      toast('连接服务器失败：' + (err?.message || err), 4000);
    } finally {
      boardHost.classList.remove('is-loading');
    }
  } else {
    // 本机模式：保持原有 IndexedDB 自动保存
    board = new Board(boardHost, {
      toast,
      getFallbackClip: () => appClip,
    });
    const help = $('helpStorage');
    if (help) help.textContent = '白板自动存在本机浏览器里（IndexedDB），刷新不丢';
  }

  // 命令行/容器带 PDF 启动
  const boot = window.__BOOT_PDF;
  if (boot) {
    try {
      const res = await fetch(boot);
      if (res.ok) await openPdfBuffer(await res.arrayBuffer(), decodeURIComponent(boot.split('/').pop()));
      else toast('无法读取启动 PDF');
    } catch (err) {
      console.error(err);
      toast('无法读取启动 PDF');
    }
  }

  // 离开前尽量把改动落盘
  window.addEventListener('beforeunload', () => { if (SERVER.dirty) flushSave(); });
})();

/* ---------------- 调试出口（自动化验收用） ---------------- */
window.dsh = {
  pdf,
  get board() { return board; },
  toast,
  server: SERVER,
  getClip: () => appClip,
  openPdfBuffer,
  sendToBoard,
  openBoard,
  createBoard,
  refreshBoardList,
  flushSave,
};
