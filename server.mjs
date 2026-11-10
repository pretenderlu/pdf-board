/* ============================================================
   server.mjs — 静态服务器 + 白板存储 API
   ------------------------------------------------------------
   本机用法：
     node server.mjs                 （默认 127.0.0.1:7420，自动打开浏览器 app 窗口）
     node server.mjs 试卷.pdf         （启动后自动打开该 PDF）
   容器/服务器用法：
     PDFBOARD_HOST=0.0.0.0 PDFBOARD_DATA=/data PDFBOARD_NO_OPEN=1 node server.mjs
   环境变量：
     PORT              端口（默认 7420，占用则自动 +1 顺延；容器里建议固定）
     PDFBOARD_HOST     监听地址（默认 127.0.0.1；容器里用 0.0.0.0）
     PDFBOARD_DATA     白板数据目录（默认 ./data）
     PDFBOARD_MAX_MB   单块白板最大体积（默认 200）
     PDFBOARD_TOKEN    访问口令（设置后 /api/* 需要口令，页面通过 ?token= 或请求头 x-board-token 提供）
     PDFBOARD_NO_OPEN  1 = 不自动打开浏览器
   ============================================================ */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.PDFBOARD_HOST || '127.0.0.1';
const BASE_PORT = Number(process.env.PORT || 7420);
const DATA_DIR = path.resolve(process.env.PDFBOARD_DATA || path.join(ROOT, 'data'));
const BOARDS_DIR = path.join(DATA_DIR, 'boards');
const MAX_BODY = Math.max(1, Number(process.env.PDFBOARD_MAX_MB || 200)) * 1024 * 1024;
const TOKEN = String(process.env.PDFBOARD_TOKEN || '').trim();
const NO_OPEN = process.argv.includes('--no-open') || process.env.PDFBOARD_NO_OPEN === '1';

/* ---------- 命令行里的 PDF（本机方便用法） ---------- */
let bootPdf = null;
{
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const pdfArg = args.find((a) => /\.pdf$/i.test(a));
  if (pdfArg) {
    const abs = path.resolve(pdfArg);
    if (fs.existsSync(abs)) {
      bootPdf = { abs, name: path.basename(abs), url: '/__boot/' + encodeURIComponent(path.basename(abs)) };
    } else {
      console.warn('[warn] 找不到 PDF: ' + abs);
    }
  }
}

/* ============================================================
   白板存储（每个白板一个 json + 一个 meta.json）
   ============================================================ */
fs.mkdirSync(BOARDS_DIR, { recursive: true });
const index = new Map();          // id -> meta
const boardPath = (id) => path.join(BOARDS_DIR, id + '.json');
const metaPath = (id) => path.join(BOARDS_DIR, id + '.meta.json');

function nowISO() { return new Date().toISOString(); }
function newId() { return 'b' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'); }
function validId(id) { return typeof id === 'string' && /^[a-z0-9-]{3,40}$/i.test(id); }

function metaOf(b) {
  const data = b.data || {};
  return {
    id: b.id,
    name: b.name || '未命名白板',
    createdAt: b.createdAt || nowISO(),
    updatedAt: b.updatedAt || nowISO(),
    rev: Number(b.rev) || 1,
    itemCount: Array.isArray(data.items) ? data.items.length : 0,
    bytes: 0,
  };
}

async function writeMeta(id, meta) {
  const file = metaPath(id);
  const body = { ...meta, id };
  try {
    body.bytes = (await fsp.stat(boardPath(id))).size;
  } catch { body.bytes = meta.bytes || 0; }
  await fsp.writeFile(file, JSON.stringify(body));
  index.set(id, body);
}

async function writeBoard(board) {
  const id = board.id;
  board.updatedAt = nowISO();
  const tmp = boardPath(id) + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(board));
  await fsp.rename(tmp, boardPath(id));
  await writeMeta(id, metaOf(board));
  return board;
}

async function readBoard(id) {
  try {
    return JSON.parse(await fsp.readFile(boardPath(id), 'utf8'));
  } catch { return null; }
}

async function deleteBoard(id) {
  await fsp.unlink(boardPath(id)).catch(() => {});
  await fsp.unlink(metaPath(id)).catch(() => {});
  index.delete(id);
}

