/* ============================================================
   board.js — 无限白板引擎（board-engine）
   ------------------------------------------------------------
   纯 ES module + 原生 DOM / Canvas，无框架、无构建、无外链。

   坐标约定：
     screen = world * scale + translate      （translate 即 view.x / view.y）
     world  = (screen - translate) / scale

   图层（由下到上）：
     .bp-grid   canvas  点阵网格
     .bp-ink    canvas  画笔 / 荧光笔笔画
     .bp-items  div     图片 / 文字（用 CSS transform 承载世界坐标）
     .bp-ui     div     选中框、四角手柄、框选虚线框
     .bp-empty  div     空板提示
     .bp-toolbar/.bp-selbar  悬浮工具条

   设计要点：
     - 图片与文字用 <img> / 文本节点 + 容器 transform 渲染（矢量文字始终清晰、
       缩放走 GPU 合成）；笔画逐帧重绘 canvas，线宽随缩放变大。
     - 选中框与手柄画在「屏幕坐标层」，大小恒定，不随缩放变粗变大。
     - 撤销用快照栈：只克隆元素外壳、points 深拷贝，dataURL 字符串按引用共享，
       80 步也不会把内存撑爆。
   ============================================================ */

/* ============================ 常量 ============================ */
const STORAGE_KEY = 'pdfboard.v1';
const MAX_HISTORY = 80;              // 撤销步数上限（要求 ≥ 50）
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const GRID_BASE = 24;                // 网格基准间距（世界坐标）
const SAVE_DELAY = 500;              // 自动保存防抖
const ARRANGE_GAP = 24;              // 排列统一间距（世界像素）
const ARRANGE_ROW_TOL = 14;          // 阅读顺序判定「同一行」的 y 容差（约半行高）
// 思维导图连线（connector：派生笔画，端点随元素现算，不存坐标）
const CONNECTOR_COLOR = '#9aa4b2';   // 灰色细曲线
const CONNECTOR_WIDTH = 2;
const CONNECTOR_MARGIN = 6;          // 端点裁到元素边框外 6px
// A4 页面模式：纸张只是画在无限画布上的参考格（世界坐标不变）
const A4_PAGE_W = 794;               // 96dpi 下 A4 = 210×297mm
const A4_PAGE_H = 1123;
const A4_PAGE_GAP = 48;              // 页间距（世界像素）
const MAX_PAGES = 20;                // 最多 20 页
const TEXT_COLOR = '#1f2329';
const MAX_TEXT_WIDTH = 460;          // 文字元素自动排版的最大宽度（世界坐标）
const MIN_TEXT_WIDTH = 40;
// 色板：画笔 / 荧光笔共用（键盘 1-6 对应顺序）
const PALETTE_COLORS = ['#e5484d', '#1f2329', '#2f6df6', '#18a058', '#f2711c', '#8b5cf6'];
const DEFAULT_PEN_COLOR = '#e5484d';       // 画笔默认红
const DEFAULT_HL_COLOR = '#f5c000';        // 荧光笔默认黄（不在 6 色板里，是荧光笔初始色）
const PEN_COLOR = DEFAULT_PEN_COLOR;       // 兜底（旧数据没有颜色时）
const HIGHLIGHT_COLOR = DEFAULT_HL_COLOR;
const HIGHLIGHT_OPACITY = 0.34;            // 荧光笔半透明
const COLOR_KEY_PEN = 'pdfboard.penColor';
const COLOR_KEY_HL = 'pdfboard.highlighterColor';
const FONT_STACK = '"Segoe UI","Microsoft YaHei UI","Microsoft YaHei",system-ui,-apple-system,sans-serif';
const STORAGE_WARN = '白板内容过大，自动保存失败，请用「保存白板」导出';
const TAU = Math.PI * 2;

/* ======================= 纯函数工具（可单测） ======================= */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function finite(v, d = 0) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 两个世界坐标矩形是否相交（框选用，接触即算命中） */
export function rectsIntersect(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function pointInRect(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** 笔画包围盒：点集范围 + 线宽一半（留 1px 余量） */
export function strokeBBox(points, width = 2) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  const pad = Math.max(0.5, finite(width, 2) / 2) + 1;
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}

/** 点到线段距离（橡皮命中判定） */
export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 1e-9) t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  const cx = ax + dx * t, cy = ay + dy * t;
  return Math.hypot(px - cx, py - cy);
}

/**
 * 按可用宽度折行 —— 复刻文字元素的 CSS 折行行为：
 *   white-space: pre-wrap + overflow-wrap: anywhere + word-break: break-word
 * 规则：显式换行优先；一行内优先在空格处断开；单个超长片段再逐字符断开
 *（CJK 没有空格，等价于逐字折行）。
 * @param {(s:string)=>number} measure 文本宽度测量函数
 * @param {string} text 原始文本
 * @param {number} maxWidth 行宽（世界坐标）
 * @returns {string[]} 行数组（保留显式空行）
 */
export function wrapLines(measure, text, maxWidth) {
  const out = [];
  const limit = Math.max(1, finite(maxWidth, 1));
  const width = (s) => (s ? measure(s) : 0);
  const paras = String(text == null ? '' : text).split('\n');

  for (const para of paras) {
    if (para === '') { out.push(''); continue; }

    // 切成「非空格串 + 尾随空格」的块，让换行优先落在空格处
    const tokens = [];
    let i = 0;
    while (i < para.length) {
      const start = i;
      while (i < para.length && para[i] !== ' ' && para[i] !== '\t') i++;
      while (i < para.length && (para[i] === ' ' || para[i] === '\t')) i++;
      if (i > start) tokens.push(para.slice(start, i));
      else i += 1;                                  // 防御：理论上不会走到
    }

    let line = '';
    const breakLongToken = (tok) => {
      for (const ch of tok) {
        if (line && width(line + ch) > limit) {
          out.push(line);
          // 换行点上的空格被吞掉（和 CSS 里行尾空格的处理一致）
          line = ch === ' ' || ch === '\t' ? '' : ch;
        } else {
          line += ch;
        }
      }
    };

    for (const tok of tokens) {
      if (!line) {
        if (width(tok) <= limit) line = tok;
        else breakLongToken(tok);
        continue;
      }
      if (width(line + tok) <= limit) {
        line += tok;
        continue;
      }
      out.push(line);                               // 放不下 → 收尾当前行
      line = '';
      if (width(tok) <= limit) line = tok;
      else breakLongToken(tok);
    }
    out.push(line);
  }
  return out;
}

/* ======================= 数据清洗（可单测） ======================= */

let _seq = 0;
function uid(prefix = 'i') {
  _seq += 1;
  return prefix + _seq.toString(36) + Math.random().toString(36).slice(2, 7);
}

function strId(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : uid();
}

function colorOr(v, fallback) {
  if (typeof v !== 'string') return fallback;
  const s = v.trim();
  if (!s || s.length > 40) return fallback;
  // 允许 #hex / rgb() / rgba() / hsl() / 常见颜色名
  return /^[#a-zA-Z0-9(),.\s%+-]+$/.test(s) ? s : fallback;
}

function sanitizeItem(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const z = finite(raw.z, index + 1);
  const type = raw.type;

  if (type === 'image') {
    const src = typeof raw.src === 'string' ? raw.src : '';
    if (!src) return null;
    const w = finite(raw.w, 0);
    const h = finite(raw.h, 0);
    if (!(w > 0) || !(h > 0)) return null;
    const pageNum = Number(raw.page);
    return {
      id: strId(raw.id),
      type: 'image',
      x: finite(raw.x, 0),
      y: finite(raw.y, 0),
      w: clamp(w, 1, 20000),
      h: clamp(h, 1, 20000),
      z,
      src,
      page: Number.isFinite(pageNum) && pageNum > 0 ? Math.round(pageNum) : undefined,
      naturalW: finite(raw.naturalW, w),
      naturalH: finite(raw.naturalH, h),
    };
  }

  if (type === 'text') {
    const w = finite(raw.w, 300);
    return {
      id: strId(raw.id),
      type: 'text',
      x: finite(raw.x, 0),
      y: finite(raw.y, 0),
      w: clamp(w, 20, 8000),
      h: clamp(finite(raw.h, 27), 10, 8000),
      z,
      text: typeof raw.text === 'string' ? raw.text.slice(0, 20000) : '',
      fontSize: clamp(finite(raw.fontSize, 18), 6, 400),
      color: colorOr(raw.color, TEXT_COLOR),
    };
  }

  if (type === 'stroke') {
    // 思维导图连线：端点由 fromId/toId 现算，不存 points/bbox
    if (raw.kind === 'connector') {
      const fromId = typeof raw.fromId === 'string' ? raw.fromId : '';
      const toId = typeof raw.toId === 'string' ? raw.toId : '';
      if (!fromId || !toId || fromId === toId) return null;
      return {
        id: strId(raw.id),
        type: 'stroke',
        kind: 'connector',
        z,
        fromId,
        toId,
        color: colorOr(raw.color, CONNECTOR_COLOR),
        width: clamp(finite(raw.width, CONNECTOR_WIDTH), 0.5, 40),
        opacity: clamp(finite(raw.opacity, 1), 0.02, 1),
        tool: 'connector',
      };
    }
    const pts = Array.isArray(raw.points) ? raw.points : [];
    const points = [];
    for (const p of pts) {
      if (!p || typeof p !== 'object') continue;
      const x = finite(p.x, NaN), y = finite(p.y, NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      points.push({ x, y });
      if (points.length >= 8000) break;      // 单笔点数上限，防坏数据卡死
    }
    if (!points.length) return null;
    const width = clamp(finite(raw.width, 2.6), 0.5, 200);
    return {
      id: strId(raw.id),
      type: 'stroke',
      z,
      points,
      color: colorOr(raw.color, PEN_COLOR),
      width,
      opacity: clamp(finite(raw.opacity, 1), 0.03, 1),
      tool: raw.tool === 'highlighter' ? 'highlighter' : 'pen',
      // 归属父元素（图片/文字）：旧存档没有该字段 → null
      parentId: typeof raw.parentId === 'string' && raw.parentId ? raw.parentId : null,
      // 包围盒一律由点集重算，不信任存档里的旧值
      bbox: strokeBBox(points, width),
    };
  }

  return null;
}

/**
 * 把任意来源（localStorage / .json 文件 / 坏数据）洗成合法的白板数据。
 * 永不抛错；非法元素直接丢弃。
 */
export function sanitizeData(raw) {
  const src = Array.isArray(raw) ? { items: raw } : (raw && typeof raw === 'object' ? raw : {});
  const rawItems = Array.isArray(src.items) ? src.items : [];
  const items = [];
  const ids = new Set();
  const limit = Math.min(rawItems.length, 4000);
  for (let i = 0; i < limit; i++) {
    let it = null;
    try { it = sanitizeItem(rawItems[i], i); } catch { it = null; }
    if (!it) continue;
    if (ids.has(it.id)) it.id = uid();
    ids.add(it.id);
    items.push(it);
  }
  const v = src.view && typeof src.view === 'object' ? src.view : null;
  const view = {
    x: v ? finite(v.x, 0) : 0,
    y: v ? finite(v.y, 0) : 0,
    scale: clamp(v ? finite(v.scale, 1) : 1, MIN_SCALE, MAX_SCALE),
  };
  // 父元素不存在（被删/坏数据）时把 parentId 清空，避免"幽灵绑定"
  const byId = new Map(items.map((it) => [it.id, it]));
  for (const it of items) {
    if (it.type !== 'stroke' || !it.parentId) continue;
    const parent = byId.get(it.parentId);
    if (!parent || parent.type === 'stroke') it.parentId = null;
  }
  // 连线：两端必须都是存在的元素（图片/文字），否则丢弃（悬空自愈）
  const elemIds = new Set(items.filter((it) => it.type !== 'stroke').map((it) => it.id));
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'connector') continue;
    if (!elemIds.has(it.fromId) || !elemIds.has(it.toId)) items.splice(i, 1);
  }
  // A4 页面模式（旧数据缺字段 → infinite / 1 页 / 第 0 页）
  const pageMode = src.pageMode === 'a4' ? 'a4' : 'infinite';
  const pageCount = clamp(Math.round(finite(src.pageCount, 1)), 1, MAX_PAGES);
  const curPage = clamp(Math.round(finite(src.curPage, 0)), 0, pageCount - 1);
  return { version: 1, view, items, pageMode, pageCount, curPage };
}

/* ======================= 小工具 ======================= */

function ce(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function svgIcon(inner) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
}

const ICON = {
  select: '<path d="M5.5 3.2l13.2 8-5.9 1.1-2.3 5.9z"/>',
  pen: '<path d="M4 20l3.8-.9L19.2 7.7a2 2 0 0 0 0-2.8l-.7-.7a2 2 0 0 0-2.8 0L5 15.6z"/><path d="M14.6 6.4l3 3"/>',
  highlighter: '<path d="M12.3 10.5l6-6 2.9 2.9-6 6z"/><path d="M10.7 12.1L7 15.8l1.4 1.4 3.7-3.7"/><path d="M6.4 17.6L5 19l1.8.9 1.3-1.3"/><path d="M8.5 21h10"/>',
  eraser: '<path d="M4 19.5h16"/><path d="M15.4 4.2l4.4 4.4a1.5 1.5 0 0 1 0 2.1l-6.6 6.6a2.2 2.2 0 0 1-3.1 0l-2.3-2.3a2.2 2.2 0 0 1 0-3.1l5.5-5.5a1.5 1.5 0 0 1 2.1 0z"/>',
  text: '<path d="M5 6h14"/><path d="M12 6v13"/><path d="M9 19h6"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  fit: '<path d="M4 9V5.6A1.6 1.6 0 0 1 5.6 4H9"/><path d="M15 4h3.4A1.6 1.6 0 0 1 20 5.6V9"/><path d="M20 15v3.4a1.6 1.6 0 0 1-1.6 1.6H15"/><path d="M9 20H5.6A1.6 1.6 0 0 1 4 18.4V15"/>',
  arrange: '<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h13"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V5.3A1.3 1.3 0 0 1 10.8 4h2.4a1.3 1.3 0 0 1 1.3 1.3V7"/><path d="M6.8 7l.8 11.2A1.9 1.9 0 0 0 9.5 20h5a1.9 1.9 0 0 0 1.9-1.8L17.2 7"/>',
  toFront: '<path d="M12 20V8"/><path d="M8 12l4-4 4 4"/><path d="M4.5 4.5h15"/>',
  toBack: '<path d="M12 4v12"/><path d="M8 12l4 4 4-4"/><path d="M4.5 19.5h15"/>',
};

/** 元素快照克隆：points 深拷贝，src / text 字符串共享引用（省内存） */
function cloneItem(it) {
  if (it.kind === 'connector') {
    // 连线不存坐标：端点由 fromId/toId 在渲染时现算，克隆只需浅拷贝
    return { ...it };
  }
  if (it.type === 'stroke') {
    return {
      ...it,
      points: it.points.map((p) => ({ x: p.x, y: p.y })),
      bbox: { x: it.bbox.x, y: it.bbox.y, w: it.bbox.w, h: it.bbox.h },
    };
  }
  const copy = { ...it };
  delete copy._fitOnLoad;      // 内部标记不进入历史快照 / 存档
  return copy;
}

function normalizeText(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\s\u3000]+$/, '')      // 去掉尾随空白与空行
    .slice(0, 20000);
}

function stampName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `白板-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.png`;
}

/* ==================== IndexedDB 持久化（主存储） ====================
   库 pdfboard / 对象仓库 kv / 固定键 'main'，值就是 toJSON() 的对象。
   IndexedDB 容量按磁盘配额（远大于 localStorage 的 5MB），贴几十张
   高清截图也没问题；只有 IDB 不可用或写失败时才退回 localStorage。
   ================================================================== */
const IDB_NAME = 'pdfboard';
const IDB_STORE = 'kv';
const IDB_KEY = 'main';
const IDB_VERSION = 1;
// 关闭页面时如果还有没落盘的改动，写一份同步快照（崩溃/秒刷新时兜底）
const STORAGE_PENDING_KEY = 'pdfboard.v1.pending';

function idbOpen() {
  return new Promise((resolve, reject) => {
    let factory = null;
    try { factory = globalThis.indexedDB; } catch { factory = null; }
    if (!factory || typeof factory.open !== 'function') {
      reject(new Error('idb-unavailable'));
      return;
    }
    let req;
    try {
      req = factory.open(IDB_NAME, IDB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    if (!req || typeof req !== 'object') {
      reject(new Error('idb-bad-request'));
      return;
    }
    req.onupgradeneeded = () => {
      try {
        const db = req.result;
        if (db && !db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      } catch { /* 交给 onerror */ }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('idb-open'));
    req.onblocked = () => reject(new Error('idb-blocked'));
  });
}

function idbGet(db) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(IDB_STORE, 'readonly');
    } catch (err) {
      reject(err);
      return;
    }
    let req;
    try {
      req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    } catch (err) {
      reject(err);
      return;
    }
    req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
    req.onerror = () => reject(req.error || new Error('idb-get'));
  });
}

function idbPut(db, value) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(IDB_STORE, 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('idb-put'));
    tx.onabort = () => reject(tx.error || new Error('idb-abort'));
    try {
      tx.objectStore(IDB_STORE).put(value, IDB_KEY);
    } catch (err) {
      reject(err);
    }
  });
}

/* ============================ Board ============================ */