async function loadIndex() {
  const files = await fsp.readdir(BOARDS_DIR).catch(() => []);
  const fullIds = files.filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json')).map((f) => f.slice(0, -5));
  const metaIds = new Set(files.filter((f) => f.endsWith('.meta.json')).map((f) => f.slice(0, -10)));
  for (const id of fullIds) {
    if (!validId(id)) continue;
    if (metaIds.has(id)) {
      try {
        index.set(id, JSON.parse(await fsp.readFile(metaPath(id), 'utf8')));
        continue;
      } catch { /* 坏 meta，回退重建 */ }
    }
    try {
      const b = JSON.parse(await fsp.readFile(boardPath(id), 'utf8'));
      await writeMeta(id, metaOf(b));
    } catch { /* 坏文件，忽略 */ }
  }
  // 清掉没有正文的孤儿 meta
  for (const id of metaIds) if (!fullIds.includes(id)) await fsp.unlink(metaPath(id)).catch(() => {});
  console.log(`  白板存储：${BOARDS_DIR}（${index.size} 块）`);
}

/* ---------- 请求体 ---------- */
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('bad json'), { code: 400 }); }
}

/* ---------- 响应 ---------- */
function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

/* ============================================================
   /api/* 路由
   ============================================================ */
async function handleApi(req, res, urlObj) {
  if (TOKEN) {
    const t = req.headers['x-board-token'] || urlObj.searchParams.get('token') || '';
    if (t !== TOKEN) { json(res, 401, { error: 'unauthorized', tokenRequired: true }); return; }
  }
  const p = urlObj.pathname.replace(/^\/api/, '') || '/';
  const method = req.method || 'GET';

  if (method === 'GET' && p === '/health') {
    json(res, 200, { ok: true, server: true, boards: index.size, tokenRequired: !!TOKEN, maxMB: MAX_BODY / 1024 / 1024 });
    return;
  }

  if (method === 'GET' && p === '/boards') {
    const boards = [...index.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    json(res, 200, { boards });
    return;
  }

  if (method === 'POST' && p === '/boards') {
    const body = await readJson(req);
    const board = {
      id: newId(),
      name: String(body.name || '').trim().slice(0, 80) || '未命名白板',
      createdAt: nowISO(),
      updatedAt: nowISO(),
      rev: 1,
      data: body.data && typeof body.data === 'object' ? body.data : { version: 1, view: { x: 0, y: 0, scale: 1 }, items: [] },
    };
    await writeBoard(board);
    json(res, 201, { board });
    return;
  }

  const m = /^\/boards\/([a-z0-9-]{3,40})(\/rename)?$/i.exec(p);
  if (m) {
    const id = m[1];
    if (!index.has(id) && !fs.existsSync(boardPath(id))) { json(res, 404, { error: 'not found' }); return; }
    if (method === 'GET') {
      const b = await readBoard(id);
      if (!b) { json(res, 404, { error: 'not found' }); return; }
      json(res, 200, b);
      return;
    }
    // 保存：PUT，或用 POST 作为别名（navigator.sendBeacon 只能发 POST，关页兜底用）
    if (method === 'PUT' || (method === 'POST' && !m[2])) {
      const body = await readJson(req);
      const cur = await readBoard(id);
      const curRev = cur ? Number(cur.rev) || 1 : Number(body.rev) || 1;
      if (Number.isFinite(Number(body.rev)) && Number(body.rev) !== curRev) {
        json(res, 409, { error: 'conflict', rev: curRev });
        return;
      }
      const board = {
        id,
        name: String(body.name || (cur && cur.name) || '未命名白板').slice(0, 80),
        createdAt: (cur && cur.createdAt) || nowISO(),
        updatedAt: nowISO(),
        rev: curRev + 1,
        data: body.data && typeof body.data === 'object' ? body.data : (cur && cur.data) || { version: 1, view: { x: 0, y: 0, scale: 1 }, items: [] },
      };
      await writeBoard(board);
      json(res, 200, { ok: true, rev: board.rev, updatedAt: board.updatedAt, bytes: (index.get(id) || {}).bytes });
      return;
    }
    if (method === 'PATCH' || (method === 'POST' && m[2])) {
      const body = await readJson(req);
      const cur = await readBoard(id);
      if (!cur) { json(res, 404, { error: 'not found' }); return; }
      const name = String(body.name || '').trim().slice(0, 80);
      if (!name) { json(res, 400, { error: 'name required' }); return; }
      cur.name = name;
      await writeBoard(cur);
      json(res, 200, { ok: true, name });
      return;
    }
    if (method === 'DELETE') {
      await deleteBoard(id);
      json(res, 200, { ok: true });
      return;
    }
  }

  json(res, 404, { error: 'no such api' });
}

/* ============================================================
   静态文件
   ============================================================ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.bcmap': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

function safeJoin(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const p = path.normalize(path.join(ROOT, decoded));
  if (!p.startsWith(ROOT)) return null;                                  // 目录穿越
  if (p === DATA_DIR || p.startsWith(DATA_DIR + path.sep)) return null;  // 数据目录不外泄
  return p;
}

async function sendFile(res, filePath, { transform } = {}) {
  let stat;
  try { stat = await fsp.stat(filePath); } catch { return false; }
  if (!stat.isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  if (transform && ext === '.html') {
    const buf = Buffer.from(transform(await fsp.readFile(filePath, 'utf8')), 'utf8');
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
    return true;
  }
  res.writeHead(200, {
    'Content-Type': mimeOf(filePath),
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function injectBoot(html) {
  const conf = { server: true, token: TOKEN ? 'required' : '' };
  const tag = `<script>window.__PDFBOARD=${JSON.stringify(conf)};${bootPdf ? `window.__BOOT_PDF=${JSON.stringify(bootPdf.url)};` : ''}</script>`;
  return html.includes('</head>') ? html.replace('</head>', tag + '\n</head>') : tag + html;
}

/* ============================================================
   服务器
   ============================================================ */
const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const urlObj = new URL(url, 'http://' + (req.headers.host || HOST));
  try {
    if (urlObj.pathname === '/__health') {
      json(res, 200, { ok: true, boot: bootPdf ? bootPdf.name : null, boards: index.size });
      return;
    }
    // 支持挂在反向代理子路径下（/pdfboard/api/... 也能命中）
    const apiIdx = urlObj.pathname.indexOf('/api/');
    if (apiIdx >= 0) {
      await handleApi(req, res, { pathname: urlObj.pathname.slice(apiIdx), searchParams: urlObj.searchParams });
      return;
    }
    if (bootPdf && urlObj.pathname.startsWith('/__boot/')) {
      if (await sendFile(res, bootPdf.abs)) return;
      res.writeHead(404); res.end('boot pdf not found'); return;
    }
    const filePath = safeJoin(urlObj.pathname === '/' ? '/index.html' : urlObj.pathname);
    if (!filePath) { res.writeHead(403); res.end('forbidden'); return; }
    if (await sendFile(res, filePath, { transform: injectBoot })) return;
    if (!path.extname(filePath) && await sendFile(res, path.join(filePath, 'index.html'), { transform: injectBoot })) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 ' + url);
  } catch (err) {
    const code = err && err.code === 413 ? 413 : err && err.code === 400 ? 400 : 500;
    if (code === 500) console.error('[500]', url, err);
    try { json(res, code, { error: err.message || 'error' }); } catch { /* ignore */ }
  }
});

function listen(port, tries = 0) {
  return new Promise((resolve, reject) => {
    const onErr = (err) => {
      if (err.code === 'EADDRINUSE' && tries < 25) {
        server.removeListener('error', onErr);
        resolve(listen(port + 1, tries + 1));
      } else reject(err);
    };
    server.once('error', onErr);
    server.listen(port, HOST, () => {
      server.removeListener('error', onErr);
      resolve(port);
    });
  });
}

/* ---------- 本机用：用浏览器 app 模式打开 ---------- */
function findBrowser() {
  const cands = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  return cands.find((p) => p && fs.existsSync(p)) || null;
}

function openBrowser(url) {
  if (process.platform !== 'win32') return 'none';
  const exe = findBrowser();
  try {
    if (exe) {
      spawn(exe, [`--app=${url}`, '--window-size=1680,1040', '--new-window'], { detached: true, stdio: 'ignore' }).unref();
      return 'app';
    }
  } catch { /* fallthrough */ }
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return 'default';
  } catch { return 'none'; }
}

/* ---------- 启动 ---------- */
await loadIndex();
const port = await listen(BASE_PORT);
const shownHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
const url = `http://${shownHost}:${port}/`;
console.log('');
console.log('  PDF 摘录白板已启动');
console.log('  ' + url + (HOST === '0.0.0.0' ? '   (监听 0.0.0.0，局域网可访问)' : ''));
console.log('  白板存储：' + BOARDS_DIR);
if (TOKEN) console.log('  已启用访问口令：请在地址后加 ?token=你的口令');
if (bootPdf) console.log('  启动文件: ' + bootPdf.name);
if (!NO_OPEN) {
  const how = openBrowser(url);
  if (how === 'none') console.log('  请手动在浏览器打开上面的地址。');
}
console.log('');
console.log('  关闭这个窗口即可退出。');
console.log('');

process.on('SIGINT', () => { console.log('\n已退出'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n已退出'); process.exit(0); });