export class Board {
  /**
   * @param {HTMLElement} host 挂载点（#boardPane）
   * @param {{
   *   getFallbackClip?:()=>any,
   *   toast?:(msg:string, ms?:number)=>void,
   *   persistence?:'auto'|'off',
   *   onChange?:(doc:any)=>void,
   *   setSavedState?:(text:string, state?:string)=>void,
   * }} opts
   */
  constructor(host, opts = {}) {
    if (!host) throw new Error('Board 需要一个挂载节点');

    this.host = host;
    this.opts = opts || {};
    // 持久化模式：'auto' = 浏览器本地自动保存（默认）；'off' = 由外壳接管存储
    this._persistence = this.opts.persistence === 'off' ? 'off' : 'auto';
    this._onChange = typeof this.opts.onChange === 'function' ? this.opts.onChange : null;
    this._changeTimer = null;
    this._suppressChange = false;
    this.items = [];
    this.selected = new Set();
    this.history = [];
    this.redoStack = [];
    this._view = { x: 0, y: 0, scale: 1 };

    this.tool = 'select';
    this.editingId = null;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;

    this._els = new Map();          // id -> DOM 元素
    this._imgCache = new Map();     // src -> HTMLImageElement（导出用）
    this._spaceDown = false;
    this._active = false;
    this._destroyed = false;
    this._saveTimer = null;
    this._clearTimer = null;
    this._pasteSeq = 0;
    this._clearArmed = false;
    this._lastQuotaToast = 0;
    this._saveIndicator = '已保存';

    // 持久化：IndexedDB 为主存储，localStorage 只做降级
    this._db = null;                 // IDBDatabase（不可用时为 null）
    this._storageMode = 'idb';       // 'idb' | 'ls'
    this._dbReady = false;           // 已决定用哪条存储路径
    this._saveChain = Promise.resolve();   // 写入串行化，避免乱序
    this._saveSeq = 0;
    this._pendingSaves = 0;          // 排队中的写入数（判断是否全部落盘）
    this._hasLegacy = false;         // localStorage 里是否还有旧数据
    this._touched = false;           // 用户是否已经操作过（防止异步恢复覆盖内容）
    this._viewTouched = false;       // 用户是否已经动过视角
    this._readyResolved = false;
    this._readyPromise = new Promise((resolve) => { this._resolveReady = resolve; });
    this._restoreSkipToasted = false;
    this._saveDirty = false;         // 有改动还没落盘（关页面时用于写紧急快照）
    this._toolHints = new Set();     // 非选择工具"按到元素"提示：每种工具只提示一次

    // 画笔 / 荧光笔颜色（各自记忆，localStorage 保存；服务器模式下也保留用户偏好）
    this._penColor = DEFAULT_PEN_COLOR;
    this._hlColor = DEFAULT_HL_COLOR;
    this._loadColorPrefs();

    // A4 页面模式（纸张只是参考格，元素始终在世界坐标里，切换不移动）
    this._pageMode = 'infinite';
    this._pageCount = 1;
    this._curPage = 0;                 // 0-based，范围 0..pageCount-1
    this._pageWrapToastAt = 0;         // 「页底回卷」提示节流

    // 编辑态
    this._editEl = null;
    this._editSnap = null;
    this._editOriginal = '';
    this._editIsNew = false;

    // 事件统一用 AbortController 回收
    this._ac = new AbortController();
    const sig = this._ac.signal;

    this._buildDom();
    this._buildToolbar();
    this._buildSelbar();
    this._bindEvents(sig);

    this._measure();
    this._syncCanvas();

    this._renderAll();
    this._applyView();

    // 自动恢复是异步的（IndexedDB），恢复回来时若用户已经开始操作则不覆盖
    if (this._persistence === 'auto') {
      this._startRestore();
    } else {
      // 外部持久化模式：完全不碰本地存储，ready() 立即可用
      this._dbReady = true;
      this._readyResolved = true;
      if (this._resolveReady) this._resolveReady();
      this._updateEmptyHint();
    }

    // 宿主尺寸变化（分割条拖动 / 窗口缩放）
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this._onResize());
      this._ro.observe(this.root);
    }
    this._onWindowResize = () => this._onResize();
    window.addEventListener('resize', this._onWindowResize, { signal: sig });
  }

  /* ---------------------- 公共契约 ---------------------- */

  get hasContent() {
    return this.items.length > 0;
  }

  get view() {
    return { x: this._view.x, y: this._view.y, scale: this._view.scale };
  }

  /**
   * PDF 剪贴块 → 图片元素。
   * 默认智能落位（视口中央 → 与最近元素排成一列），显式 {x,y} 时按坐标原样放置。
   */
  addClip(clip, opts = {}) {
    if (this._destroyed) return null;
    const { center = true } = opts || {};
    const src = clip && (clip.dataUrl || clip.dataURL || clip.src);
    if (typeof src !== 'string' || !src) {
      this._toast('剪贴内容无效，无法粘贴');
      return null;
    }

    let pw = Number(clip.width);
    let ph = Number(clip.height);
    let fitOnLoad = false;
    if (!(pw > 0) || !(ph > 0)) { pw = 480; ph = 360; fitOnLoad = true; }
    let dpr = Number(clip.dpr);
    if (!(dpr > 0)) dpr = 1;

    let ww = pw / dpr;
    let wh = ph / dpr;
    // 极端超大截图适度缩小，避免一贴就把视口撑爆
    const cap = Math.min(1, 1600 / Math.max(ww, wh));
    ww = Math.max(40, Math.round(ww * cap));
    wh = Math.max(30, Math.round(wh * cap));

    if (this.editingId) this.commitEdit();

    this._record('add');

    // 智能落位：先中央，跟已有元素重叠太多就接着往下排
    const pos = center
      ? this._placeFor(ww, wh)
      : { x: Math.round(finite(opts.x, 0)), y: Math.round(finite(opts.y, 0)) };

    const pageNum = Number(clip.page);
    const it = {
      id: uid(),
      type: 'image',
      x: pos.x,
      y: pos.y,
      w: ww,
      h: wh,
      z: this._nextZ(),
      src,
      page: Number.isFinite(pageNum) && pageNum > 0 ? Math.round(pageNum) : undefined,
      naturalW: pw,
      naturalH: ph,
    };
    if (fitOnLoad) it._fitOnLoad = true;

    this.items.push(it);
    this._renderAll();
    this.setSelection([it.id]);
    this._ensureSelectTool();        // 贴入即回到选择工具，直接就能拖动

    // 贴入不改变当前缩放；只把落点拉进视野（不改变 scale）
    if (center) this._revealRect(this._itemBBox(it));
    this.scheduleSave();
    return it;
  }

  /** 新建文字元素（不做就地编辑） */
  addText(text, opts = {}) {
    if (this._destroyed) return null;
    const o = opts || {};
    const t = typeof text === 'string' ? text : '';
    const fs = clamp(finite(o.fontSize, 18), 8, 200);
    const lineH = fs * 1.5;

    // 1) 先定宽度：内容窄按内容收紧，内容宽则收敛到 460 折行（与文字工具提交同一规则）。
    //    显式传了 {w} 时视为调用方的明确选择：保持该宽度，内容按它折行（不受 460 限制）。
    const explicitW = Number(o.w) > 0;
    const capW = explicitW ? clamp(Math.round(Number(o.w)), 60, 4000) : MAX_TEXT_WIDTH;
    const baseW = explicitW ? capW : clamp(Math.round(finite(o.w, 300)), 60, MAX_TEXT_WIDTH);
    const w = explicitW ? baseW : (t ? this._fitTextWidth(t, fs, baseW) : baseW);
    // 2) 再按最终宽度测量真实排版高度（显式换行 + 自动折行）
    const block = this._measureTextBlock(t, fs, w);

    const it = {
      id: uid(),
      type: 'text',
      x: 0,
      y: 0,
      w,
      h: Math.max(Math.ceil(lineH), Math.round(block.h)),
      z: this._nextZ(),
      text: t,
      fontSize: fs,
      color: colorOr(o.color, TEXT_COLOR),
    };
    const explicitPos = Number.isFinite(Number(o.x)) && Number.isFinite(Number(o.y));
    if (explicitPos) {
      it.x = Math.round(Number(o.x));
      it.y = Math.round(Number(o.y));
    } else {
      // 和 addClip 完全同一套智能落位（先中央，和已有元素重叠太多就往上一个元素下面排）
      const pos = this._placeFor(it.w, it.h);
      it.x = pos.x;
      it.y = pos.y;
    }
    if (this.editingId) this.commitEdit();
    this._record('add');
    this.items.push(it);
    this._renderAll();
    this.setSelection([it.id]);
    this._ensureSelectTool();        // 贴文本后同样回到选择工具
    if (!explicitPos) this._revealRect(this._itemBBox(it));
    this.scheduleSave();
    return it;
  }

  /* ---------------------- 智能落位 ---------------------- */

  /**
   * 计算新元素的落点（世界坐标）：
   * 1. 先试视口中央；
   * 2. 与已有元素的矩形重叠面积 > 新元素面积 25% 时，贴到「最近添加的元素」正下方
   *    （x 对齐，y = 该元素底边 + 24），还不行就继续下移，最多尝试 12 次；
   * 3. 全部失败 → 兜底：中央 + (pasteSeq % 8) * 18 的阶梯错位（保证不完全重叠）。
   */
  _placeFor(w, h) {
    // A4 模式：落位限制在当前页内（列式下落，触底回卷页顶）
    if (this._pageMode === 'a4') return this._placeForInPage(w, h);
    const center = this._centerPlacement(w, h);
    if (!this._overlapsTooMuch(center, w, h)) return center;

    const ref = this.items.length ? this.items[this.items.length - 1] : null;
    const refBox = ref ? this._itemBBox(ref) : null;
    let cand = refBox
      ? { x: Math.round(refBox.x), y: Math.round(refBox.y + refBox.h + 24) }
      : { x: center.x, y: Math.round(center.y + h + 24) };

    for (let i = 0; i < 12; i++) {
      if (!this._overlapsTooMuch(cand, w, h)) return cand;
      cand = { x: cand.x, y: Math.round(cand.y + h + 24) };
    }

    // 12 次都被占住 → 回到老的中央落位 + 阶梯错位兜底
    const jitter = (this._pasteSeq++ % 8) * 18;
    return { x: center.x + jitter, y: center.y + jitter };
  }

  /** 视口正中央的落点 */
  _centerPlacement(w, h) {
    const c = this.screenToWorld(this.w / 2, this.h / 2);
    return { x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2) };
  }

  /** 新矩形与已有元素的重叠面积是否超过自身面积的 25% */
  _overlapsTooMuch(pos, w, h) {
    const area = Math.max(1, w * h);
    const limit = area * 0.25;
    let sum = 0;
    for (const it of this.items) {
      const b = this._itemBBox(it);
      const ix = Math.min(pos.x + w, b.x + b.w) - Math.max(pos.x, b.x);
      if (ix <= 0) continue;
      const iy = Math.min(pos.y + h, b.y + b.h) - Math.max(pos.y, b.y);
      if (iy <= 0) continue;
      sum += ix * iy;
      if (sum > limit) return true;
    }
    return false;
  }

  /**
   * 把刚放下的元素滚进视野（只平移，绝不改 scale）。
   * 元素能完整放进视口时，用最小平移让它四周留出 24px 边距；
   * 元素比视口还大时，只在它完全看不见时才对齐到左上。
   */
  _revealRect(box) {
    if (!box || this.w <= 0 || this.h <= 0) return false;
    const s = this._view.scale;
    const m = 24;
    const sx = box.x * s + this._view.x;
    const sy = box.y * s + this._view.y;
    const sw = box.w * s;
    const sh = box.h * s;
    let vx = this._view.x;
    let vy = this._view.y;
    let changed = false;

    if (sw <= this.w - m * 2) {
      if (sx < m) { vx = m - box.x * s; changed = true; }
      else if (sx + sw > this.w - m) { vx = this.w - m - (box.x + box.w) * s; changed = true; }
    } else if (sx + sw <= 0 || sx >= this.w) {
      vx = m - box.x * s;
      changed = true;
    }

    if (sh <= this.h - m * 2) {
      if (sy < m) { vy = m - box.y * s; changed = true; }
      else if (sy + sh > this.h - m) { vy = this.h - m - (box.y + box.h) * s; changed = true; }
    } else if (sy + sh <= 0 || sy >= this.h) {
      vy = m - box.y * s;
      changed = true;
    }

    if (!changed) return false;
    this._view.x = vx;
    this._view.y = vy;
    this._viewTouched = true;
    this._applyView();
    this.scheduleSave();
    return true;
  }

  clear() {
    if (!this.items.length) { this._toast('白板已经是空的'); return false; }
    if (this.editingId) this.cancelEdit();
    this._record('clear');
    this.items = [];
    this.selected.clear();
    this._renderAll();
    this._applyView();
    this.scheduleSave();
    return true;
  }

  undo() {
    if (this._destroyed) return false;
    if (this.editingId) this.cancelEdit();
    if (!this.history.length) return false;
    const entry = this.history.pop();
    this.redoStack.push({ snap: this.snapshot(), kind: entry.kind, t: 0 });
    if (this.redoStack.length > MAX_HISTORY) this.redoStack.shift();
    this._restoreSnapshot(entry.snap);
    return true;
  }

  redo() {
    if (this._destroyed) return false;
    if (this.editingId) this.cancelEdit();
    if (!this.redoStack.length) return false;
    const entry = this.redoStack.pop();
    this.history.push({ snap: this.snapshot(), kind: entry.kind, t: 0 });
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this._restoreSnapshot(entry.snap);
    return true;
  }

  /**
   * 把整块白板渲染成离屏 canvas（白底、内容 bbox + 留白、默认 2x，受尺寸/像素上限约束）。
   * 内容与 exportPNG 完全一致，供外壳做 PDF 导出等二次使用。
   * @param {{scale?:number, padding?:number, background?:string}} [opts]
   * @returns {Promise<HTMLCanvasElement|null>} 空板或无法渲染时返回 null
   */
  async renderToCanvas(opts = {}) {
    if (this._destroyed) return null;
    if (this.editingId) this.commitEdit();

    // 传 rect → 按世界矩形裁剪渲染（一页 A4 一张图）；不传 → 保持原行为（内容 bbox + 留白）
    const rect = opts.rect && typeof opts.rect === 'object' ? opts.rect : null;
    let box;
    let PAD;
    if (rect) {
      const rx = finite(rect.x, 0);
      const ry = finite(rect.y, 0);
      const rw = Math.max(1, finite(rect.w, 1));
      const rh = Math.max(1, finite(rect.h, 1));
      box = { x: rx, y: ry, w: rw, h: rh };
      PAD = clamp(finite(opts.padding, 0), 0, 4000);
    } else {
      if (!this.items.length) return null;
      box = this.contentBBox();
      if (!box) return null;
      PAD = clamp(finite(opts.padding, 60), 0, 4000);
    }

    const wantScale = clamp(finite(opts.scale, 2), 0.2, 8);
    const bg = typeof opts.background === 'string' ? opts.background : '#ffffff';
    const wWorld = box.w + PAD * 2;
    const hWorld = box.h + PAD * 2;

    // 目标 2x，但受 canvas 尺寸 / 总像素限制（超大板不会 OOM）
    const MAX_DIM = 8192;
    const MAX_PIX = 3.4e7;
    let k = Math.min(wantScale, MAX_DIM / wWorld, MAX_DIM / hWorld, Math.sqrt(MAX_PIX / (wWorld * hWorld)));
    k = Math.max(0.2, k);

    const cw = Math.max(1, Math.round(wWorld * k));
    const ch = Math.max(1, Math.round(hWorld * k));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cw, ch);
    ctx.save();
    ctx.scale(k, k);
    ctx.translate(PAD - box.x, PAD - box.y);

    const sorted = this._sortedItems();
    // 与屏幕层级一致：先画元素（图片 + 文字），再画笔画（批注盖在图上）
    for (const it of sorted) {
      if (it.type === 'stroke') continue;
      if (it.type === 'image') {
        const img = await this._loadImage(it.src);
        if (img) {
          const r = Math.min(4, it.w / 2, it.h / 2);
          ctx.save();
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') ctx.roundRect(it.x, it.y, it.w, it.h, r);
          else ctx.rect(it.x, it.y, it.w, it.h);
          ctx.clip();
          ctx.drawImage(img, it.x, it.y, it.w, it.h);
          ctx.restore();
          // 细边框
          ctx.save();
          ctx.strokeStyle = 'rgba(31,35,41,.14)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') ctx.roundRect(it.x + 0.5, it.y + 0.5, Math.max(1, it.w - 1), Math.max(1, it.h - 1), r);
          else ctx.rect(it.x + 0.5, it.y + 0.5, Math.max(1, it.w - 1), Math.max(1, it.h - 1));
          ctx.stroke();
          ctx.restore();
          // P{page} 角标（与屏幕上看到的一致）
          if (it.page) {
            const label = 'P' + it.page;
            ctx.save();
            ctx.font = `600 11px ${FONT_STACK}`;
            const tw = ctx.measureText(label).width || 12;
            const bwid = Math.ceil(tw + 10);
            const bhei = 16;
            ctx.fillStyle = 'rgba(31,35,41,.7)';
            ctx.beginPath();
            if (typeof ctx.roundRect === 'function') ctx.roundRect(it.x, it.y, bwid, bhei, [4, 0, 4, 0]);
            else ctx.rect(it.x, it.y, bwid, bhei);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            ctx.fillText(label, it.x + 5, it.y + bhei / 2 + 0.5);
            ctx.restore();
          }
        } else {
          ctx.save();
          ctx.fillStyle = '#f2f4f7';
          ctx.fillRect(it.x, it.y, it.w, it.h);
          ctx.strokeStyle = 'rgba(31,35,41,.2)';
          ctx.lineWidth = 1;
          ctx.strokeRect(it.x + 0.5, it.y + 0.5, it.w - 1, it.h - 1);
          ctx.restore();
        }
      } else if (it.type === 'text') {
        this._drawTextCtx(ctx, it);
      }
    }
    // 笔画最后画（盖在图片/文字之上，和屏幕上的层级一致）
    for (const it of sorted) {
      if (it.type === 'stroke') this._drawStrokeCtx(ctx, it);
    }
    ctx.restore();
    return canvas;
  }

  /** 导出全部内容为 PNG（内部复用 renderToCanvas：2x、白底、四周 60 世界像素留白） */
  async exportPNG() {
    if (this._destroyed) return false;
    if (!this.items.length) { this._toast('白板还是空的，先贴点内容'); return false; }

    let canvas = null;
    try {
      canvas = await this.renderToCanvas({ scale: 2, padding: 60, background: '#ffffff' });
    } catch {
      canvas = null;
    }
    if (!canvas) { this._toast('导出失败：无法渲染白板'); return false; }

    let blob = null;
    try {
      blob = await new Promise((resolve) => {
        try { canvas.toBlob((b) => resolve(b), 'image/png'); }
        catch { resolve(null); }
      });
    } catch {
      blob = null;
    }
    if (!blob) { this._toast('导出失败：图片过大'); return false; }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = stampName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return true;
  }

  toJSON() {
    return {
      version: 1,
      view: { x: this._view.x, y: this._view.y, scale: this._view.scale },
      pageMode: this._pageMode,
      pageCount: this._pageCount,
      curPage: this._curPage,
      items: this.items.map(cloneItem),
    };
  }

  /**
   * 恢复/切换白板（容错：坏数据不崩，非法元素丢弃）。
   * @param {any} obj 白板块数据（{version,view,items} 或 items 数组）
   * @param {{silent?:boolean}} [opts] silent 默认 true：
   *   true  → 不触发 onChange、不写任何存储（外壳切板/服务器加载用）；
   *   false → 允许按 auto 模式写入本地存储（但仍然不触发 onChange）。
   * 无论哪种模式都会重置撤销/重做栈、清空选中、完整切换 items 与视图。
   */
  loadJSON(obj, opts = {}) {
    if (this._destroyed) return false;
    const silent = !opts || opts.silent !== false;
    const isArr = Array.isArray(obj);
    const hasItems = isArr || (!!obj && typeof obj === 'object' && Array.isArray(obj.items));
    if (!hasItems) { this._toast('白板文件格式不正确'); return false; }
    if (this.editingId) this.cancelEdit();
    try {
      this._applyData(obj);
    } catch {
      this._toast('白板文件格式不正确');
      return false;
    }
    // 切板时先清掉上一块板还没触发的自动保存 / onChange，避免把旧内容写过去
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (this._changeTimer) { clearTimeout(this._changeTimer); this._changeTimer = null; }
    this._saveDirty = false;

    this.history.length = 0;
    this.redoStack.length = 0;
    this.selected.clear();
    this._touched = true;
    this._viewTouched = true;

    // 加载动作本身不算用户改动：屏蔽 onChange（scheduleSave 内部会检查）
    this._suppressChange = true;
    try {
      this._renderAll();
      this._applyView();
      this._syncPageUI();
      if (!silent) this.scheduleSave();
    } finally {
      this._suppressChange = false;
    }
    return true;
  }

  /** 缩放到能看到全部内容 */
  fitContent() {
    if (this._destroyed) return;
    this._viewTouched = true;
    const box = this.contentBBox();
    if (!box) {
      this._view = { x: 0, y: 0, scale: 1 };
      this._applyView();
      this.scheduleSave();
      return;
    }
    this._fitRect(box, 60, 2);
    this._applyView();
    this.scheduleSave();
  }

  /* ---------------------- A4 页面模式 ---------------------- */

  getPageMode() {
    return this._pageMode;
  }

  /** 各页的世界矩形（多页纵向排列；与是否处于 A4 模式无关，供导出用） */
  pageRects() {
    const n = clamp(Math.round(finite(this._pageCount, 1)), 1, MAX_PAGES);
    const rects = [];
    for (let i = 0; i < n; i++) {
      rects.push({ x: 0, y: i * (A4_PAGE_H + A4_PAGE_GAP), w: A4_PAGE_W, h: A4_PAGE_H });
    }
    return rects;
  }

  _syncPageUI() {
    const a4 = this._pageMode === 'a4';
    if (this.modeBtns) {
      for (const [mode, btn] of this.modeBtns) btn.classList.toggle('bp-on', mode === this._pageMode);
    }
    if (this.pageBar) this.pageBar.hidden = !a4;
    if (this.pageLabelEl) this.pageLabelEl.textContent = `第 ${this._curPage + 1} / ${this._pageCount} 页`;
    if (this.pagePrevBtn) this.pagePrevBtn.disabled = this._curPage <= 0;
    if (this.pageNextBtn) this.pageNextBtn.disabled = this._curPage >= this._pageCount - 1;
    if (this.pageDelBtn) this.pageDelBtn.disabled = this._pageCount <= 1;
  }

  /** 页面数量/当前页变化后：重画纸张、把当前页拉进视野、存盘 */
  /** 把当前页居中到视野（不改缩放） */
  _centerPageInView() {
    const page = this.pageRects()[this._curPage];
    if (!page || this.w <= 0 || this.h <= 0) return;
    const s = this._view.scale;
    this._view.x = Math.round(this.w / 2 - (page.x + page.w / 2) * s);
    this._view.y = Math.round(this.h / 2 - (page.y + page.h / 2) * s);
    this._viewTouched = true;
    this._applyView();
  }

  _afterPageChange() {
    this._syncPageUI();
    this._centerPageInView();
    this.scheduleSave();
  }

  setPageMode(mode) {
    const next = mode === 'a4' ? 'a4' : 'infinite';
    if (next === this._pageMode) return false;
    this._pageMode = next;
    this._syncPageUI();
    this._drawGrid();
    if (next === 'a4') {
      // 切到 A4：先适应内容，再把当前页居中到视野
      this.fitContent();
      this._centerPageInView();
    }
    this.scheduleSave();
    return true;
  }

  setPageCount(n) {
    const next = clamp(Math.round(finite(n, 1)), 1, MAX_PAGES);
    if (next === this._pageCount) return false;
    this._pageCount = next;
    this._curPage = clamp(this._curPage, 0, next - 1);
    this._afterPageChange();
    return true;
  }

  setCurPage(i, opts = {}) {
    const next = clamp(Math.round(finite(i, 0)), 0, this._pageCount - 1);
    if (next === this._curPage) return false;
    this._curPage = next;
    this._syncPageUI();
    // 点页面空白处切换时不要平移视图（避免打断正在开始的框选）
    if (opts.reveal !== false) this._centerPageInView();
    else this._drawGrid();
    this.scheduleSave();
    return true;
  }

  /** 末尾添加一页并跳过去 */
  addPage() {
    if (this._pageCount >= MAX_PAGES) { this._toast(`最多 ${MAX_PAGES} 页`, 2400); return false; }
    this._pageCount += 1;
    this._curPage = this._pageCount - 1;
    this._afterPageChange();
    return true;
  }

  /** 删除当前页的纸张（元素不删除、不移动；至少保留 1 页） */
  removePage() {
    if (this._pageCount <= 1) { this._toast('至少保留 1 页', 2400); return false; }
    this._pageCount -= 1;
    this._curPage = clamp(this._curPage, 0, this._pageCount - 1);
    this._afterPageChange();
    this._toast('已删除纸张（页面上的内容不会被删除）', 2400);
    return true;
  }

  /** A4 模式下的落位：限制在当前页内，列式下落，触底回卷到页顶 */
  _placeForInPage(w, h) {
    const page = this.pageRects()[this._curPage] || { x: 0, y: 0, w: A4_PAGE_W, h: A4_PAGE_H };
    const margin = 24;
    const x = w <= page.w - margin * 2
      ? clamp(page.x + margin, page.x, page.x + page.w - w)
      : page.x;
    // 当前页里已有元素的最下沿
    let bottom = page.y + margin;
    for (const it of this.items) {
      const b = this._itemBBox(it);
      if (b.x >= page.x + page.w || b.x + b.w <= page.x) continue;
      if (b.y >= page.y + page.h || b.y + b.h <= page.y) continue;
      bottom = Math.max(bottom, b.y + b.h + margin);
    }
    let y = bottom;
    let wrapped = false;
    if (y + h > page.y + page.h) { y = page.y + margin; wrapped = true; }
    // 回卷后若压住已有元素，继续向下找空位（最多 12 次，再不行就允许重叠）
    for (let i = 0; i < 12; i++) {
      if (!this._overlapsTooMuch({ x, y }, w, h)) break;
      y += h + margin;
      if (y + h > page.y + page.h) { y = page.y + margin; break; }
    }
    if (wrapped) {
      const now = Date.now();
      if (!this._pageWrapToastAt || now - this._pageWrapToastAt > 1500) {
        this._pageWrapToastAt = now;
        this._toast('当前页放不下，已从页顶开始', 2400);
      }
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  /* ---------------------- 一键排列 / 对齐 ---------------------- */

  /** 排列按钮可用状态（白板为空时禁用） */
  _syncArrangeBtn() {
    if (!this.arrangeBtn) return;
    const empty = this.items.length === 0;
    this.arrangeBtn.disabled = empty;
    if (empty) this._closeArrangeMenu();
  }

  _toggleArrangeMenu() {
    if (!this.arrangeMenu) return;
    if (!this.arrangeMenu.hidden) { this._closeArrangeMenu(); return; }
    if (!this.items.length) return;
    this._syncArrangeBtn();
    const rr = this.root.getBoundingClientRect();
    const br = this.arrangeBtn.getBoundingClientRect();
    const left = Math.max(8, br.left - rr.left);
    const top = br.bottom - rr.top + 6;
    this.arrangeMenu.style.left = Math.round(left) + 'px';
    this.arrangeMenu.style.top = Math.round(top) + 'px';
    this.arrangeMenu.hidden = false;
    this.arrangeBtn.classList.add('bp-on');
  }

  _closeArrangeMenu({ restoreFocus = false } = {}) {
    if (!this.arrangeMenu) return;
    this.arrangeMenu.hidden = true;
    if (this.arrangeBtn) this.arrangeBtn.classList.remove('bp-on');
    // 菜单项/菜单关闭后焦点会落到 body，键盘快捷键（Ctrl+Z、Delete、V/P…）就失效了，
    // 所以执行完动作或按 Esc 收起时把焦点还给画布，避免"一键排列后按不了 Ctrl+Z"。
    if (restoreFocus) {
      try { this.root.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
  }

  /**
   * 一键排列 / 对齐（一次排列 = 一次撤销）。
   * @param {'alignLeft'|'alignTop'|'vertical'|'horizontal'|'grid'|'twoCols'|'mindmap'|'mindmapLinks'} kind
   * @returns {boolean} 是否真的移动了元素
   */
  arrange(kind) {
    if (this._destroyed) return false;
    if (this.editingId) this.commitEdit();

    const sel = [...this.selected];
    let pool;
    // 选中 ≥2 个 → 只排选中的；否则（没选 / 只选了 1 个）→ 排全部。
    // 之所以把"只选中 1 个"也归到排全部：贴完最后一张图后它会保持选中状态，
    // 这时用户点"排列"显然是想整理整块板，而不是什么都不发生。
    if (sel.length >= 2) pool = sel;
    else pool = this.items.map((it) => it.id);
    if (pool.length < 2) return false;

    const poolIds = new Set(pool);
    const layout = [];
    for (const id of pool) {
      const it = this.get(id);
      if (!it) continue;
      // 思维导图连线不参与排布（端点随元素重算）
      if (it.kind === 'connector') continue;
      // 归属父元素的笔画跟着父元素走（父元素也在本次排列范围内），不单独排
      if (it.type === 'stroke' && it.parentId && poolIds.has(it.parentId)) continue;
      layout.push(it);
    }
    if (layout.length < 2) return false;

    const bbox = (it) => this._itemBBox(it);
    // 阅读顺序：y 升序；y 接近（< 半行高）时按 x 升序（Array#sort 稳定）
    const order = layout.slice().sort((a, b) => {
      const A = bbox(a);
      const B = bbox(b);
      if (Math.abs(A.y - B.y) < ARRANGE_ROW_TOL) return A.x - B.x;
      return A.y - B.y;
    });

    // 锚点：集合外接框左上角（思维导图不用它，中心节点保持原位）
    let ax = Infinity;
    let ay = Infinity;
    for (const it of order) {
      const b = bbox(it);
      if (b.x < ax) ax = b.x;
      if (b.y < ay) ay = b.y;
    }

    const gap = ARRANGE_GAP;
    const targets = new Map();     // id -> {x, y}
    const setTarget = (it, x, y) => targets.set(it.id, { x, y });

    // 「思维导图（带连线）」= 放射状布局 + 建线；其它 kind 直接按本身处理
    const withLinks = kind === 'mindmapLinks';
    const layoutKind = withLinks ? 'mindmap' : kind;

    if (layoutKind === 'alignLeft') {
      for (const it of order) setTarget(it, ax, it.y);
    } else if (layoutKind === 'alignTop') {
      for (const it of order) setTarget(it, it.x, ay);
    } else if (layoutKind === 'vertical') {
      let y = ay;
      for (const it of order) { setTarget(it, ax, y); y += bbox(it).h + gap; }
    } else if (layoutKind === 'horizontal') {
      let x = ax;
      for (const it of order) { setTarget(it, x, ay); x += bbox(it).w + gap; }
    } else if (layoutKind === 'grid') {
      const cols = Math.max(1, Math.ceil(Math.sqrt(order.length)));
      let maxW = 0;
      let maxH = 0;
      for (const it of order) {
        const b = bbox(it);
        if (b.w > maxW) maxW = b.w;
        if (b.h > maxH) maxH = b.h;
      }
      const colW = maxW + gap;
      const rowH = maxH + gap;
      order.forEach((it, i) => {
        setTarget(it, ax + (i % cols) * colW, ay + Math.floor(i / cols) * rowH);
      });
    } else if (layoutKind === 'twoCols') {
      // 按顺序累加高度，取最接近「总高一半」的位置分列
      const total = order.reduce((sum, it, i) => sum + bbox(it).h + (i ? gap : 0), 0);
      const half = total / 2;
      let split = 1;
      let best = Infinity;
      let acc = 0;
      for (let k = 0; k < order.length - 1; k++) {
        acc += bbox(order[k]).h + (k ? gap : 0);
        const diff = Math.abs(acc - half);
        if (diff < best) { best = diff; split = k + 1; }
      }
      const col1 = order.slice(0, split);
      const col2 = order.slice(split);
      let maxW1 = 0;
      for (const it of col1) maxW1 = Math.max(maxW1, bbox(it).w);
      let y1 = ay;
      for (const it of col1) { setTarget(it, ax, y1); y1 += bbox(it).h + gap; }
      let y2 = ay;
      for (const it of col2) { setTarget(it, ax + maxW1 + gap, y2); y2 += bbox(it).h + gap; }
    } else if (layoutKind === 'mindmap') {
      // 放射状：中心节点不动，其余等角度分布在环上（起始 -90° 正上方，顺时针）
      const center = order[0];
      const cb = bbox(center);            // 中心节点位置不变
      const rootCx = cb.x + cb.w / 2;
      const rootCy = cb.y + cb.h / 2;
      const sats = order.slice(1);
      const sn = sats.length;
      const satBoxes = sats.map(bbox);
      let maxItemW = 0;
      let maxItemH = 0;
      for (const b of satBoxes) {
        if (b.w > maxItemW) maxItemW = b.w;
        if (b.h > maxItemH) maxItemH = b.h;
      }

      const boxesOverlap = (a, b) => {
        const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        return ix > 0.5 && iy > 0.5;
      };

      if (sn === 1) {
        // 单个：放右侧（θ=0°），避免孤零零跑到正上方
        const b = satBoxes[0];
        setTarget(sats[0], cb.x + cb.w + gap, rootCy - b.h / 2);
      } else if (sn === 2) {
        // 两个：左右各一个（θ=0°、180°）
        const b0 = satBoxes[0];
        const b1 = satBoxes[1];
        setTarget(sats[0], cb.x + cb.w + gap, rootCy - b0.h / 2);
        setTarget(sats[1], cb.x - gap - b1.w, rootCy - b1.h / 2);
      } else {
        // 半径：不压中心（Rbase）+ 环上周长不挤（Rcirc）
        const maxItemSize = Math.max(maxItemW, maxItemH);
        const Rbase = Math.max(cb.w, cb.h) / 2 + gap + maxItemSize / 2;
        const Rcirc = ((maxItemW + gap) * sn) / (2 * Math.PI);
        const R = Math.max(Rbase, Rcirc);

        const placeRing = (list, radius, startDeg) => {
          list.forEach((it, i) => {
            const b = bbox(it);
            const deg = startDeg + (i * 360) / Math.max(1, list.length);
            const rad = (deg * Math.PI) / 180;
            setTarget(it, rootCx + radius * Math.cos(rad) - b.w / 2, rootCy + radius * Math.sin(rad) - b.h / 2);
          });
        };
        placeRing(sats, R, -90);

        // 兜底：元素多（n≥9）且环上仍重叠 → 内外两圈交替
        if (sn >= 9) {
          const placed = sats.map((it) => {
            const t = targets.get(it.id);
            const b = bbox(it);
            return { x: t.x, y: t.y, w: b.w, h: b.h };
          });
          let overlap = false;
          for (let i = 0; i < placed.length && !overlap; i++) {
            for (let j = i + 1; j < placed.length; j++) {
              if (boxesOverlap(placed[i], placed[j])) { overlap = true; break; }
            }
          }
          if (overlap) {
            const outer = [];
            const inner = [];
            sats.forEach((it, i) => { (i % 2 === 0 ? outer : inner).push(it); });
            const Rout = R + maxItemSize + gap;
            placeRing(outer, Rout, -90);
            placeRing(inner, R, -90);
          }
        }
      }
    } else {
      return false;
    }

    // 「思维导图（带连线）」：先清理本次涉及元素间的旧连线，再按新布局重建（幂等）
    let linkPlan = null;
    if (withLinks) {
      const center = order[0];
      const involved = new Set(order.map((o) => o.id));
      const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
      const wanted = new Map();
      for (const sat of order.slice(1)) {
        wanted.set(pairKey(center.id, sat.id), { fromId: center.id, toId: sat.id });
      }
      const keepKeys = new Set();
      const remove = [];
      for (const it of this.items) {
        if (it.kind !== 'connector') continue;
        const key = pairKey(it.fromId, it.toId);
        const want = wanted.get(key);
        if (!want) {
          // 只清理"本次涉及元素之间"的旧线，其它连线保持不动
          if (involved.has(it.fromId) && involved.has(it.toId)) remove.push(it);
          continue;
        }
        if (it.fromId === want.fromId && it.toId === want.toId && !keepKeys.has(key)) keepKeys.add(key);
        else remove.push(it);          // 方向不对 / 重复线 → 重建
      }
      const create = [];
      for (const [key, want] of wanted) if (!keepKeys.has(key)) create.push(want);
      linkPlan = { remove, create, changed: remove.length > 0 || create.length > 0 };
    }

    // 先算位移；全都没动就不记历史（单元素/已排好时 no-op）
    const moves = [];
    for (const [id, t] of targets) {
      const it = this.get(id);
      if (!it) continue;
      const nx = Math.round(t.x);
      const ny = Math.round(t.y);
      const dx = nx - Math.round(it.x);
      const dy = ny - Math.round(it.y);
      if (!dx && !dy) continue;
      moves.push({ it, nx, ny, dx, dy });
    }
    if (!moves.length && !(linkPlan && linkPlan.changed)) return false;

    this._record('arrange');        // 一次排列 = 一次撤销（快照在改动/解绑之前）

    const dxMap = new Map();
    for (const m of moves) {
      m.it.x = m.nx;
      m.it.y = m.ny;
      this._syncItem(m.it);
      dxMap.set(m.it.id, { dx: m.dx, dy: m.dy });
    }
    // 绑定批注跟随父元素平移
    for (const it of this.items) {
      if (it.type !== 'stroke' || !it.parentId) continue;
      const d = dxMap.get(it.parentId);
      if (!d) continue;
      it.points = it.points.map((p) => ({ x: p.x + d.dx, y: p.y + d.dy }));
      it.bbox = { x: it.bbox.x + d.dx, y: it.bbox.y + d.dy, w: it.bbox.w, h: it.bbox.h };
    }
    // 被单独排布的绑定笔画：解绑（避免之后又跟着原父元素走）——已包含在撤销快照里
    for (const m of moves) {
      if (m.it.type === 'stroke' && m.it.parentId) m.it.parentId = null;
    }

    // 建线 / 清理旧线（与布局同属一次撤销）
    if (linkPlan) {
      if (linkPlan.remove.length) {
        const drop = new Set(linkPlan.remove);
        this.items = this.items.filter((it) => !drop.has(it));
      }
      for (const c of linkPlan.create) this.items.push(this._makeConnector(c.fromId, c.toId));
    }

    this.drawInk();
    this.renderSelection();
    this.scheduleSave();

    // 结果完全在视口外时平移视图（不改缩放）
    let ux = Infinity;
    let uy = Infinity;
    let ux2 = -Infinity;
    let uy2 = -Infinity;
    for (const it of layout) {
      const b = this._itemBBox(it);
      if (b.x < ux) ux = b.x;
      if (b.y < uy) uy = b.y;
      if (b.x + b.w > ux2) ux2 = b.x + b.w;
      if (b.y + b.h > uy2) uy2 = b.y + b.h;
    }
    for (const it of this.items) {
      if (it.type !== 'stroke' || !it.parentId || !dxMap.has(it.parentId)) continue;
      const b = this._itemBBox(it);
      if (b.x < ux) ux = b.x;
      if (b.y < uy) uy = b.y;
      if (b.x + b.w > ux2) ux2 = b.x + b.w;
      if (b.y + b.h > uy2) uy2 = b.y + b.h;
    }
    if (Number.isFinite(ux)) {
      this._revealRect({ x: ux, y: uy, w: Math.max(1, ux2 - ux), h: Math.max(1, uy2 - uy) });
    }
    return true;
  }

  destroy() {
    if (this._destroyed) return;
    this._cancelEditNoCommit();
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (this._changeTimer) { clearTimeout(this._changeTimer); this._changeTimer = null; }
    if (this._clearTimer) { clearTimeout(this._clearTimer); this._clearTimer = null; }
    // 先发起最后一次落盘，让 IDB 事务自己跑完（异步，不等）；'off' 模式下这里是空操作
    this.flushSave().catch(() => {});
    this._destroyed = true;
    this._ac.abort();
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this._imgCache) this._imgCache.clear();
    this._els.clear();
    this.root.remove();
    this.host.innerHTML = '';
  }

  /* ---------------------- DOM 构建 ---------------------- */

  _buildDom() {
    const root = ce('div', 'bp-root');
    root.tabIndex = 0;
    root.dataset.tool = 'select';
    root.setAttribute('role', 'application');
    root.setAttribute('aria-label', '白板画布');

    this.gridCanvas = ce('canvas', 'bp-grid');
    this.inkCanvas = ce('canvas', 'bp-ink');
    this.itemsEl = ce('div', 'bp-items');

    this.uiSel = ce('div', 'bp-ui-sel');
    this.marqueeEl = ce('div', 'bp-marquee');
    this.marqueeEl.hidden = true;
    this.ui = ce('div', 'bp-ui');
    this.ui.append(this.uiSel, this.marqueeEl);

    this.emptyEl = ce('div', 'bp-empty');
    this.emptyEl.innerHTML = `
      <div class="bp-empty-card">
        <svg class="bp-empty-art" viewBox="0 0 132 86" fill="none" aria-hidden="true">
          <rect x="8.5" y="20.5" width="34" height="45" rx="4" stroke="currentColor" stroke-dasharray="4 3"/>
          <path d="M22 11.5h8M26 7.5v8" stroke="currentColor" opacity=".55"/>
          <path d="M49 42h13" stroke="currentColor" stroke-width="1.6"/>
          <path d="M58 38l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          <rect x="68.5" y="18.5" width="55" height="49" rx="5" stroke="currentColor" stroke-dasharray="4 3" opacity=".85"/>
          <g fill="currentColor" opacity=".3">
            <circle cx="79" cy="29" r="1.1"/><circle cx="90" cy="29" r="1.1"/><circle cx="101" cy="29" r="1.1"/><circle cx="112" cy="29" r="1.1"/>
            <circle cx="79" cy="41" r="1.1"/><circle cx="90" cy="41" r="1.1"/><circle cx="101" cy="41" r="1.1"/><circle cx="112" cy="41" r="1.1"/>
            <circle cx="79" cy="53" r="1.1"/><circle cx="90" cy="53" r="1.1"/><circle cx="101" cy="53" r="1.1"/><circle cx="112" cy="53" r="1.1"/>
          </g>
          <rect x="76" y="24" width="26" height="14" rx="2.5" fill="currentColor" opacity=".12"/>
        </svg>
        <p class="bp-empty-title">框选左侧 PDF 区域 → 点「贴到白板」或按 Ctrl+V</p>
        <p class="bp-empty-sub">也可以双击空白处写文字，或用画笔直接批注</p>
      </div>`;

    // 图层自下而上：网格 → 元素(图片/文字) → 笔画 → 选中框/手柄/框选 → 空板提示
    // DOM 顺序与 CSS z-index 保持一致（.bp-grid 0 / .bp-items 1 / .bp-ink 2 / .bp-ui 3）
    root.append(this.gridCanvas, this.itemsEl, this.inkCanvas, this.ui, this.emptyEl);
    this.host.innerHTML = '';
    this.host.appendChild(root);
    this.root = root;

    this.gridCtx = this.gridCanvas.getContext('2d');
    this.inkCtx = this.inkCanvas.getContext('2d');
  }

  _buildToolbar() {
    const bar = ce('div', 'bp-toolbar');
    bar.setAttribute('role', 'toolbar');
    this.toolBtns = new Map();

    const tools = [
      ['select', '选择', 'V', ICON.select],
      ['pen', '画笔', 'P', ICON.pen],
      ['highlighter', '荧光笔', 'H', ICON.highlighter],
      ['eraser', '橡皮', 'E', ICON.eraser],
      ['text', '文字', 'T', ICON.text],
    ];
    for (const [id, label, key, icon] of tools) {
      const b = ce('button', 'btn icon bp-tool');
      b.type = 'button';
      b.dataset.tool = id;
      b.title = `${label}（${key}）`;
      b.setAttribute('aria-label', label);
      b.innerHTML = svgIcon(icon);
      b.addEventListener('click', () => this.setTool(id));
      this.toolBtns.set(id, b);
      bar.appendChild(b);
    }
    bar.appendChild(ce('span', 'bp-tb-sep'));

    // 色板（画笔/荧光笔共用；1-6 快捷切色，选中已有笔画时点色块直接改色）
    const swatches = ce('div', 'bp-swatches');
    swatches.setAttribute('role', 'group');
    swatches.setAttribute('aria-label', '笔迹颜色');
    this.swatchBtns = new Map();
    PALETTE_COLORS.forEach((color, i) => {
      const b = ce('button', 'bp-swatch');
      b.type = 'button';
      b.dataset.color = color;
      b.title = `颜色 ${i + 1}（${color}）`;
      b.setAttribute('aria-label', `颜色 ${i + 1}`);
      b.style.background = color;
      b.addEventListener('click', () => this._applyColor(color));
      swatches.appendChild(b);
      this.swatchBtns.set(color, b);
    });
    bar.appendChild(swatches);
    bar.appendChild(ce('span', 'bp-tb-sep'));

    const mkBtn = (cls, title, icon, onClick) => {
      const b = ce('button', 'btn icon ' + cls);
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = svgIcon(icon);
      b.addEventListener('click', onClick);
      return b;
    };

    const zOut = mkBtn('bp-zoom-out', '缩小（Ctrl+滚轮）', ICON.minus, () => this.zoomBy(1 / 1.2));
    const zIn = mkBtn('bp-zoom-in', '放大（Ctrl+滚轮）', ICON.plus, () => this.zoomBy(1.2));
    this.zoomEl = ce('button', 'btn bp-zoom');
    this.zoomEl.type = 'button';
    this.zoomEl.title = '点击恢复 100%';
    this.zoomEl.textContent = '100%';
    this.zoomEl.addEventListener('click', () => this.zoomTo(1));

    const fitBtn = ce('button', 'btn bp-fit');
    fitBtn.type = 'button';
    fitBtn.title = '缩放到能看到全部内容';
    fitBtn.innerHTML = svgIcon(ICON.fit) + '<span>适应内容</span>';
    fitBtn.addEventListener('click', () => this.fitContent());

    // 「排列」下拉菜单：对齐 + 排布
    this.arrangeBtn = ce('button', 'btn bp-arrange');
    this.arrangeBtn.type = 'button';
    this.arrangeBtn.title = '一键排列 / 对齐';
    this.arrangeBtn.setAttribute('aria-haspopup', 'menu');
    this.arrangeBtn.innerHTML = svgIcon(ICON.arrange) + '<span>排列</span><span class="bp-caret">▾</span>';
    this.arrangeBtn.addEventListener('click', (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      this._toggleArrangeMenu();
    });

    this.arrangeMenu = ce('div', 'bp-menu');
    this.arrangeMenu.hidden = true;
    this.arrangeMenu.setAttribute('role', 'menu');
    this.arrangeMenu.appendChild(ce('div', 'bp-menu-hint', '选中 2 个以上只排选中的，否则排全部'));
    const menuGroups = [
      ['对齐', [['alignLeft', '左对齐'], ['alignTop', '顶部对齐']]],
      ['排布', [['vertical', '竖向排列'], ['horizontal', '横向排列'], ['grid', '网格排列'], ['twoCols', '两列排列'], ['mindmap', '思维导图'], ['mindmapLinks', '思维导图（带连线）']]],
    ];
    for (const [title, entries] of menuGroups) {
      this.arrangeMenu.appendChild(ce('div', 'bp-menu-group', title));
      for (const [kind, label] of entries) {
        const b = ce('button', 'bp-menu-item', label);
        b.type = 'button';
        b.dataset.kind = kind;
        b.setAttribute('role', 'menuitem');
        b.addEventListener('click', () => { this._closeArrangeMenu({ restoreFocus: true }); this.arrange(kind); });
        this.arrangeMenu.appendChild(b);
      }
    }
    this.root.appendChild(this.arrangeMenu);

    this.clearBtn = ce('button', 'btn icon bp-clear');
    this.clearBtn.type = 'button';
    this.clearBtn.title = '清空白板（需要点两次确认）';
    this.clearBtn.setAttribute('aria-label', '清空白板');
    this.clearBtn.innerHTML = svgIcon(ICON.trash);
    this.clearBtn.addEventListener('click', () => this._onClearClick());

    this.savedEl = ce('span', 'bp-saved');
    this.savedEl.dataset.state = '';
    if (this._persistence === 'auto') {
      this.savedEl.textContent = this._saveIndicator;
      this.savedEl.title = '白板内容自动保存在本机浏览器';
    } else {
      // 外部持久化模式：状态文字由外壳控制（可通过 board.savedEl 更新，或用 setSavedState）
      this.savedEl.textContent = '';
      this.savedEl.title = '保存状态由外部控制';
    }

    // 模式切换：无限画布 | A4 页面
    const modeSeg = ce('div', 'bp-seg');
    modeSeg.setAttribute('role', 'group');
    modeSeg.setAttribute('aria-label', '画布模式');
    this.modeBtns = new Map();
    for (const [mode, label] of [['infinite', '无限画布'], ['a4', 'A4 页面']]) {
      const b = ce('button', 'btn bp-seg-btn', label);
      b.type = 'button';
      b.dataset.mode = mode;
      b.addEventListener('click', () => this.setPageMode(mode));
      modeSeg.appendChild(b);
      this.modeBtns.set(mode, b);
    }
    bar.appendChild(modeSeg);

    bar.append(zOut, this.zoomEl, zIn, fitBtn, this.arrangeBtn, this.clearBtn, this.savedEl);
    this.toolbar = bar;
    this.root.appendChild(bar);
    this._syncArrangeBtn();

    // A4 模式浮动页面条（顶部居中，位于工具条下方）
    this.pageBar = ce('div', 'bp-pagebar');
    this.pageBar.hidden = true;
    this.pageBar.setAttribute('role', 'toolbar');
    this.pageBar.setAttribute('aria-label', '页面');
    const navBtn = (label, title) => {
      const b = ce('button', 'btn icon bp-page-nav', label);
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      return b;
    };
    this.pagePrevBtn = navBtn('‹', '上一页');
    this.pageNextBtn = navBtn('›', '下一页');
    this.pageLabelEl = ce('span', 'bp-page-label', '第 1 / 1 页');
    this.pageAddBtn = ce('button', 'btn bp-page-add', '＋ 添加页');
    this.pageAddBtn.type = 'button';
    this.pageAddBtn.title = '在末尾添加一页并跳过去';
    this.pageDelBtn = ce('button', 'btn bp-page-del', '🗑 删除页');
    this.pageDelBtn.type = 'button';
    this.pageDelBtn.title = '删除当前页的纸张（内容不会被删除）';
    this.pagePrevBtn.addEventListener('click', () => this.setCurPage(this._curPage - 1));
    this.pageNextBtn.addEventListener('click', () => this.setCurPage(this._curPage + 1));
    this.pageAddBtn.addEventListener('click', () => this.addPage());
    this.pageDelBtn.addEventListener('click', () => this.removePage());
    this.pageBar.append(this.pagePrevBtn, this.pageLabelEl, this.pageNextBtn, this.pageAddBtn, this.pageDelBtn);
    this.root.appendChild(this.pageBar);

    this.toolBtns.get('select').classList.add('bp-on');
    this._syncSwatches();
    this._syncPageUI();
  }

  _buildSelbar() {
    const bar = ce('div', 'bp-selbar');
    bar.hidden = true;
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '选中元素操作');

    const mk = (title, icon, fn, danger) => {
      const b = ce('button', 'btn icon' + (danger ? ' bp-danger' : ''));
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = svgIcon(icon);
      b.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (this._destroyed) return;
        fn();
      });
      return b;
    };

    bar.append(
      mk('置顶（Ctrl+]）', ICON.toFront, () => this.bringToFront([...this.selected])),
      mk('置底（Ctrl+[）', ICON.toBack, () => this.sendToBack([...this.selected])),
      mk('删除（Delete）', ICON.trash, () => this.deleteSelection(), true),
    );
    this.selbar = bar;
    this.root.appendChild(bar);
  }

  /* ---------------------- 事件绑定 ---------------------- */

  _bindEvents(sig) {
    const root = this.root;

    root.addEventListener('pointerdown', (e) => this._onPointerDown(e), { signal: sig });
    root.addEventListener('dblclick', (e) => this._onDoubleClick(e), { signal: sig });
    root.addEventListener('wheel', (e) => this._onWheel(e), { signal: sig, passive: false });
    root.addEventListener('contextmenu', (e) => e.preventDefault(), { signal: sig });
    root.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();       // 中键不要触发自动滚动
    }, { signal: sig });
    root.addEventListener('focusin', () => { this._active = true; }, { signal: sig });

    // 点击白板以外的地方 → 白板失去「键盘焦点」
    document.addEventListener('pointerdown', (e) => {
      if (!root.contains(e.target)) this._active = false;
    }, { signal: sig });

    // 拖入图片文件
    root.addEventListener('dragover', (e) => this._onDragOver(e), { signal: sig });
    root.addEventListener('drop', (e) => this._onDrop(e), { signal: sig });

    // 键盘
    window.addEventListener('keydown', (e) => this._onKeyDown(e), { signal: sig });
    window.addEventListener('keyup', (e) => this._onKeyUp(e), { signal: sig });
    window.addEventListener('blur', () => {
      this._spaceDown = false;
      this.root.classList.remove('bp-space');
    }, { signal: sig });

    // 粘贴
    document.addEventListener('paste', (e) => this._onPaste(e), { signal: sig });

    // 关闭/切走页面前尽量落盘：IndexedDB 是异步的，先同步写一份兜底快照
    const flush = () => {
      // 外部持久化模式不做任何本地存储兜底（外壳自己处理保存）
      if (this._persistence !== 'auto') return;
      if (this._saveDirty) this._writeEmergency();
      this.flushSave().catch(() => {});
    };
    window.addEventListener('beforeunload', flush, { signal: sig });
    window.addEventListener('pagehide', flush, { signal: sig });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    }, { signal: sig });

    // 点空白处 / 别的控件时收起「排列」菜单
    document.addEventListener('pointerdown', (e) => {
      if (!this.arrangeMenu || this.arrangeMenu.hidden) return;
      const t = e.target;
      if (this.arrangeMenu.contains(t) || (this.arrangeBtn && this.arrangeBtn.contains(t))) return;
      this._closeArrangeMenu();
    }, { signal: sig });
  }

  _isEditable(t) {
    if (!t || typeof t !== 'object' || t.nodeType !== 1) return false;
    const tag = t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return t.isContentEditable === true;
  }

  _localPoint(e) {
    const r = this.root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  screenToWorld(sx, sy) {
    const s = this._view.scale;
    return { x: (sx - this._view.x) / s, y: (sy - this._view.y) / s };
  }

  worldToScreen(wx, wy) {
    const s = this._view.scale;
    return { x: wx * s + this._view.x, y: wy * s + this._view.y };
  }

  /* ---------------------- 视图 ---------------------- */

  _measure() {
    const r = this.root.getBoundingClientRect();
    this.w = Math.max(0, r.width);
    this.h = Math.max(0, r.height);
  }

  _syncCanvas() {
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    this.dpr = dpr;
    const bw = Math.max(1, Math.round(this.w * dpr));
    const bh = Math.max(1, Math.round(this.h * dpr));
    for (const cv of [this.gridCanvas, this.inkCanvas]) {
      if (!cv) continue;
      if (cv.width !== bw) cv.width = bw;
      if (cv.height !== bh) cv.height = bh;
    }
  }

  _onResize() {
    if (this._destroyed) return;
    const pw = this.w;
    const ph = this.h;
    this._measure();
    if (this.w <= 0 || this.h <= 0) {
      // 宿主被折叠：不画不崩，等下次尺寸恢复
      this._syncCanvas();
      return;
    }
    if (Math.abs(pw - this.w) > 0.5 || Math.abs(ph - this.h) > 0.5) this._syncCanvas();
    this._applyView();
  }

  _applyView() {
    if (this._destroyed || !this.itemsEl) return;
    const { x, y, scale } = this._view;
    this.itemsEl.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    // 角标 / 边框 / 圆角等用 1/scale 反缩放，保证屏幕尺寸恒定
    this.itemsEl.style.setProperty('--bp-inv', String(1 / scale));
    this._drawGrid();
    this.drawInk();
    this.renderSelection();
    if (this.zoomEl) this.zoomEl.textContent = Math.round(scale * 100) + '%';
  }

  panBy(dx, dy) {
    this._view.x += dx;
    this._view.y += dy;
    this._viewTouched = true;
    this._applyView();
    this.scheduleSave();
  }

  zoomBy(factor, anchor) {
    const a = anchor || { x: this.w / 2, y: this.h / 2 };
    const next = clamp(this._view.scale * factor, MIN_SCALE, MAX_SCALE);
    if (Math.abs(next - this._view.scale) < 1e-6) return;
    const wp = this.screenToWorld(a.x, a.y);
    this._view.scale = next;
    this._view.x = a.x - wp.x * next;
    this._view.y = a.y - wp.y * next;
    this._viewTouched = true;
    this._applyView();
    this.scheduleSave();
  }

  zoomTo(scale) {
    const target = clamp(finite(scale, 1), MIN_SCALE, MAX_SCALE);
    this.zoomBy(target / this._view.scale);
  }

  _fitRect(box, pad = 60, maxScale = 2) {
    if (!box || !this.w || !this.h) return;
    const bw = Math.max(1, box.w);
    const bh = Math.max(1, box.h);
    const s = clamp(
      Math.min((this.w - pad * 2) / bw, (this.h - pad * 2) / bh),
      MIN_SCALE,
      Math.min(MAX_SCALE, maxScale),
    );
    this._view.scale = s;
    this._view.x = (this.w - bw * s) / 2 - box.x * s;
    this._view.y = (this.h - bh * s) / 2 - box.y * s;
  }

  /* ---------------------- 绘制 ---------------------- */

  _drawGrid() {
    const cv = this.gridCanvas;
    const ctx = this.gridCtx;
    if (!cv || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (this.w <= 0 || this.h <= 0) return;

    const s = this._view.scale;
    const tx = this._view.x;
    const ty = this._view.y;
    // 缩得太小 → 网格淡出（纸张仍要画）
    const alpha = clamp((s - 0.12) / 0.3, 0, 1);
    if (alpha > 0.01) {
    let step = GRID_BASE;
    while (step * s < 16) step *= 2;
    while (step * s > 110 && step > 8) step /= 2;

    const w0 = -tx / s, h0 = -ty / s;
    const w1 = (this.w - tx) / s, h1 = (this.h - ty) / s;
    const x0 = Math.floor(w0 / step) * step;
    const y0 = Math.floor(h0 / step) * step;
    let cols = Math.ceil((w1 - x0) / step) + 1;
    let rows = Math.ceil((h1 - y0) / step) + 1;
    while (cols * rows > 26000) { step *= 2; cols = Math.ceil((w1 - x0) / step) + 2; rows = Math.ceil((h1 - y0) / step) + 2; }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const rMinor = 1.05;
    const rMajor = 1.7;

    // 次要点
    ctx.fillStyle = `rgba(31,35,41,${(0.14 * alpha).toFixed(3)})`;
    ctx.beginPath();
    for (let ix = 0; ix < cols; ix++) {
      const wx = x0 + ix * step;
      const sx = wx * s + tx;
      if (sx < -4 || sx > this.w + 4) continue;
      const gx = Math.round(wx / step);
      for (let iy = 0; iy < rows; iy++) {
        const wy = y0 + iy * step;
        const sy = wy * s + ty;
        if (sy < -4 || sy > this.h + 4) continue;
        if (gx % 5 === 0 && Math.round(wy / step) % 5 === 0) continue;
        ctx.moveTo(sx + rMinor, sy);
        ctx.arc(sx, sy, rMinor, 0, TAU);
      }
    }
    ctx.fill();

    // 每 5 格一个稍大的点
    ctx.fillStyle = `rgba(31,35,41,${(0.22 * alpha).toFixed(3)})`;
    ctx.beginPath();
    for (let ix = 0; ix < cols; ix++) {
      const wx = x0 + ix * step;
      const gx = Math.round(wx / step);
      if (gx % 5 !== 0) continue;
      const sx = wx * s + tx;
      if (sx < -4 || sx > this.w + 4) continue;
      for (let iy = 0; iy < rows; iy++) {
        const wy = y0 + iy * step;
        if (Math.round(wy / step) % 5 !== 0) continue;
        const sy = wy * s + ty;
        if (sy < -4 || sy > this.h + 4) continue;
        ctx.moveTo(sx + rMajor, sy);
        ctx.arc(sx, sy, rMajor, 0, TAU);
      }
    }
    ctx.fill();
    }

    // A4 纸张画在点阵之上：页面内是白底，页面外保留点阵
    if (this._pageMode === 'a4') this._drawPagesOnGrid(ctx);
  }

  /** 在网格层上绘制 A4 纸张（白底 + 淡阴影 + 页码，当前页边框加深） */
  _drawPagesOnGrid(ctx) {
    if (!ctx) return;
    const s = this._view.scale;
    const tx = this._view.x;
    const ty = this._view.y;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const pages = this.pageRects();
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const x = p.x * s + tx;
      const y = p.y * s + ty;
      const w = p.w * s;
      const h = p.h * s;
      if (x > this.w + 40 || y > this.h + 40 || x + w < -40 || y + h < -40) continue;
      // 淡阴影
      ctx.fillStyle = 'rgba(31,35,41,0.09)';
      ctx.fillRect(x + 4, y + 6, w, h);
      // 纸张白底
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, y, w, h);
      // 边框（当前页加深）
      const cur = i === this._curPage;
      ctx.strokeStyle = cur ? 'rgba(47,109,246,0.85)' : 'rgba(31,35,41,0.22)';
      ctx.lineWidth = cur ? 2 : 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
      // 页码标签
      ctx.fillStyle = cur ? 'rgba(47,109,246,0.95)' : 'rgba(31,35,41,0.38)';
      const fs = clamp(Math.round(12 * Math.min(1.4, Math.max(0.8, s))), 9, 18);
      ctx.font = `${fs}px ${FONT_STACK}`;
      ctx.fillText(`第 ${i + 1} 页`, x + 8, y - 4);
    }
    ctx.restore();
  }

  drawInk() {
    const cv = this.inkCanvas;
    const ctx = this.inkCtx;
    if (!cv || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (this.w <= 0 || this.h <= 0) return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this._view.x, this._view.y);
    ctx.scale(this._view.scale, this._view.scale);
    for (const it of this._sortedItems()) {
      if (it.type !== 'stroke') continue;
      this._drawStrokeCtx(ctx, it);
    }
  }

  _pathStroke(ctx, pts) {
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 1) return;
    if (pts.length === 2) {
      ctx.lineTo(pts[1].x, pts[1].y);
      return;
    }
    // 二次曲线平滑：以相邻点中点为端点
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  _drawStrokeCtx(ctx, st) {
    const pts = this._strokePoints(st);
    if (!pts || !pts.length) return;
    const w = Math.max(0.5, finite(st.width, 2.6));
    ctx.save();
    ctx.globalAlpha = clamp(finite(st.opacity, 1), 0.02, 1);
    ctx.strokeStyle = st.color || PEN_COLOR;
    ctx.fillStyle = st.color || PEN_COLOR;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, w / 2, 0, TAU);
      ctx.fill();
    } else {
      ctx.beginPath();
      this._pathStroke(ctx, pts);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawTextCtx(ctx, it) {
    const text = it.text || '';
    if (!text) return;
    const fs = clamp(finite(it.fontSize, 18), 6, 400);
    const lineH = fs * 1.5;
    ctx.save();
    ctx.font = `${fs}px ${FONT_STACK}`;
    ctx.fillStyle = it.color || TEXT_COLOR;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const lines = wrapLines((str) => ctx.measureText(str).width, text, Math.max(20, Math.round(finite(it.w, 300))));
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      ctx.fillText(line, it.x, it.y + lineH * i + lineH / 2);
    }
    ctx.restore();
  }

  /* ---------------------- 元素渲染 ---------------------- */

  _sortedItems() {
    return this.items.slice().sort((a, b) => {
      const za = finite(a.z, 0);
      const zb = finite(b.z, 0);
      if (za !== zb) return za - zb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  /* ---------------------- 思维导图连线（connector） ---------------------- */

  /** 连线端点：从元素中心沿目标方向走到矩形边框，再外扩 CONNECTOR_MARGIN */
  _connectorGeom(it) {
    if (!it || it.kind !== 'connector') return null;
    const a = this.get(it.fromId);
    const b = this.get(it.toId);
    if (!a || !b || a.type === 'stroke' || b.type === 'stroke') return null;
    const ba = this._itemBBox(a);
    const bb = this._itemBBox(b);
    const ca = { x: ba.x + ba.w / 2, y: ba.y + ba.h / 2 };
    const cb = { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
    const dx = cb.x - ca.x;
    const dy = cb.y - ca.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return null;
    const ux = dx / len;
    const uy = dy / len;
    // 中心 → 矩形边框的射线距离（沿 ±u 方向）
    const edgeDist = (hw, hh) => {
      const ex = Math.abs(ux) < 1e-6 ? Infinity : hw / Math.abs(ux);
      const ey = Math.abs(uy) < 1e-6 ? Infinity : hh / Math.abs(uy);
      return Math.min(ex, ey);
    };
    const ta = edgeDist(ba.w / 2, ba.h / 2) + CONNECTOR_MARGIN;
    const tb = edgeDist(bb.w / 2, bb.h / 2) + CONNECTOR_MARGIN;
    const start = { x: ca.x + ux * ta, y: ca.y + uy * ta };
    const end = { x: cb.x - ux * tb, y: cb.y - uy * tb };
    const span = Math.hypot(end.x - start.x, end.y - start.y);
    if (span < 2) return null;
    // 二次贝塞尔：控制点在中点沿法线偏移一点点，形成柔和弧线
    const nx = -uy;
    const ny = ux;
    const bend = Math.min(52, span * 0.12);
    const cx = (start.x + end.x) / 2 + nx * bend;
    const cy = (start.y + end.y) / 2 + ny * bend;
    const steps = Math.round(clamp(span / 10, 8, 48));
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      points.push({
        x: mt * mt * start.x + 2 * mt * t * cx + t * t * end.x,
        y: mt * mt * start.y + 2 * mt * t * cy + t * t * end.y,
      });
    }
    return { points, bbox: strokeBBox(points, finite(it.width, CONNECTOR_WIDTH)) };
  }

  /** 笔画/连线的点集（连线现算） */
  _strokePoints(it) {
    if (!it) return [];
    if (it.kind === 'connector') {
      const g = this._connectorGeom(it);
      return g ? g.points : [];
    }
    return it.points || [];
  }

  /** 新建一条连线（z 放到所有笔画之下、元素之上） */
  _makeConnector(fromId, toId) {
    return {
      id: uid(),
      type: 'stroke',
      kind: 'connector',
      z: this._minZ() - 1,
      fromId,
      toId,
      color: CONNECTOR_COLOR,
      width: CONNECTOR_WIDTH,
      opacity: 1,
      tool: 'connector',
    };
  }

  /** 清理端点已不存在的连线（悬空自愈） */
  _pruneConnectors() {
    const elems = new Set(this.items.filter((it) => it.type !== 'stroke').map((it) => it.id));
    const before = this.items.length;
    this.items = this.items.filter((it) => it.kind !== 'connector'
      || (elems.has(it.fromId) && elems.has(it.toId) && it.fromId !== it.toId));
    return this.items.length !== before;
  }

  _itemBBox(it) {
    if (!it) return { x: 0, y: 0, w: 0, h: 0 };
    if (it.type === 'stroke') {
      if (it.kind === 'connector') {
        const g = this._connectorGeom(it);
        return g ? g.bbox : { x: 0, y: 0, w: 0, h: 0 };
      }
      return it.bbox || strokeBBox(it.points, it.width);
    }
    if (it.type === 'text') {
      // 文字高度：模型 h（已按真实排版测量）与 DOM 实测取较大者，
      // 这样命中测试 / 框选 / 导出包围盒都不会因为多行文字而偏小。
      const el = this._els.get(it.id);
      const lh = Math.ceil(finite(it.fontSize, 18) * 1.5);
      const domH = el && this.editingId !== it.id ? (el.offsetHeight || 0) : 0;
      return {
        x: it.x,
        y: it.y,
        w: Math.max(4, it.w),
        h: Math.max(lh, finite(domH, 0), finite(it.h, 0)),
      };
    }
    return { x: it.x, y: it.y, w: Math.max(1, it.w), h: Math.max(1, it.h) };
  }

  contentBBox() {
    if (!this.items.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of this.items) {
      const b = this._itemBBox(it);
      if (!b) continue;
      // 导出时文字是按 canvas 折行绘制的：包围盒把绘制高度/最宽行也算进去，
      // 避免裁掉最后一行或最宽的一行。
      let bw = b.w;
      let bh = b.h;
      if (it.type === 'text') {
        const m = this._textMetrics(it);
        if (m.h > bh) bh = m.h;
        if (m.width > bw) bw = m.width;
      }
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + bw);
      y1 = Math.max(y1, b.y + bh);
    }
    if (!Number.isFinite(x0)) return null;
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  _renderAll() {
    if (this._destroyed || !this.itemsEl) return;
    // 防御性清理端点已不存在的连线（悬空自愈）
    this._pruneConnectors();
    const frag = document.createDocumentFragment();
    this._els = new Map();
    for (const it of this._sortedItems()) {
      if (it.type === 'stroke') continue;      // 笔画走 canvas，不生成 DOM
      const el = this._createEl(it);
      this._els.set(it.id, el);
      frag.appendChild(el);
    }
    this.itemsEl.replaceChildren(frag);
    this._updateEmptyHint();
    this.drawInk();
    this.renderSelection();
  }

  /** 空板提示的显隐：自动恢复还没结束前先不显示，避免「先闪一下空板」 */
  _updateEmptyHint() {
    if (!this.emptyEl) return;
    const waitingRestore = !this._dbReady && !this._touched;
    this.emptyEl.hidden = this.items.length > 0 || waitingRestore;
    this._syncArrangeBtn();
  }

  _createEl(it) {
    const el = ce('div', 'bp-item bp-item-' + it.type);
    el.dataset.id = it.id;
    el.style.left = Math.round(it.x) + 'px';
    el.style.top = Math.round(it.y) + 'px';

    if (it.type === 'image') {
      el.style.width = Math.round(it.w) + 'px';
      el.style.height = Math.round(it.h) + 'px';
      const img = ce('img', 'bp-img');
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      img.addEventListener('load', () => {
        if (!it._fitOnLoad) return;
        it._fitOnLoad = false;
        const nw = img.naturalWidth || 0;
        const nh = img.naturalHeight || 0;
        if (!(nw > 0 && nh > 0)) return;
        const kk = Math.min(1, 900 / Math.max(nw, nh));
        it.w = Math.max(20, Math.round(nw * kk));
        it.h = Math.max(15, Math.round(nh * kk));
        it.naturalW = nw;
        it.naturalH = nh;
        this._syncItem(it);
        this.renderSelection();
      });
      img.addEventListener('error', () => { el.classList.add('bp-broken'); }, { once: true });
      img.src = it.src;
      el.appendChild(img);
      if (it.page) el.appendChild(ce('span', 'bp-badge', 'P' + it.page));
    } else if (it.type === 'text') {
      el.style.width = Math.round(it.w) + 'px';
      el.style.minHeight = Math.round(it.h) + 'px';
      el.style.fontSize = Math.round(it.fontSize) + 'px';
      el.style.color = it.color || TEXT_COLOR;
      el.textContent = it.text || '';
    }
    return el;
  }

  _syncItem(it) {
    const el = this._els.get(it.id);
    if (!el) return;
    el.style.left = Math.round(it.x) + 'px';
    el.style.top = Math.round(it.y) + 'px';
    if (it.type === 'text') {
      el.style.width = Math.round(it.w) + 'px';
      el.style.minHeight = Math.round(it.h) + 'px';
      if (this.editingId !== it.id && el.textContent !== (it.text || '')) el.textContent = it.text || '';
      el.style.fontSize = Math.round(it.fontSize) + 'px';
    } else {
      el.style.width = Math.round(it.w) + 'px';
      el.style.height = Math.round(it.h) + 'px';
    }
  }

  /* ---------------------- 选中态 UI ---------------------- */

  _screenRect(it) {
    const b = this._itemBBox(it);
    const s = this._view.scale;
    return {
      left: b.x * s + this._view.x,
      top: b.y * s + this._view.y,
      width: b.w * s,
      height: b.h * s,
    };
  }

  renderSelection() {
    if (this._destroyed) return;
    const layer = this.uiSel;
    if (!layer) return;
    if (this.editingId || !this.selected.size) {
      layer.replaceChildren();
      if (this.selbar) this.selbar.hidden = true;
      return;
    }
    const rects = [];
    for (const id of this.selected) {
      const it = this.get(id);
      if (it) rects.push(this._screenRect(it));
    }
    if (!rects.length) {
      layer.replaceChildren();
      if (this.selbar) this.selbar.hidden = true;
      return;
    }

    const nodes = [];
    if (rects.length === 1) {
      const r = rects[0];
      const box = ce('div', 'bp-sel-box');
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = Math.max(1, r.width) + 'px';
      box.style.height = Math.max(1, r.height) + 'px';
      nodes.push(box);
      const it = this.get([...this.selected][0]);
      if (it && it.type !== 'stroke') {
        for (const corner of ['nw', 'ne', 'sw', 'se']) nodes.push(this._makeHandle(corner, r));
      }
    } else {
      const u = unionRects(rects);
      const box = ce('div', 'bp-sel-box bp-sel-group');
      box.style.left = u.left + 'px';
      box.style.top = u.top + 'px';
      box.style.width = Math.max(1, u.width) + 'px';
      box.style.height = Math.max(1, u.height) + 'px';
      nodes.push(box);
    }
    layer.replaceChildren(...nodes);
    this._positionSelbar(rects);
  }

  _makeHandle(corner, r) {
    const h = document.createElement('div');
    h.className = 'bp-handle';
    h.dataset.corner = corner;
    const x = corner.includes('w') ? r.left : r.left + r.width;
    const y = corner.includes('n') ? r.top : r.top + r.height;
    h.style.left = (x - 5) + 'px';
    h.style.top = (y - 5) + 'px';
    h.style.cursor = (corner === 'nw' || corner === 'se') ? 'nwse-resize' : 'nesw-resize';
    h.addEventListener('pointerdown', (e) => this._startResize(e, corner));
    return h;
  }

  _positionSelbar(rects) {
    if (!this.selbar || !rects.length) return;
    const u = unionRects(rects);
    const BAR_W = 94;
    const BAR_H = 34;
    let left = u.left + u.width / 2 - BAR_W / 2;
    left = clamp(left, 8, Math.max(8, this.w - BAR_W - 8));
    let top = u.top - BAR_H - 10;
    if (top < 8) top = u.top + u.height + 10;
    if (top + BAR_H > this.h - 8) top = Math.max(8, u.top - BAR_H - 10);
    this.selbar.style.left = Math.round(left) + 'px';
    this.selbar.style.top = Math.round(top) + 'px';
    this.selbar.hidden = false;
  }

  setSelection(ids) {
    const next = new Set();
    for (const id of ids || []) if (this.get(id)) next.add(id);
    this.selected = next;
    this.renderSelection();
  }

  selectAll() {
    // 与框选保持一致：思维导图连线（connector）不参与批量选中，
    // 否则 Ctrl+A 之后改颜色/删除会连带处理这些结构性的灰色连线。
    this.setSelection(this.items.filter((it) => it.kind !== 'connector').map((it) => it.id));
  }

  _setMarquee(left, top, width, height) {
    if (!this.marqueeEl) return;
    if (width < 1 && height < 1) { this.marqueeEl.hidden = true; return; }
    this.marqueeEl.hidden = false;
    this.marqueeEl.style.left = Math.round(left) + 'px';
    this.marqueeEl.style.top = Math.round(top) + 'px';
    this.marqueeEl.style.width = Math.round(width) + 'px';
    this.marqueeEl.style.height = Math.round(height) + 'px';
  }

  /* ---------------------- 命中测试 ---------------------- */

  get(id) {
    for (const it of this.items) if (it.id === id) return it;
    return null;
  }

  hitTest(wx, wy) {
    // 命中优先级：元素（图片/文字）> 普通笔画 > 思维导图连线
    const elems = [];
    const strokes = [];
    const links = [];
    for (const it of this.items) {
      if (it.type !== 'stroke') elems.push(it);
      else if (it.kind === 'connector') links.push(it);
      else strokes.push(it);
    }
    const byZ = (a, b) => finite(b.z, 0) - finite(a.z, 0);
    elems.sort(byZ);
    for (const it of elems) {
      if (pointInRect(wx, wy, this._itemBBox(it))) return it;
    }
    const extra = 2 / this._view.scale;
    strokes.sort(byZ);
    for (const it of strokes) {
      if (this._hitStroke(it, wx, wy, extra)) return it;
    }
    links.sort(byZ);
    for (const it of links) {
      if (this._hitStroke(it, wx, wy, extra)) return it;
    }
    return null;
  }

  /**
   * 只按元素（图片/文字）命中的最上层 id；用于判断笔画归属父元素。
   * 传 world 坐标；没命中返回 null。
   */
  _elementIdAtPoint(wx, wy) {
    const elems = this.items.filter((it) => it.type !== 'stroke');
    elems.sort((a, b) => finite(b.z, 0) - finite(a.z, 0));
    for (const it of elems) {
      if (pointInRect(wx, wy, this._itemBBox(it))) return it.id;
    }
    return null;
  }

  /** 只按笔画命中（Alt+点击优先选笔画用），z 从高到低 */
  _hitStrokeAt(wx, wy) {
    const strokes = this.items.filter((it) => it.type === 'stroke');
    strokes.sort((a, b) => finite(b.z, 0) - finite(a.z, 0));
    const extra = 2 / this._view.scale;
    for (const it of strokes) {
      if (this._hitStroke(it, wx, wy, extra)) return it;
    }
    return null;
  }

  _hitStroke(it, wx, wy, extra = 0) {
    const pts = this._strokePoints(it);
    if (!pts || !pts.length) return false;
    const tol = Math.max(1, finite(it.width, 2) / 2) + extra;
    if (pts.length === 1) return Math.hypot(wx - pts[0].x, wy - pts[0].y) <= tol;
    for (let i = 0; i < pts.length - 1; i++) {
      if (distToSegment(wx, wy, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= tol) return true;
    }
    return false;
  }
  /* ---------------------- 指针交互 ---------------------- */

  _onPointerDown(e) {
    if (this._destroyed) return;
    const t = e.target;
    if (t && t.closest && (t.closest('.bp-toolbar') || t.closest('.bp-selbar') || t.closest('.bp-menu') || t.closest('.bp-pagebar'))) return;

    // 文字编辑中：点到编辑区内部就让浏览器处理光标；点到别处先提交
    if (this.editingId) {
      const edEl = this._els.get(this.editingId);
      if (edEl && (edEl === t || edEl.contains(t))) return;
      this.commitEdit();
    }

    // 平移：中键 / 右键
    if (e.button === 1 || e.button === 2) {
      this._startPan(e);
      return;
    }
    if (e.button !== 0) return;

    // 缩放角手柄（优先，避免被元素拖动吃掉）
    const handle = t && t.closest ? t.closest('.bp-handle') : null;
    if (handle) { this._startResize(e, handle.dataset.corner); return; }

    // 空格 + 左键 = 平移
    if (this._spaceDown) { this._startPan(e); return; }

    this._active = true;
    try { this.root.focus({ preventScroll: true }); } catch { /* ignore */ }

    const p = this._localPoint(e);
    const wp = this.screenToWorld(p.x, p.y);
    let hit = this.hitTest(wp.x, wp.y);
    // Alt + 点击：优先选笔画（普通点击仍元素优先，保证点图片选中图片）。
    // 这样用户可以在图片上"特地选中"某条批注，拖动时它会解绑成独立元素。
    if (this.tool === 'select' && e.altKey) {
      const strokeHit = this._hitStrokeAt(wp.x, wp.y);
      if (strokeHit) hit = strokeHit;
    }

    // 非选择工具按到已有元素：只提示一次（空白处按下不提示，仍按原工具工作）
    if (hit && hit.type !== 'stroke') this._hintToolOnElement();

    // A4 模式：点某页的空白处 → 该页成为当前页（点到元素则正常选中，不改页）
    if (this._pageMode === 'a4' && !hit && this.tool === 'select') {
      const pages = this.pageRects();
      for (let i = 0; i < pages.length; i++) {
        if (i !== this._curPage && pointInRect(wp.x, wp.y, pages[i])) { this.setCurPage(i, { reveal: false }); break; }
      }
    }

    if (this.tool === 'pen' || this.tool === 'highlighter') {
      this._startStroke(e, wp);
      return;
    }
    if (this.tool === 'eraser') {
      this._startErase(e, wp);
      return;
    }
    if (this.tool === 'text') {
      if (hit && hit.type === 'text') this.beginEditText(hit.id);
      else if (hit) this.setSelection([hit.id]);
      else this.createTextAt(wp.x, wp.y);
      return;
    }

    // 选择工具
    if (hit) {
      const already = this.selected.has(hit.id);
      if (e.shiftKey) {
        if (already) {
          const next = [...this.selected].filter((id) => id !== hit.id);
          this.setSelection(next);
          return;
        }
        this.setSelection([...this.selected, hit.id]);
      } else if (!already) {
        this.setSelection([hit.id]);
      }
      this._startMove(e, wp);
      return;
    }

    if (!e.shiftKey) this.setSelection([]);
    this._startMarquee(e, wp, e.shiftKey);
  }

  _onDoubleClick(e) {
    if (this._destroyed) return;
    const t = e.target;
    if (t && t.closest && (t.closest('.bp-toolbar') || t.closest('.bp-selbar') || t.closest('.bp-menu') || t.closest('.bp-pagebar'))) return;
    if (this.tool === 'pen' || this.tool === 'highlighter' || this.tool === 'eraser') return;

    const p = this._localPoint(e);
    const wp = this.screenToWorld(p.x, p.y);
    const itemEl = t && t.closest ? t.closest('[data-id]') : null;
    if (itemEl) {
      const it = this.get(itemEl.dataset.id);
      if (!it) return;
      if (it.type === 'text') this.beginEditText(it.id);
      else this.setSelection([it.id]);
      return;
    }
    if (this.editingId) return;
    this.createTextAt(wp.x, wp.y);
  }

  _startPan(e) {
    e.preventDefault();
    const p0 = this._localPoint(e);
    const v0 = { x: this._view.x, y: this._view.y };
    this.root.classList.add('bp-panning');
    this._dragListeners({
      move: (ev) => {
        const p = this._localPoint(ev);
        this._view.x = v0.x + (p.x - p0.x);
        this._view.y = v0.y + (p.y - p0.y);
        this._applyView();
      },
      end: () => {
        this.root.classList.remove('bp-panning');
        this.scheduleSave();
      },
    });
  }

  _dragListeners(hooks) {
    const onMove = (ev) => { hooks.move(ev); };
    const onEnd = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      if (hooks.end) hooks.end(ev);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  }

  _startMove(e, startWorld) {
    const snap = this.snapshot();
    const selectedItems = [...this.selected].map((id) => this.get(id)).filter(Boolean);
    if (!selectedItems.length) return;
    const selectedIds = new Set(selectedItems.map((it) => it.id));

    // 需要移动的：选中的元素 + 它们的子笔画（子笔画自己也被选中时不重复）。
    // 思维导图连线不参与移动（端点随元素重算，拖动连线直接忽略）。
    const items = selectedItems.filter((it) => it.kind !== 'connector');
    for (const parent of selectedItems) {
      if (parent.type === 'stroke') continue;
      for (const it of this.items) {
        if (it.type === 'stroke' && it.parentId === parent.id && !selectedIds.has(it.id)) items.push(it);
      }
    }
    if (!items.length) return;

    const starts = items.map((it) => (it.type === 'stroke'
      ? { points: it.points.map((p) => ({ x: p.x, y: p.y })), bbox: { ...it.bbox } }
      : { x: it.x, y: it.y }));

    // 用户"特地选中了笔画"（父元素不在选中集里）→ 第一次真正移动时解绑，
    // 之后它就变成独立元素，想再绑回去可以撤销（snap 在解绑之前拍的）。
    const unbind = selectedItems.filter((it) => it.type === 'stroke' && it.parentId && !selectedIds.has(it.parentId));
    let unbound = false;
    let moved = false;
    this.root.classList.add('bp-moving');

    this._dragListeners({
      move: (ev) => {
        const p = this._localPoint(ev);
        const w = this.screenToWorld(p.x, p.y);
        const dx = w.x - startWorld.x;
        const dy = w.y - startWorld.y;
        if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) moved = true;
        if (moved && unbind.length && !unbound) {
          unbound = true;
          for (const st of unbind) st.parentId = null;
        }
        let hasStroke = false;
        items.forEach((it, i) => {
          const s = starts[i];
          if (it.type === 'stroke') {
            hasStroke = true;
            it.points = s.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
            it.bbox = { x: s.bbox.x + dx, y: s.bbox.y + dy, w: s.bbox.w, h: s.bbox.h };
          } else {
            it.x = Math.round(s.x + dx);
            it.y = Math.round(s.y + dy);
            this._syncItem(it);
          }
        });
        if (hasStroke) this.drawInk();
        this.renderSelection();
      },
      end: () => {
        this.root.classList.remove('bp-moving');
        if (moved) {
          this._pushEntry(snap, 'move');
          this._markDirty();
        }
      },
    });
  }

  _startMarquee(e, startWorld, additive) {
    const base = additive ? new Set(this.selected) : new Set();
    const start = { x: startWorld.x, y: startWorld.y };
    this._setMarquee(0, 0, 0, 0);

    this._dragListeners({
      move: (ev) => {
        const p = this._localPoint(ev);
        const w = this.screenToWorld(p.x, p.y);
        const rect = {
          x: Math.min(start.x, w.x),
          y: Math.min(start.y, w.y),
          w: Math.abs(w.x - start.x),
          h: Math.abs(w.y - start.y),
        };
        const s = this._view.scale;
        this._setMarquee(rect.x * s + this._view.x, rect.y * s + this._view.y, rect.w * s, rect.h * s);
        const next = new Set(base);
        for (const it of this.items) {
          if (it.kind === 'connector') continue;    // 连线不参与框选（斜线 bbox 太大易误选）
          if (!rectsIntersect(rect, this._itemBBox(it))) continue;
          next.add(it.id);
        }
        this.setSelection([...next]);
      },
      end: () => {
        this._setMarquee(0, 0, 0, 0);
        this.marqueeEl.hidden = true;
      },
    });
  }

  _startResize(e, corner) {
    e.preventDefault();
    e.stopPropagation();
    if (!corner) return;
    const ids = [...this.selected];
    if (ids.length !== 1) return;
    const it = this.get(ids[0]);
    if (!it || it.type === 'stroke') return;

    const snap = this.snapshot();
    const start = { x: it.x, y: it.y, w: it.w, h: it.h };
    const anchorX = corner.includes('w') ? start.x + start.w : start.x;
    const anchorY = corner.includes('n') ? start.y + start.h : start.y;

    // 父元素缩放时，子笔画跟着按比例变换（点坐标相对父元素缩放，线宽取 sx/sy 较小值）
    const children = this.items
      .filter((c) => c.type === 'stroke' && c.parentId === it.id)
      .map((c) => ({ item: c, points: c.points.map((p) => ({ x: p.x, y: p.y })), width: c.width }));

    this._dragListeners({
      move: (ev) => {
        const p = this._localPoint(ev);
        const w = this.screenToWorld(p.x, p.y);
        let nw = Math.max(1, Math.abs(w.x - anchorX));
        let nh = Math.max(1, Math.abs(w.y - anchorY));
        if (it.type === 'image' && ev.shiftKey) {
          const ar = start.w / Math.max(1, start.h);
          if (nw / Math.max(1, nh) > ar) nh = nw / ar;
          else nw = nh * ar;
        }
        const minW = it.type === 'text' ? 60 : 24;
        const minH = it.type === 'text' ? Math.ceil(it.fontSize * 1.2) : 24;
        nw = Math.max(minW, nw);
        nh = Math.max(minH, nh);
        const nx = corner.includes('w') ? anchorX - nw : anchorX;
        const ny = corner.includes('n') ? anchorY - nh : anchorY;
        it.w = Math.round(nw);
        it.h = Math.round(nh);
        it.x = Math.round(nx);
        it.y = Math.round(ny);
        this._syncItem(it);
        if (children.length) {
          const sx = it.w / Math.max(1, start.w);
          const sy = it.h / Math.max(1, start.h);
          const sw = Math.min(sx, sy);
          for (const ch of children) {
            const c = ch.item;
            c.points = ch.points.map((pt) => ({
              x: it.x + (pt.x - start.x) * sx,
              y: it.y + (pt.y - start.y) * sy,
            }));
            c.width = Math.max(0.5, ch.width * sw);
            c.bbox = strokeBBox(c.points, c.width);
          }
          this.drawInk();
        }
        this.renderSelection();
      },
      end: () => {
        if (Math.round(it.w) !== Math.round(start.w) || Math.round(it.h) !== Math.round(start.h)
          || Math.round(it.x) !== Math.round(start.x) || Math.round(it.y) !== Math.round(start.y)) {
          this._pushEntry(snap, 'resize');
          this._markDirty();
        }
      },
    });
  }

  _startErase(e, startWorld) {
    const snap = this.snapshot();
    const removed = new Set();
    const eraseAt = (wp) => {
      const extra = 8 / this._view.scale;
      let changed = false;
      for (const it of this.items) {
        if (it.type !== 'stroke' || removed.has(it.id)) continue;
        if (this._hitStroke(it, wp.x, wp.y, extra)) {
          removed.add(it.id);
          changed = true;
        }
      }
      if (changed) {
        this.items = this.items.filter((it) => !removed.has(it.id));
        const ids = new Set(this.items.map((it) => it.id));
        this.selected = new Set([...this.selected].filter((id) => ids.has(id)));
        this.drawInk();
        this._updateEmptyHint();
        this.renderSelection();
      }
    };
    eraseAt(startWorld);

    this._dragListeners({
      move: (ev) => {
        const p = this._localPoint(ev);
        eraseAt(this.screenToWorld(p.x, p.y));
      },
      end: () => {
        if (removed.size) {
          this._pushEntry(snap, 'erase');
          this._markDirty();
        }
      },
    });
  }

  _startStroke(e, startWorld) {
    const snap = this.snapshot();
    const tool = this.tool;
    const isHl = tool === 'highlighter';
    const st = {
      id: uid(),
      type: 'stroke',
      z: this._nextZ(),
      points: [{ x: startWorld.x, y: startWorld.y }],
      color: isHl ? this._hlColor : this._penColor,
      width: isHl ? 18 : 2.6,
      opacity: isHl ? HIGHLIGHT_OPACITY : 1,
      tool: isHl ? 'highlighter' : 'pen',
      parentId: null,
      bbox: strokeBBox([{ x: startWorld.x, y: startWorld.y }], isHl ? 18 : 2.6),
    };
    this.items.push(st);
    this._updateEmptyHint();
    this.drawInk();

    const minStep = 1.2 / this._view.scale;
    this._dragListeners({
      move: (ev) => {
        const p = this._localPoint(ev);
        const w = this.screenToWorld(p.x, p.y);
        const last = st.points[st.points.length - 1];
        if (Math.hypot(w.x - last.x, w.y - last.y) < minStep) return;
        st.points.push({ x: w.x, y: w.y });
        st.bbox = strokeBBox(st.points, st.width);
        this.drawInk();
      },
      end: () => {
        st.bbox = strokeBBox(st.points, st.width);
        // 归属判定：笔画 bbox 中心点命中的最上层图片/文字 → 之后父元素移动/缩放/删除时跟着走
        st.parentId = this._elementIdAtPoint(st.bbox.x + st.bbox.w / 2, st.bbox.y + st.bbox.h / 2);
        this._pushEntry(snap, 'stroke');
        this._markDirty();
      },
    });
  }

  _onWheel(e) {
    if (this._destroyed || this.w <= 0 || this.h <= 0) return;
    e.preventDefault();
    const mode = e.deltaMode;
    const rawX = finite(e.deltaX, 0);
    const rawY = finite(e.deltaY, 0);
    const dy = mode === 1 ? rawY * 16 : mode === 2 ? rawY * this.h : rawY;
    const dx = mode === 1 ? rawX * 16 : mode === 2 ? rawX * this.w : rawX;

    if (e.ctrlKey || e.metaKey) {
      const p = this._localPoint(e);
      this.zoomBy(Math.exp(-dy * 0.0018), p);       // 以光标为中心缩放
      return;
    }
    if (e.shiftKey) {
      this.panBy(-(dx || dy), dx ? -dy : 0);        // Shift+滚轮 → 左右平移
      return;
    }
    this.panBy(-dx, -dy);
  }

  /* ---------------------- 文字编辑 ---------------------- */

  _measureTextWidth(text, fontSize) {
    if (!this._measureCanvas) {
      this._measureCanvas = document.createElement('canvas');
    }
    const ctx = this._measureCanvas.getContext('2d');
    if (!ctx) return 0;
    ctx.font = `${fontSize}px ${FONT_STACK}`;
    return ctx.measureText(String(text)).width;
  }

  /**
   * 测量一段文本在给定宽度下的真实排版高度。
   * 优先用「隐藏 DOM 探针」——和画布上文字元素完全同一套样式/字体/行高，
   * 折行结果与渲染结果一致（含 CJK 逐字折行、英文按空格折行、显式换行）。
   * 探针拿不到布局时（无 DOM 布局的测试环境）退回 canvas 逐字测量。
   * @returns {{h:number, lines:number}} h 为像素高度（世界坐标同单位）
   */
  _measureTextBlock(text, fontSize, width) {
    const fs = clamp(finite(fontSize, 18), 6, 400);
    const lineH = fs * 1.5;
    // 与 DOM 渲染一致：元素宽度用的是 Math.round(it.w)
    const w = Math.max(20, Math.round(finite(width, 300)));
    const str = text == null ? '' : String(text);

    if (typeof document !== 'undefined' && document.body && typeof document.createElement === 'function') {
      let probe = null;
      try {
        probe = document.createElement('div');
        probe.className = 'bp-item-text bp-text-probe';
        probe.textContent = str;
        probe.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;'
          + 'pointer-events:none;margin:0;padding:0;border:0;min-height:0;height:auto;'
          + `box-sizing:border-box;width:${w}px;font-size:${fs}px;line-height:1.5;`
          + `font-family:${FONT_STACK};white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;`;
        document.body.appendChild(probe);
        const rect = typeof probe.getBoundingClientRect === 'function' ? probe.getBoundingClientRect() : null;
        const hgt = rect && rect.height > 0 ? rect.height : (probe.offsetHeight || 0);
        if (hgt > 0) {
          const lines = Math.max(1, Math.round(hgt / lineH));
          return { h: Math.ceil(hgt), lines };
        }
      } catch {
        /* 探针失败 → 走 canvas 估算 */
      } finally {
        if (probe) {
          try { probe.remove(); } catch { /* ignore */ }
        }
      }
    }

    // 退化路径：canvas 逐字测量 + 同一套折行算法
    const lines = Math.max(1, wrapLines((s) => this._measureTextWidth(s, fs), str, w).length);
    return { h: Math.ceil(lines * lineH), lines };
  }

  /** 导出/包围盒用：按 canvas 折行算出的文字绘制尺寸（高度 + 最宽行） */
  _textMetrics(it) {
    const fs = clamp(finite(it.fontSize, 18), 6, 400);
    const lineH = fs * 1.5;
    const maxW = Math.max(20, Math.round(finite(it.w, 300)));
    const lines = wrapLines((s) => this._measureTextWidth(s, fs), it.text || '', maxW);
    let width = 0;
    for (const line of lines) {
      const w = line ? this._measureTextWidth(line, fs) : 0;
      if (w > width) width = w;
    }
    return { lineH, lines, h: Math.max(1, lines.length) * lineH, width };
  }

  /** 文本的「自然宽度」：不折行时最长一行的宽度（显式换行按最长行算） */
  _naturalTextWidth(text, fontSize) {
    const fs = clamp(finite(fontSize, 18), 6, 400);
    const lines = String(text == null ? '' : text).split('\n');
    let max = 0;
    for (const line of lines) {
      const w = this._measureTextWidth(line, fs);
      if (w > max) max = w;
    }
    return max;
  }

  /**
   * 文字提交后的宽度策略（世界坐标）：
   * - 内容自然宽度 > maxWidth → 收敛到 maxWidth，按该宽度折行（长批注不会横着冲出可视区）；
   * - 内容较窄 → 按内容收紧（改短后 w 能变小）；
   * - 其余情况保持原宽度。
   * maxWidth 默认 460；addText 显式传入 {w} 时允许放宽到调用方给的宽度。
   * 返回值永远在 [40, maxWidth] 内。
   */
  _fitTextWidth(text, fontSize, currentW, maxWidth = MAX_TEXT_WIDTH) {
    const cap = clamp(finite(maxWidth, MAX_TEXT_WIDTH), MIN_TEXT_WIDTH, 4000);
    const cur = clamp(finite(currentW, 300), MIN_TEXT_WIDTH, cap);
    const natural = this._naturalTextWidth(text, fontSize);
    let w = cur;
    if (natural > cap) {
      w = cap;
    } else if (natural > 0 && natural + 10 < cur - 12) {
      w = Math.ceil(natural) + 10;
    }
    return clamp(w, MIN_TEXT_WIDTH, cap);
  }

  createTextAt(worldX, worldY) {
    if (this.editingId) this.commitEdit();
    const fs = 18;
    const it = {
      id: uid(),
      type: 'text',
      x: Math.round(worldX),
      y: Math.round(worldY - fs * 0.9),
      w: 300,
      h: Math.ceil(fs * 1.5),
      z: this._nextZ(),
      text: '',
      fontSize: fs,
      color: TEXT_COLOR,
    };
    this._record('add');
    this.items.push(it);
    this._renderAll();
    this.beginEditText(it.id, { isNew: true });
    return it;
  }

  beginEditText(id, opts = {}) {
    if (this._destroyed) return;
    const it = this.get(id);
    if (!it || it.type !== 'text') return;
    if (this.editingId === id) return;
    if (this.editingId) this.commitEdit();
    const el = this._els.get(id);
    if (!el) return;

    this._editSnap = opts.isNew ? null : this.snapshot();
    this._editOriginal = it.text || '';
    this._editIsNew = !!opts.isNew;
    this.editingId = id;
    this._editEl = el;

    this.selected.clear();
    this.renderSelection();

    el.classList.add('bp-editing');
    el.setAttribute('contenteditable', 'true');
    el.spellcheck = false;
    el.addEventListener('blur', this._onEditBlur);
    el.addEventListener('paste', this._onEditPaste);

    try {
      el.focus({ preventScroll: true });
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch { /* 光标定位失败不影响提交 */ }
  }

  _finishEditState() {
    const el = this._editEl;
    this.editingId = null;
    this._editEl = null;
    this._editIsNew = false;
    this._editSnap = null;
    if (el) {
      el.removeEventListener('blur', this._onEditBlur);
      el.removeEventListener('paste', this._onEditPaste);
      el.classList.remove('bp-editing');
      el.removeAttribute('contenteditable');
    }
    return el;
  }

  _cancelEditNoCommit() {
    this._finishEditState();
  }

  commitEdit() {
    if (!this.editingId) return;
    const id = this.editingId;
    const el = this._editEl;
    const it = this.get(id);
    const text = normalizeText(el ? el.innerText : '');
    const before = this._editOriginal;
    const wasNew = this._editIsNew;
    const snap = this._editSnap;

    this._finishEditState();
    if (!it) return;

    if (!text) {
      // 空内容 → 自动删除（原有文字的清空操作也要可撤销）
      if (!wasNew && snap) this._pushEntry(snap, 'text');
      this.items = this.items.filter((x) => x.id !== id);
      if (wasNew) this._dropLastAddEntry();
      this.selected.delete(id);
      this._renderAll();
      this.scheduleSave();
      return;
    }

    if (text !== before && !wasNew && snap) this._pushEntry(snap, 'text');
    it.text = text;

    // 宽度策略（新建 / 编辑后统一）：
    //   内容自然宽度 > 460 → 收到 460 按该宽度折行；
    //   内容较窄 → 按内容收紧（改短后能变小）；
    //   其它情况保持原宽度（改长但没超过 460 时按现有宽度折行）。
    let w = it.w;
    if (wasNew || text !== before) w = this._fitTextWidth(text, it.fontSize, w);
    w = Math.min(Math.max(MIN_TEXT_WIDTH, w), MAX_TEXT_WIDTH);

    // 提交后按最终宽度重新测量排版高度（多行 / 折行都要对）
    const block = this._measureTextBlock(text, it.fontSize, w);
    it.w = w;
    it.h = Math.max(Math.ceil(it.fontSize * 1.5), Math.round(block.h));

    this._renderAll();
    this.setSelection([id]);
    // 长批注收敛后仍可能顶到视口边缘 → 只平移视图把它完整露出来（不改 scale）
    this._revealRect(this._itemBBox(it));
    this._markDirty();
  }

  cancelEdit() {
    if (!this.editingId) return;
    const id = this.editingId;
    const wasNew = this._editIsNew;
    const original = this._editOriginal;
    this._finishEditState();
    const it = this.get(id);
    if (!it) return;
    if (wasNew) {
      this.items = this.items.filter((x) => x.id !== id);
      this._dropLastAddEntry();
      this.selected.clear();
    } else {
      it.text = original;
    }
    this._renderAll();
    this.scheduleSave();
  }

  _onEditBlur = () => {
    if (this.editingId) this.commitEdit();
  };

  _onEditPaste = (e) => {
    // 编辑态只接受纯文本，避免粘进 HTML 结构
    const dt = e.clipboardData;
    if (!dt) return;
    const txt = dt.getData('text/plain');
    if (!txt) return;
    e.preventDefault();
    e.stopPropagation();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(txt);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  /* ---------------------- 键盘 ---------------------- */

  _onKeyDown(e) {
    if (this._destroyed) return;
    if (e.isComposing || e.keyCode === 229) return;      // 中文输入法组词中

    // 编辑态：只拦 Enter / Esc，其余交给 contenteditable（不抢按键）
    if (this.editingId) {
      const el = this._editEl;
      const inEditor = el && (e.target === el || el.contains(e.target));
      if (!inEditor) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.cancelEdit();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        this.commitEdit();
      }
      return;
    }

    if (this._isEditable(e.target)) return;

    // 只处理「焦点在白板内」的按键：不抢 PDF 侧的方向键/翻页键
    const inRoot = e.target === this.root || this.root.contains(e.target);
    if (!inRoot) return;

    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const lower = typeof key === 'string' ? key.toLowerCase() : '';

    if (mod) {
      if (lower === 'a') { e.preventDefault(); this.selectAll(); return; }
      if (lower === 'd') { e.preventDefault(); this.duplicateSelection(); return; }
      if (lower === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo(); else this.undo();
        return;
      }
      if (lower === 'y') { e.preventDefault(); this.redo(); return; }
      if (key === ']' || key === '}') { e.preventDefault(); this.bringToFront([...this.selected]); return; }
      if (key === '[' || key === '{') { e.preventDefault(); this.sendToBack([...this.selected]); return; }
      return;      // Ctrl+V 交给 paste 事件
    }

    // 空格：进入「平移待命」状态
    if (e.code === 'Space' || key === ' ') {
      if (!this._spaceDown) {
        this._spaceDown = true;
        this.root.classList.add('bp-space');
      }
      e.preventDefault();
      return;
    }

    if (this._spaceDown) return;

    // 1-6 切换笔迹颜色（选中笔画时直接改色）
    if (key && key.length === 1 && key >= '1' && key <= '6') {
      const color = PALETTE_COLORS[Number(key) - 1];
      if (color) {
        e.preventDefault();
        this._applyColor(color);
        return;
      }
    }

    switch (key) {
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        this.deleteSelection();
        return;
      case 'Escape':
        e.preventDefault();
        if (this.arrangeMenu && !this.arrangeMenu.hidden) { this._closeArrangeMenu({ restoreFocus: true }); return; }
        this._onEscape();
        return;
      case 'ArrowLeft':
        e.preventDefault();
        this._nudge(-(e.shiftKey ? 10 : 1), 0);
        return;
      case 'ArrowRight':
        e.preventDefault();
        this._nudge(e.shiftKey ? 10 : 1, 0);
        return;
      case 'ArrowUp':
        e.preventDefault();
        this._nudge(0, -(e.shiftKey ? 10 : 1));
        return;
      case 'ArrowDown':
        e.preventDefault();
        this._nudge(0, e.shiftKey ? 10 : 1);
        return;
      default:
        break;
    }

    if (key && key.length === 1) {
      const map = { v: 'select', p: 'pen', h: 'highlighter', e: 'eraser', t: 'text' };
      const tool = map[lower];
      if (tool) { e.preventDefault(); this.setTool(tool); }
    }
  }

  _onKeyUp(e) {
    if (e.code === 'Space') {
      this._spaceDown = false;
      this.root.classList.remove('bp-space');
    }
  }

  _onEscape() {
    if (this.editingId) { this.cancelEdit(); return; }
    if (this._spaceDown) {
      this._spaceDown = false;
      this.root.classList.remove('bp-space');
    }
    this.marqueeEl.hidden = true;
    if (this.tool !== 'select') { this.setTool('select'); return; }
    if (this.selected.size) { this.setSelection([]); return; }
    this.root.blur();
  }

  /* ---------------------- 拖放图片 ---------------------- */

  _onDragOver(e) {
    const dt = e.dataTransfer;
    if (!dt) return;
    const files = Array.from(dt.files || []);
    const items = Array.from(dt.items || []).filter((x) => x.kind === 'file');
    const types = files.length ? files.map((f) => f.type) : items.map((x) => x.type);
    const allImage = types.length > 0 && types.every((ty) => /^image\//.test(ty || ''));
    if (!allImage) return;                     // 非图片交给外壳（PDF 拖放）
    e.preventDefault();
    e.stopPropagation();
    dt.dropEffect = 'copy';
  }

  _onDrop(e) {
    const dt = e.dataTransfer;
    if (!dt) return;
    const all = Array.from(dt.files || []);
    const images = all.filter((f) => /^image\//.test(f.type || ''));
    if (!images.length) return;                // 不是图片 → 不拦，让外壳处理 PDF / JSON
    // 只阻止浏览器直接打开文件；不 stopPropagation：
    // 外壳的 drop 处理会自行识别「图片掉在白板上」并收起拖放遮罩。
    e.preventDefault();
    const p = this._localPoint(e);
    const wp = this.screenToWorld(p.x, p.y);
    images.forEach((f, i) => this._addImageFile(f, wp.x + i * 24, wp.y + i * 24));
  }

  _addImageFile(file, worldX, worldY) {
    const reader = new FileReader();
    reader.onload = () => {
      if (this._destroyed) return;
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl) return;
      const probe = new Image();
      probe.onload = () => {
        if (this._destroyed) return;
        const nw = probe.naturalWidth || 0;
        const nh = probe.naturalHeight || 0;
        if (!(nw > 0 && nh > 0)) { this._toast('无法读取该图片文件'); return; }
        // 大图限制到 640 世界像素以内，落点居中在鼠标处
        const dpr = Math.max(1, Math.max(nw, nh) / 640);
        const ww = nw / dpr;
        const wh = nh / dpr;
        this.addClip({ dataUrl, width: nw, height: nh, dpr, page: 0 }, {
          center: false,
          x: worldX - ww / 2,
          y: worldY - wh / 2,
        });
      };
      probe.onerror = () => {
        if (this._destroyed) return;
        this._toast('无法读取该图片文件');
      };
      probe.src = dataUrl;
    };
    reader.onerror = () => { this._toast('无法读取该图片文件'); };
    reader.readAsDataURL(file);
  }

  /* ---------------------- 粘贴 ---------------------- */

  async _onPaste(e) {
    if (this._destroyed) return;
    if (this.editingId) return;                             // 编辑态让浏览器粘贴文字
    const t = e.target;
    const inBoard = t === this.root || (t && this.root.contains && this.root.contains(t));
    if (!inBoard && !this._active) return;                  // 焦点在 PDF 侧不处理
    // 白板里没有别的可编辑目标，直接吃掉默认粘贴，避免后续异步判断失效
    e.preventDefault();

    // 1) paste 事件自带的图片（最可靠，无需权限）
    let clip = null;
    const dt = e.clipboardData;
    if (dt) {
      const items = Array.from(dt.items || []);
      const imgItem = items.find((x) => x.kind === 'file' && /^image\//.test(x.type || ''));
      if (imgItem) {
        const file = imgItem.getAsFile();
        if (file) clip = await this._clipFromBlob(file);
      }
      if (!clip) {
        const f = Array.from(dt.files || []).find((x) => /^image\//.test(x.type || ''));
        if (f) clip = await this._clipFromBlob(f);
      }
    }
    if (clip) {
      e.preventDefault();
      this.addClip(clip, { center: true });
      return;
    }

    // 2) 异步读系统剪贴板（可能因权限失败）
    if (!clip && navigator.clipboard && typeof navigator.clipboard.read === 'function') {
      try {
        const list = await navigator.clipboard.read();
        for (const entry of list) {
          const type = (entry.types || []).find((ty) => /^image\//.test(ty));
          if (!type) continue;
          const blob = await entry.getType(type);
          clip = await this._clipFromBlob(blob);
          if (clip) break;
        }
      } catch {
        clip = null;                                        // 权限/非图片 → 静默回退
      }
    }
    if (clip) {
      e.preventDefault();
      this.addClip(clip, { center: true });
      return;
    }

    // 3) 回退：PDF 内部剪贴板（最近一次框选）
    let fallback = null;
    try { fallback = this.opts.getFallbackClip ? this.opts.getFallbackClip() : null; } catch { fallback = null; }
    if (fallback && (fallback.dataUrl || fallback.src)) {
      e.preventDefault();
      this.addClip(fallback, { center: true });
      return;
    }

    this._toast('剪贴板里没有图片，先在左侧框选一块再按 Ctrl+V');
  }

  async _clipFromBlob(blob) {
    if (!blob || !/^image\//.test(blob.type || '')) return null;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(typeof r.result === 'string' ? r.result : '');
        r.onerror = () => reject(new Error('read error'));
        r.readAsDataURL(blob);
      });
      if (!dataUrl) return null;
      const size = await this._probeImage(dataUrl);
      if (!size) return null;
      const maxDim = Math.max(size.w, size.h) || 1;
      const dpr = Math.max(1, maxDim / 900);              // 系统图片过大时缩到 ≤900 世界像素
      return { dataUrl, width: size.w, height: size.h, dpr, page: 0, text: '' };
    } catch {
      return null;
    }
  }

  _probeImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  /* ---------------------- 历史 / 持久化 ---------------------- */

  snapshot() {
    return { items: this.items.map(cloneItem) };
  }

  _now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  /** 记录变更前的状态（快照）；相同 kind 在时间窗内合并，避免方向键刷爆撤销栈 */
  _record(kind, coalesceMs) {
    const now = this._now();
    const last = this.history[this.history.length - 1];
    if (coalesceMs && last && last.kind === kind && now - (last.t || 0) < coalesceMs) {
      last.t = now;
      this.redoStack.length = 0;
      this._markDirty();
      return;
    }
    this._pushEntry(this.snapshot(), kind);
  }

  _pushEntry(snap, kind) {
    if (!snap) return;
    this.history.push({ snap, kind, t: this._now() });
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.redoStack.length = 0;
    this._markDirty();
  }

  _dropLastAddEntry() {
    const last = this.history[this.history.length - 1];
    if (last && last.kind === 'add') this.history.pop();
  }

  _restoreSnapshot(snap) {
    if (!snap) return;
    this.items = snap.items.map(cloneItem);
    const ids = new Set(this.items.map((it) => it.id));
    this.selected = new Set([...this.selected].filter((id) => ids.has(id)));
    this._renderAll();
    this._markDirty();
  }

  _markDirty() {
    this._touched = true;
    this.scheduleSave();
  }

  scheduleSave() {
    if (this._destroyed) return;
    // 任何可能改变 toJSON() 的操作都会走到这里 → 通知外部（服务器模式靠它落盘）
    this._scheduleChange();
    if (this._persistence !== 'auto') return;      // 'off'：不写本地存储
    this._saveDirty = true;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._setIndicator('保存中…', '');
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      // 不 await：内部已串行化 + 自行兜错
      this.saveNow().catch(() => {});
    }, SAVE_DELAY);
  }

  /* ---------------------- 外部变更通知（onChange） ---------------------- */

  /** 500ms 防抖后把最新 doc 交给外壳（loadJSON / 构造期恢复不会走到这里） */
  _scheduleChange() {
    if (this._destroyed || this._suppressChange || !this._onChange) return;
    if (this._changeTimer) clearTimeout(this._changeTimer);
    this._changeTimer = setTimeout(() => {
      this._changeTimer = null;
      if (this._destroyed || !this._onChange) return;
      let doc = null;
      try { doc = this.toJSON(); } catch { doc = null; }
      try {
        if (doc) this._onChange(doc);
        else this._onChange();
      } catch { /* 外壳回调异常不影响白板 */ }
    }, SAVE_DELAY);
  }

  /**
   * 把当前状态标记为「已保存」的基准：清掉待触发的 onChange / 自动保存，
   * 并（auto 模式下）把状态文字置为「已保存」。供外壳切换白板后调用。
   */
  markClean() {
    this._saveDirty = false;
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (this._changeTimer) { clearTimeout(this._changeTimer); this._changeTimer = null; }
    this._setIndicator('已保存', '');
  }

  /**
   * 由外壳主动更新顶部「已保存」状态文字（服务器模式/外部持久化下外壳负责保存，
   * 用它把「保存中… / 已保存 / 保存失败」回写到白板工具栏）。
   * 不受 persistence 模式限制。
   */
  setSavedState(text, state = '') {
    this._saveIndicator = typeof text === 'string' ? text : '';
    if (!this.savedEl) return;
    if (this.savedEl.textContent !== this._saveIndicator) {
      this.savedEl.textContent = this._saveIndicator;
    }
    this.savedEl.dataset.state = state || '';
  }

  /**
   * 立即落盘（异步）。
   * 主路径 IndexedDB；IDB 不可用或写失败时退回 localStorage。
   * 多次调用按调用顺序串行执行，避免连续操作时旧数据后写覆盖新数据。
   * @returns {Promise<boolean>} 是否成功保存
   */
  saveNow() {
    this._pendingSaves = (this._pendingSaves || 0) + 1;
    const run = () => this._saveNowInner();
    const next = this._saveChain.then(run, run);
    this._saveChain = next.then(() => {}, () => {});
    const settlePending = () => { this._pendingSaves = Math.max(0, (this._pendingSaves || 1) - 1); };
    next.then(settlePending, settlePending);
    return next;
  }

  /** 取消防抖并等待落盘（测试 / destroy / 页面隐藏时用） */
  flushSave() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    return this.saveNow();
  }

  /** 等待启动时的自动恢复流程结束（异步 IndexedDB 用） */
  ready() {
    return this._readyPromise;
  }

  async _saveNowInner() {
    // 外部持久化模式：完全不写本地存储，由外壳通过 onChange 自己保存
    if (this._persistence !== 'auto') return true;
    // 存储路径还没定下来（IDB 正在打开）→ 等一等，避免先把数据写进降级路径
    if (!this._dbReady) {
      try { await this._readyPromise; } catch { /* ignore */ }
    }
    const seq = ++this._saveSeq;
    const data = this.toJSON();

    const done = () => {
      if (seq === this._saveSeq) this._setIndicator('已保存', '');
      // 没有排队中的写入、也没有待触发的防抖 → 才认为「全部落盘」
      const idle = !this._saveTimer && (this._pendingSaves || 0) <= 1;
      if (idle) {
        this._saveDirty = false;
        this._clearEmergency();
      }
    };

    if (this._db) {
      try {
        await idbPut(this._db, data);
        done();
        this._clearLegacy();                 // IDB 已成为权威存储，旧 LS 备份作废
        return true;
      } catch {
        // IDB 写失败（配额 / 事务中断）→ 尽量退回 localStorage 保住数据
        if (this._saveLegacy(data)) {
          done();
          return true;
        }
        this._failSave();
        return false;
      }
    }

    if (this._saveLegacy(data)) {
      done();
      return true;
    }
    this._failSave();
    return false;
  }

  /**
   * 降级路径：localStorage（受 5MB 限制）。
   * 400 万字符预检只在这一层生效；IndexedDB 路径不做任何体积限制。
   */
  _saveLegacy(data) {
    if (this._approxSize() > 4_000_000) return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  }

  /** 估算持久化体积（字符数），只做量级判断（仅 localStorage 降级路径用） */
  _approxSize() {
    let n = 64;
    for (const it of this.items) {
      if (it.type === 'image') n += (it.src ? it.src.length : 0) + 240;
      else if (it.type === 'text') n += (it.text ? it.text.length : 0) + 240;
      else n += (it.points ? it.points.length * 26 : 0) + 160;
    }
    return n;
  }

  _failSave() {
    this._saveIndicator = '保存失败';
    this._setIndicator('保存失败', 'error');
    const now = Date.now();
    if (!this._lastQuotaToast || now - this._lastQuotaToast > 8000) {
      this._lastQuotaToast = now;
      this._toast(STORAGE_WARN, 4200);
    }
  }

  _setIndicator(text, state) {
    this._saveIndicator = text;
    // 外部持久化模式：保存状态交给外壳控制（可选通过 setSavedState 回传）
    if (this._persistence !== 'auto') {
      if (typeof this.opts.setSavedState === 'function') {
        try { this.opts.setSavedState(text, state || ''); } catch { /* ignore */ }
      }
      return;
    }
    if (!this.savedEl) return;
    if (this.savedEl.textContent !== text) this.savedEl.textContent = text;
    this.savedEl.dataset.state = state || '';
  }

  /* ---------------------- 自动恢复 / 迁移 ---------------------- */

  async _startRestore() {
    try {
      await this._restoreInner();
    } catch {
      // 恢复链路的任何异常都不该影响白板继续使用
    } finally {
      this._dbReady = true;
      this._updateEmptyHint();
      // 鼠标悬停能看到当前用的存储路径（排查用）
      if (this.savedEl) {
        this.savedEl.title = this._storageMode === 'ls'
          ? '当前浏览器无法使用 IndexedDB，已降级为 localStorage（约 5MB 上限）'
          : '白板内容自动保存在本机浏览器（IndexedDB，容量大）';
      }
      if (!this._readyResolved) {
        this._readyResolved = true;
        if (this._resolveReady) this._resolveReady();
      }
    }
  }

  async _restoreInner() {
    let db = null;
    try {
      db = await idbOpen();
    } catch {
      db = null;
    }
    if (this._destroyed) {
      if (db) { try { db.close(); } catch { /* ignore */ } }
      return;
    }
    this._db = db || null;
    this._storageMode = db ? 'idb' : 'ls';
    this._dbReady = true;

    // 0) 上次关页面/被系统回收时留下的「未落盘快照」。
    //    它只在有改动没写完时才写入，所以一定不比主存储里的旧，优先用它。
    const emergency = this._readEmergency();
    if (emergency) {
      if (this._touched) {
        this._clearEmergency();              // 用户已经抢先操作 → 丢弃旧快照
        return;
      }
      this._applyRestored(emergency);
      const data = this.toJSON();
      let ok = false;
      if (db) {
        try { await idbPut(db, data); ok = true; } catch { ok = false; }
      } else {
        ok = this._saveLegacy(data);
      }
      if (ok) {
        this._clearEmergency();
        this._setIndicator('已保存', '');
      }
      return;
    }

    // 没有 IndexedDB → 全程走 localStorage 降级
    if (!db) {
      this._restoreFromLegacy();
      return;
    }

    let data;
    try {
      data = await idbGet(db);
    } catch {
      // IDB 读失败也视为不可用 → 整体降级到 localStorage
      this._db = null;
      this._storageMode = 'ls';
      this._restoreFromLegacy();
      return;
    }

    if (data) {
      this._clearLegacy();                    // IDB 有数据，旧 localStorage 备份作废
      if (this._applyRestored(data)) this._setIndicator('已保存', '');
      return;
    }

    // IDB 是空的 → 尝试把 localStorage 里的旧数据迁进来
    const legacy = this._readLegacy();
    if (!legacy) return;
    const applied = this._applyRestored(legacy);
    try {
      await idbPut(db, this.toJSON());
      this._clearLegacy();
      if (applied) this._setIndicator('已保存', '');
    } catch {
      // 迁移写入失败：保留 localStorage 作为降级，下次启动再试
    }
  }

  /**
   * 把恢复的数据应用到白板上。
   * 竞态保护：如果用户已经开始操作（或已有内容），放弃恢复，绝不覆盖。
   * @returns {boolean} 是否真的应用了
   */
  _applyRestored(data) {
    if (this._touched || this.items.length > 0) {
      const hasItems = Array.isArray(data && data.items) && data.items.length > 0;
      if (hasItems && !this._restoreSkipToasted) {
        this._restoreSkipToasted = true;
        this._toast('检测到加载期间的新操作，已跳过自动恢复', 3000);
      }
      return false;
    }
    let clean;
    try {
      clean = sanitizeData(data);
    } catch {
      return false;
    }
    if (!this._viewTouched) {
      this._view = { x: clean.view.x, y: clean.view.y, scale: clean.view.scale };
    }
    this.items = clean.items;
    this._pageMode = clean.pageMode;
    this._pageCount = clean.pageCount;
    this._curPage = clean.curPage;
    this.selected.clear();
    this._renderAll();
    this._applyView();
    this._syncPageUI();
    return true;
  }

  /** 读 localStorage 旧数据（坏 JSON 自动清掉并提示） */
  _readLegacy() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      raw = null;
    }
    if (!raw) return null;
    this._hasLegacy = true;
    try {
      return JSON.parse(raw);
    } catch {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      this._hasLegacy = false;
      this._toast('白板自动恢复失败，已重置');
      return null;
    }
  }

  /** 没有 IndexedDB 时的同步降级恢复 */
  _restoreFromLegacy() {
    const legacy = this._readLegacy();
    if (!legacy) return;
    if (this._applyRestored(legacy)) this._setIndicator('已保存', '');
  }

  _clearLegacy() {
    if (!this._hasLegacy) return;
    this._hasLegacy = false;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }

  /* -------- 关页面前的同步兜底快照（只写 localStorage，极端场景用） -------- */

  _writeEmergency() {
    // 外部持久化模式不写任何本地存储
    if (this._persistence !== 'auto') return;
    // localStorage 只有 ~5MB：内容太大就别浪费时间去序列化，直接交给 IDB 的异步写
    if (this._approxSize() > 2_000_000) return;
    try {
      localStorage.setItem(STORAGE_PENDING_KEY, JSON.stringify(this.toJSON()));
    } catch { /* 写不进去就依赖 IDB 那次异步写 */ }
  }

  _readEmergency() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_PENDING_KEY);
    } catch {
      raw = null;
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      this._clearEmergency();
      return null;
    }
  }

  _clearEmergency() {
    try { localStorage.removeItem(STORAGE_PENDING_KEY); } catch { /* ignore */ }
  }

  _applyData(raw) {
    const clean = sanitizeData(raw);
    this.items = clean.items;
    this._view = { x: clean.view.x, y: clean.view.y, scale: clean.view.scale };
    this._pageMode = clean.pageMode;
    this._pageCount = clean.pageCount;
    this._curPage = clean.curPage;
    return clean;
  }

  /* ---------------------- 操作命令 ---------------------- */

  setTool(tool) {
    if (!this.toolBtns || !this.toolBtns.has(tool)) return;
    if (this.editingId) this.commitEdit();
    this.tool = tool;
    this.root.dataset.tool = tool;
    for (const [id, btn] of this.toolBtns) btn.classList.toggle('bp-on', id === tool);
    if (tool !== 'select') this.setSelection([]);
    this._syncSwatches();
  }

  /**
   * 内容贴入成功后自动回到「选择」工具（贴完就能直接拖动），
   * 只由 addClip / addText（以及走它们的粘贴、拖入图片）调用，
   * 不干预用户主动切换工具。
   */
  _ensureSelectTool() {
    if (this.tool === 'select') return;
    this.setTool('select');
  }

  /**
   * 非选择工具（画笔/荧光笔/橡皮/文字）按到已有元素时提示一次，
   * 避免用户误以为"贴进来的图抓不动"。每种工具每次会话只提示一次。
   */
  _hintToolOnElement() {
    const labels = { pen: '画笔', highlighter: '荧光笔', eraser: '橡皮', text: '文字' };
    const label = labels[this.tool];
    if (!label) return;
    if (this._toolHints.has(this.tool)) return;
    this._toolHints.add(this.tool);
    const tail = '按 V 或点工具条左上箭头切回「选择」';
    let action = '拖动会在图上画线';
    if (this.tool === 'eraser') action = '在元素上拖动会擦除笔画';
    else if (this.tool === 'text') action = '在元素上点击/拖动不会移动它';
    this._toast(`当前是${label}工具，${action}；${tail}`, 3600);
  }

  /* ---------------------- 颜色板（画笔/荧光笔） ---------------------- */

  _loadColorPrefs() {
    const valid = (v) => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v);
    try {
      const pen = localStorage.getItem(COLOR_KEY_PEN);
      if (valid(pen)) this._penColor = pen;
      const hl = localStorage.getItem(COLOR_KEY_HL);
      if (valid(hl)) this._hlColor = hl;
    } catch { /* localStorage 不可用就用默认色 */ }
  }

  _saveColorPrefs() {
    try {
      localStorage.setItem(COLOR_KEY_PEN, this._penColor);
      localStorage.setItem(COLOR_KEY_HL, this._hlColor);
    } catch { /* ignore */ }
  }

  /** 当前工具对应的笔迹颜色（选择工具时按画笔色显示） */
  _currentColor() {
    return this.tool === 'highlighter' ? this._hlColor : this._penColor;
  }

  _syncSwatches() {
    if (!this.swatchBtns) return;
    const active = this._currentColor();
    for (const [color, btn] of this.swatchBtns) {
      btn.classList.toggle('bp-on', color.toLowerCase() === String(active).toLowerCase());
    }
  }

  /**
   * 选颜色：有选中笔画 → 直接改这些笔画的颜色（可撤销）；
   * 同时把颜色记到当前工具（画笔/荧光笔各自记忆）。
   */
  _applyColor(color) {
    if (typeof color !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(color)) return;
    const strokes = [...this.selected]
      .map((id) => this.get(id))
      .filter((it) => it && it.type === 'stroke');
    if (strokes.length) {
      this._record('color');
      for (const st of strokes) st.color = color;
      this._renderAll();
      this.scheduleSave();
    }
    if (this.tool === 'highlighter') this._hlColor = color;
    else this._penColor = color;
    this._saveColorPrefs();
    this._syncSwatches();
  }

  deleteSelection() {
    if (!this.selected.size) return;
    if (this.editingId) this.commitEdit();
    this._record('delete');
    // 删父元素时把归属它的笔画 / 两端相关的连线一起删掉（一次撤销可还原）
    const ids = new Set(this.selected);
    for (const id of this.selected) {
      const it = this.get(id);
      if (!it || it.type === 'stroke') continue;
      for (const c of this.items) {
        if (c.type === 'stroke' && c.parentId === id) ids.add(c.id);
        if (c.kind === 'connector' && (c.fromId === id || c.toId === id)) ids.add(c.id);
      }
    }
    this.items = this.items.filter((it) => !ids.has(it.id));
    this.selected.clear();
    this._renderAll();
    this.scheduleSave();
  }

  duplicateSelection() {
    const sel = [...this.selected];
    if (!sel.length) return;

    // 参与复制的：选中的元素 + 归属它们的子笔画（子笔画自己也被选中时不重复）
    const ids = [];
    const seen = new Set();
    const add = (id) => { if (!seen.has(id)) { seen.add(id); ids.push(id); } };
    for (const id of sel) {
      const selIt = this.get(id);
      if (selIt && selIt.kind === 'connector') continue;   // 连线不单独复制，随两端元素走
      add(id);
      const it = this.get(id);
      if (!it || it.type === 'stroke') continue;
      for (const c of this.items) {
        if (c.type === 'stroke' && c.parentId === id) add(c.id);
      }
    }
    if (!ids.length) return;      // 只选了连线：没有可复制的东西

    this._record('duplicate');
    const maxZ = this._maxZ();

    const idMap = new Map(ids.map((id) => [id, uid()]));
    const newIds = [];
    ids.forEach((id, i) => {
      const src = this.get(id);
      if (!src) return;
      const c = cloneItem(src);
      c.id = idMap.get(id);
      c.z = maxZ + 1 + i;
      if (c.type === 'stroke') {
        c.points = c.points.map((p) => ({ x: p.x + 16, y: p.y + 16 }));
        c.bbox = { x: c.bbox.x + 16, y: c.bbox.y + 16, w: c.bbox.w, h: c.bbox.h };
        // 子笔画指向复制出来的新父元素；父元素没一起复制则解绑
        c.parentId = src.parentId && idMap.has(src.parentId) ? idMap.get(src.parentId) : null;
      } else {
        c.x += 16;
        c.y += 16;
      }
      this.items.push(c);
      newIds.push(c.id);
    });
    // 连线：只有两端都被一起复制时，才为新副本建线（端点映射到新 id）
    const linkCopies = [];
    for (const it of this.items) {
      if (it.kind !== 'connector') continue;
      if (idMap.has(it.fromId) && idMap.has(it.toId)) linkCopies.push([idMap.get(it.fromId), idMap.get(it.toId)]);
    }
    for (const [fromId, toId] of linkCopies) this.items.push(this._makeConnector(fromId, toId));
    this._renderAll();
    this.setSelection(newIds);
    this.scheduleSave();
  }

  _nudge(dx, dy) {
    if (!this.selected.size) return;
    // 选中的元素 + 它们的子笔画一起挪（子笔画自己也被选中时不重复；连线不直接挪）
    const ids = new Set(this.selected);
    const moving = [...this.selected]
      .map((id) => this.get(id))
      .filter((it) => it && it.kind !== 'connector');
    if (!moving.length) return;
    this._record('nudge', 700);
    for (const it of moving) {
      if (it.type === 'stroke') continue;
      for (const c of this.items) {
        if (c.type === 'stroke' && c.parentId === it.id && !ids.has(c.id)) { ids.add(c.id); moving.push(c); }
      }
    }
    let hasStroke = false;
    for (const it of moving) {
      if (it.type === 'stroke') {
        hasStroke = true;
        it.points = it.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
        it.bbox = { x: it.bbox.x + dx, y: it.bbox.y + dy, w: it.bbox.w, h: it.bbox.h };
      } else {
        it.x += dx;
        it.y += dy;
        this._syncItem(it);
      }
    }
    if (hasStroke) this.drawInk();
    this.renderSelection();
    this.scheduleSave();
  }

  _maxZ() {
    let m = 0;
    for (const it of this.items) { const z = finite(it.z, 0); if (z > m) m = z; }
    return m;
  }

  _minZ() {
    let m = 0;
    for (const it of this.items) { const z = finite(it.z, 0); if (z < m) m = z; }
    return m;
  }

  _nextZ() {
    return this._maxZ() + 1;
  }

  bringToFront(ids) {
    const list = (ids && ids.length ? ids : [...this.selected]).filter((id) => this.get(id));
    if (!list.length) return;
    this._record('z');
    const maxZ = this._maxZ();
    list.forEach((id, i) => { const it = this.get(id); if (it) it.z = maxZ + 1 + i; });
    this._renderAll();
    this.scheduleSave();
  }

  sendToBack(ids) {
    const list = (ids && ids.length ? ids : [...this.selected]).filter((id) => this.get(id));
    if (!list.length) return;
    this._record('z');
    const minZ = this._minZ();
    const n = list.length;
    list.forEach((id, i) => { const it = this.get(id); if (it) it.z = minZ - n + i; });
    this._renderAll();
    this.scheduleSave();
  }

  _onClearClick() {
    if (this._clearTimer) { clearTimeout(this._clearTimer); this._clearTimer = null; }
    if (!this._clearArmed) {
      if (!this.items.length) { this._toast('白板已经是空的'); return; }
      this._clearArmed = true;
      this.clearBtn.classList.add('bp-danger-armed');
      this.clearBtn.classList.remove('icon');
      this.clearBtn.innerHTML = svgIcon(ICON.trash) + '<span>确认清空？</span>';
      this._clearTimer = setTimeout(() => this._resetClearBtn(), 3000);
      return;
    }
    this._resetClearBtn();
    this.clear();
  }

  _resetClearBtn() {
    if (this._clearTimer) { clearTimeout(this._clearTimer); this._clearTimer = null; }
    this._clearArmed = false;
    if (!this.clearBtn) return;
    this.clearBtn.classList.remove('bp-danger-armed');
    this.clearBtn.classList.add('icon');
    this.clearBtn.innerHTML = svgIcon(ICON.trash);
    this.clearBtn.title = '清空白板（需要点两次确认）';
  }

  /* ---------------------- 图片缓存 ---------------------- */

  _loadImage(src) {
    if (this._imgCache.has(src)) return Promise.resolve(this._imgCache.get(src));
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this._imgCache.set(src, img);
        if (this._imgCache.size > 40) {
          const first = this._imgCache.keys().next().value;
          this._imgCache.delete(first);
        }
        resolve(img);
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  /* ---------------------- 杂项 ---------------------- */

  _toast(msg, ms) {
    try {
      const fn = this.opts.toast;
      if (typeof fn === 'function') fn(msg, ms);
      else if (typeof window.toast === 'function') window.toast(msg, ms);
    } catch { /* 提示失败不影响功能 */ }
  }
}

/** 多个屏幕矩形求并集 */
function unionRects(rects) {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const x of rects) {
    if (x.left < l) l = x.left;
    if (x.top < t) t = x.top;
    if (x.left + x.width > r) r = x.left + x.width;
    if (x.top + x.height > b) b = x.top + x.height;
  }
  if (!Number.isFinite(l)) return { left: 0, top: 0, width: 0, height: 0 };
  return { left: l, top: t, width: Math.max(0, r - l), height: Math.max(0, b - t) };
}
