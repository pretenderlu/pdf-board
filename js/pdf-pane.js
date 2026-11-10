/* ============================================================
   pdf-pane.js — 左侧 PDF 阅读器（连续滚动 + 框选摘录）
   负责人：pdf-engine。契约见 SPEC.md §2 / §4.1 / §5 / §7。

   要点：
   - 纯 ES module + 原生 DOM，无构建、无外链资源
   - pdf.js 4.10.38 离线包（vendor/pdfjs），中文 PDF 必须带 cMap / 标准字体路径
   - 所有页先按尺寸占位，IntersectionObserver 懒渲染 canvas
   - 选区用「页面内相对比例 0..1」保存，缩放/滚动都能正确跟随
   - 裁切图用离屏 canvas 高倍渲染，dpr = 离屏倍率 / 当前视图缩放
   ============================================================ */
import * as pdfjsLib from '../vendor/pdfjs/build/pdf.mjs';

/* worker 与资源路径。
   注意：pdf.js 默认 useWorkerFetch=true，cMap / 标准字体是在 worker 里 fetch 的，
   相对路径会以 worker 脚本 URL 为基准解析（而不是页面 URL），所以这里统一用
   import.meta.url 解析成绝对 URL，保证中文 PDF 的 CMap 与标准字体能正确加载。 */
const VENDOR_PDFJS = new URL('../vendor/pdfjs/', import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('build/pdf.worker.mjs', VENDOR_PDFJS).href;
const CMAP_URL = new URL('cmaps/', VENDOR_PDFJS).href;
const STANDARD_FONTS_URL = new URL('standard_fonts/', VENDOR_PDFJS).href;

/* ---------------- 常量 ---------------- */
const MIN_SCALE = 0.1;              // 10%
const MAX_SCALE = 6;                // 600%
const ZOOM_STEP = 1.2;
const WHEEL_ZOOM_RATE = 0.00095;    // Ctrl+滚轮：deltaY=100 约 +10%，deltaY=120 约 +12%（8%~12% 区间）
const PAGE_PADDING = 16;            // 与 .pdfp-pages 的 padding 保持一致
const SCROLLBAR_RESERVE = 12;       // 适应宽度时预留纵向滚动条，避免出现横向滚动条
const PRELOAD_MARGIN = 700;         // 几何预渲染视口余量（px）
const IO_MARGIN = 800;              // IntersectionObserver 余量（px）
const MAX_RENDER_DPR = 2;           // 屏幕渲染的最高 DPR，避免超大画布
const MAX_RENDER_PIXELS = 12e6;     // 单页屏幕画布像素上限
const CROP_MAX_WIDTH = 4000;        // 裁切图整页像素宽上限（SPEC 要求）
const CROP_MAX_PIXELS = 26e6;       // 整页离屏画布像素上限（内存保险）
const MIN_SEL_PX = 5;               // 选区最小尺寸（CSS px），小于视为点击
const HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/* ---------------- 小工具 ---------------- */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const roundScale = (s) => Math.round(s * 100) / 100;
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 把 client 坐标换算成页面内相对比例（0..1），越界自动夹紧 */
function fracOf(clientX, clientY, rect) {
  const w = rect.width || 1;
  const h = rect.height || 1;
  return {
    x: clamp((clientX - rect.left) / w, 0, 1),
    y: clamp((clientY - rect.top) / h, 0, 1),
  };
}

/** 选区唯一键，用于判断异步裁切结果是否还属于当前选区 */
function selKey(sel) {
  if (!sel) return '';
  const f = (v) => v.toFixed(5);
  return `${sel.pageIdx}|${f(sel.x0)}|${f(sel.y0)}|${f(sel.x1)}|${f(sel.y1)}`;
}

/** canvas → PNG Blob（失败返回 null，不抛） */
function canvasToBlob(canvas) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob || null), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

/** 提取文本的清洗：去 NBSP、行尾空白、多余空行 */
function normalizeText(raw) {
  if (!raw) return '';
  const lines = raw
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 从 getTextContent() 结果里取出落在选区内（页面相对比例）的文字。
 * 用 pdfjs 的 viewport.transform 把每个 text item 的基线映射到「scale=1 的页面坐标」，
 * 再按 y（基线）聚行、按 x（水平间隔）决定空行 / 空格 / 直接拼接。
 * 扫描件没有任何 text item，返回 ''。
 */
function extractTextInRect(textContent, viewport, sel) {
  const items = textContent && Array.isArray(textContent.items) ? textContent.items : null;
  if (!items || !items.length) return '';

  const pageW = viewport.width;
  const pageH = viewport.height;
  if (!(pageW > 0) || !(pageH > 0)) return '';

  const rx0 = sel.x0 * pageW;
  const rx1 = sel.x1 * pageW;
  const ry0 = sel.y0 * pageH;
  const ry1 = sel.y1 * pageH;

  const hits = [];
  for (const item of items) {
    if (!item || typeof item.str !== 'string' || !item.str) continue;
    const tr = item.transform;
    if (!tr || tr.length !== 6) continue;

    let m;
    try {
      m = pdfjsLib.Util.transform(viewport.transform, tr);
    } catch {
      continue;
    }
    if (!m || !Number.isFinite(m[4]) || !Number.isFinite(m[5])) continue;

    // 字号（页面坐标系下的高度）
    const fontH = Math.hypot(m[2], m[3]) || Math.abs(Number(item.height) || 0) || 10;
    // 文本前进宽度（页面坐标系）；个别字体 item.width 为 0，用字数估一个兜底值
    const advW = Math.abs(Number(item.width) || 0) || fontH * Math.max(1, item.str.length) * 0.5;

    const bx0 = m[4];
    const bx1 = m[4] + advW;
    const by0 = m[5] - fontH * 0.88;   // 基线以上约 0.88em
    const by1 = m[5] + fontH * 0.3;    // 基线以下留一点下降部

    const ix = Math.min(bx1, rx1) - Math.max(bx0, rx0);
    const iy = Math.min(by1, ry1) - Math.max(by0, ry0);
    if (ix <= 0 || iy <= 0) continue;

    const area = Math.max(1e-6, (bx1 - bx0) * (by1 - by0));
    if ((ix * iy) / area < 0.35) continue;   // 重叠不足 35% 不算命中

    hits.push({ str: item.str, x: bx0, xEnd: bx1, y: m[5], fontH, hasEOL: !!item.hasEOL });
  }
  if (!hits.length) return '';

  hits.sort((a, b) => (Math.abs(a.y - b.y) > 0.01 ? a.y - b.y : a.x - b.x));

  // 按基线聚行（同一行容差取字号 0.6 倍）
  const lines = [];
  let cur = null;
  for (const it of hits) {
    const tol = Math.max(it.fontH, 4) * 0.6;
    if (cur && Math.abs(it.y - cur.y) <= tol) {
      cur.items.push(it);
    } else {
      cur = { y: it.y, items: [it] };
      lines.push(cur);
    }
    if (it.hasEOL) cur = null;   // pdf.js 标记了行尾，强制换行
  }

  const out = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    let str = '';
    let prev = null;
    for (const it of line.items) {
      if (prev) {
        const gap = it.x - prev.xEnd;
        const fh = Math.max(prev.fontH, it.fontH, 4);
        if (gap > fh * 2.2) {
          str += '\n';           // 间隔很大：多半是分栏 / 独立区块，换行
        } else if (gap > fh * 0.3 && /[A-Za-z0-9]$/.test(prev.str) && /^[A-Za-z0-9]/.test(it.str)) {
          str += ' ';            // 西文单词之间补空格
        }
      }
      str += it.str;
      prev = it;
    }
    out.push(str);
  }
  return normalizeText(out.join('\n'));
}

/* ---------------- 图标（内联 SVG，禁止外链） ---------------- */
const ICON = {
  prev:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 14.5l6-6 6 6"/></svg>',
  next:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9.5l6 6 6-6"/></svg>',
  minus:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>',
  plus:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  fit:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h18"/><path d="M7 8l-4 4 4 4"/><path d="M17 8l4 4-4 4"/></svg>',
  doc:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3h7l4 4v14h-11z"/><path d="M13.5 3v4h4"/><path d="M9 12h6M9 15.5h6M9 8.5h2.5"/></svg>',
  open:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z"/></svg>',
};

/* ============================================================
   PdfPane
   ============================================================ */
export class PdfPane {
  constructor(host, opts = {}) {
    if (!host) throw new Error('PdfPane 需要挂载元素');
    this.host = host;
    this.opts = opts && typeof opts === 'object' ? opts : {};
    this._toast =
      typeof this.opts.toast === 'function'
        ? this.opts.toast
        : (msg) => {
            try {
              window.toast?.(msg);
            } catch {
              /* 外壳 toast 可能还没就绪，忽略 */
            }
          };

    this._disposed = false;
    this._openToken = 0;          // 打开文档的令牌，防止并发 open 互相污染
    this._pdf = null;
    this._loadingTask = null;

    /* 页面数据 */
    this._pageEls = [];
    this._canvasEls = [];
    this._pageSizes = [];         // 每页 scale=1 的尺寸（含旋转）
    this._pageCss = [];           // 每页当前 CSS 尺寸
    this._tops = [];              // 每页相对 .pdfp-pages 的 offsetTop
    this._heights = [];
    this._renderedScale = [];
    this._renderSeq = [];
    this._tasks = [];
    this._visible = new Set();
    this._pageCache = new Map();
    this._textCache = new Map();

    this._currentPage = 1;
    this._scale = 1;
    this._fitMode = true;

    /* 选区 / 剪贴块 */
    this._sel = null;
    this._selEl = null;
    this._barEl = null;
    this._selAc = null;
    this._clip = null;
    this._clipBlob = null;
    this._clipKey = '';
    this._clipTask = null;
    this._clipSeq = 0;
    this._clipTimer = 0;
    this._drag = null;
    this._dragAc = null;

    /* 观察器 / 计时器 */
    this._io = null;
    this._ro = null;
    this._scrollRaf = 0;
    this._resizeTimer = 0;
    this._lastVpW = 0;
    this._lastVpH = 0;
    this._wheelRaf = 0;          // Ctrl+滚轮缩放的 rAF 句柄
    this._wheelAcc = null;       // 一帧内累积的 wheel 增量与光标位置
    this._renderIdleTimer = 0;   // 滚轮缩放停顿后补渲染的定时器

    this._abort = new AbortController();

    this._buildDom();
    this._bind();
    this._observe();
    this._updateToolbar();
  }

  /* ============================================================
     对外契约（SPEC §5）
     ============================================================ */

  get loaded() {
    return !!this._pdf;
  }

  get pageCount() {
    return this._pdf ? this._pdf.numPages : 0;
  }

  get currentPage() {
    return this._currentPage;
  }

  /** 当前缩放（1 = 100%）。供自动化验收 / 调试读取，无副作用 */
  get scale() {
    return this._scale;
  }

  async open(fileOrBuffer) {
    if (this._disposed) return false;
    const token = ++this._openToken;

    let data = null;
    try {
      data = await this._toBytes(fileOrBuffer);
    } catch {
      this._hideLoading();          // 可能还挂着上一次 open 的加载遮罩
      this._toast('打开失败：无法读取这个文件');
      return false;
    }
    if (!data || !data.byteLength) {
      this._hideLoading();
      this._toast('打开失败：文件是空的');
      return false;
    }

    this._showLoading('正在加载 PDF…', 0);

    let task = null;
    let replaced = false;      // 是否已经把旧文档换下来了（决定失败时要不要清理现场）
    try {
      task = pdfjsLib.getDocument({
        data,
        cMapUrl: CMAP_URL,
        cMapPacked: true,
        standardFontDataUrl: STANDARD_FONTS_URL,
      });
      task.onProgress = (p) => {
        if (token !== this._openToken || this._disposed) return;
        this._updateLoadingProgress(p);
      };
      const doc = await task.promise;

      if (token !== this._openToken || this._disposed) {
        // 已被更新的 open 取代；由那个 open 负责清理 loadingTask
        if (this._loadingTask !== task) {
          try {
            Promise.resolve(task.destroy()).catch(() => {});
          } catch {
            /* 忽略 */
          }
        }
        return false;
      }
      if (!doc.numPages) {
        this._hideLoading();
        this._toast('打开失败：这份 PDF 没有页面');
        try {
          Promise.resolve(task.destroy()).catch(() => {});
        } catch {
          /* 忽略 */
        }
        return false;
      }

      // 新文档确认可用后才替换旧文档：读取失败时保留原来那份
      const oldTask = this._loadingTask;
      const oldDoc = this._pdf;
      this._stripCurrentDoc();
      this._loadingTask = task;
      replaced = true;
      this._showLoading('正在加载 PDF…', 0);   // 换文档期间保持遮罩，避免露出空状态
      if (oldTask) {
        try {
          Promise.resolve(oldTask.destroy()).catch(() => {});
        } catch {
          /* 忽略 */
        }
      } else if (oldDoc) {
        try {
          Promise.resolve(oldDoc.destroy()).catch(() => {});
        } catch {
          /* 忽略 */
        }
      }

      await this._mountDocument(doc, token);
      if (token !== this._openToken || this._disposed) return false;

      this._hideLoading();
      this._updateToolbar();
      if (this.emptyEl) this.emptyEl.hidden = true;
      this._lastVpW = this.viewportEl.clientWidth;
      this._lastVpH = this.viewportEl.clientHeight;
      this._renderVisiblePages();
      this._fetchPageSizes(token).catch(() => {});
      return true;
    } catch (err) {
      if (token === this._openToken) {
        this._hideLoading();
        if (replaced) {
          this._stripCurrentDoc();
          if (task) {
            try {
              Promise.resolve(task.destroy()).catch(() => {});
            } catch {
              /* 忽略 */
            }
          }
        }
        this._toast(this._openErrorText(err));
      } else if (task) {
        try {
          Promise.resolve(task.destroy()).catch(() => {});
        } catch {
          /* 忽略 */
        }
      }
      return false;
    }
  }

  goToPage(n, { smooth = false } = {}) {
    if (!this._pdf || this._disposed) return;
    const total = this.pageCount;
    if (!total) return;
    const page = clamp(Math.floor(Number(n) || 1), 1, total);
    const el = this._pageEls[page - 1];
    if (!el) return;
    const top = Math.max(0, this.pagesEl.offsetTop + el.offsetTop - 8);
    try {
      this.viewportEl.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
    } catch {
      this.viewportEl.scrollTop = top;
    }
    this._setCurrentPage(page);
  }

  nextPage() {
    if (!this._pdf) return;
    this.goToPage(this._currentPage + 1, { smooth: true });
  }

  prevPage() {
    if (!this._pdf) return;
    this.goToPage(this._currentPage - 1, { smooth: true });
  }

  zoomIn() {
    if (!this._pdf) return;
    this._fitMode = false;
    this._applyScale(roundScale(this._scale * ZOOM_STEP), this._viewportCenter());
  }

  zoomOut() {
    if (!this._pdf) return;
    this._fitMode = false;
    this._applyScale(roundScale(this._scale / ZOOM_STEP), this._viewportCenter());
  }

  fitWidth() {
    if (!this._pdf) return;
    this._fitMode = true;
    this._applyScale(this._computeFitScale(), this._viewportCenter());
  }

  setZoom(z) {
    if (!this._pdf) return;
    const s = Number(z);
    if (!Number.isFinite(s)) return;
    this._fitMode = false;
    this._applyScale(roundScale(s), this._viewportCenter());
  }

  destroy() {
    if (this._disposed) return;
    this._disposed = true;
    this._openToken++;
    try {
      this._abort.abort();
    } catch {
      /* 忽略 */
    }
    if (this._dragAc) {
      try {
        this._dragAc.abort();
      } catch {
        /* 忽略 */
      }
      this._dragAc = null;
    }
    this._drag = null;
    clearTimeout(this._resizeTimer);
    clearTimeout(this._clipTimer);
    this._resizeTimer = 0;
    this._clipTimer = 0;
    if (this._scrollRaf) cancelAnimationFrame(this._scrollRaf);
    this._scrollRaf = 0;
    this._resetWheelZoom();
    if (this._io) {
      this._io.disconnect();
      this._io = null;
    }
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    for (let i = 0; i < this._tasks.length; i++) {
      const t = this._tasks[i];
      this._tasks[i] = null;
      try {
        t?.cancel?.();
      } catch {
        /* 忽略 */
      }
    }
    const task = this._loadingTask;
    this._loadingTask = null;
    const doc = this._pdf;
    this._pdf = null;
    if (task) {
      try {
        Promise.resolve(task.destroy()).catch(() => {});
      } catch {
        /* 忽略 */
      }
    } else if (doc) {
      try {
        Promise.resolve(doc.destroy()).catch(() => {});
      } catch {
        /* 忽略 */
      }
    }
    this._pageCache.clear();
    this._textCache.clear();
    this._pageEls = [];
    this._canvasEls = [];
    if (this.host) this.host.innerHTML = '';
  }

  /* ============================================================
     DOM 构建
     ============================================================ */

  _buildDom() {
    const handles = HANDLE_DIRS.map(
      (dir) => `<span class="pdfp-h pdfp-h-${dir}" data-dir="${dir}"></span>`
    ).join('');

    this.host.innerHTML = `
<div class="pdfp-root">
  <div class="pdfp-toolbar" role="toolbar" aria-label="PDF 工具栏">
    <div class="pdfp-tb-group">
      <button type="button" class="btn icon pdfp-prev" title="上一页（←）" aria-label="上一页" disabled>${ICON.prev}</button>
      <input class="pdfp-pageinput" type="text" inputmode="numeric" spellcheck="false" autocomplete="off"
             value="– / –" title="输入页码后回车跳转" aria-label="页码" disabled>
      <button type="button" class="btn icon pdfp-next" title="下一页（→）" aria-label="下一页" disabled>${ICON.next}</button>
    </div>
    <div class="pdfp-tb-spacer"></div>
    <div class="pdfp-tb-group">
      <button type="button" class="btn icon pdfp-zoomout" title="缩小（-）" aria-label="缩小" disabled>${ICON.minus}</button>
      <button type="button" class="btn pdfp-pct" title="恢复到 100%" disabled>100%</button>
      <button type="button" class="btn icon pdfp-zoomin" title="放大（+）" aria-label="放大" disabled>${ICON.plus}</button>
      <span class="pdfp-sep" aria-hidden="true"></span>
      <button type="button" class="btn pdfp-fit" title="按面板宽度显示" disabled>${ICON.fit}适应宽度</button>
    </div>
  </div>
  <div class="pdfp-main">
    <div class="pdfp-viewport" tabindex="0" aria-label="PDF 页面滚动区">
      <div class="pdfp-pages"></div>
    </div>
    <div class="pdfp-empty">
      ${ICON.doc}
      <p class="pdfp-empty-title">打开 PDF 或把文件拖到这里</p>
      <p class="pdfp-empty-hint">在页面上按住拖动即可框选区域，再贴到右侧白板</p>
      <button type="button" class="btn primary pdfp-open">${ICON.open}打开 PDF</button>
    </div>
    <div class="pdfp-loading" hidden>
      <span class="pdfp-spinner" aria-hidden="true"></span>
      <span class="pdfp-loading-text">正在加载 PDF…</span>
      <span class="pdfp-progress" aria-hidden="true"><i class="pdfp-progress-fill"></i></span>
    </div>
  </div>
  <div class="pdfp-sel" data-template="handles" hidden>${handles}</div>
</div>`;

    const q = (sel) => this.host.querySelector(sel);
    this.rootEl = q('.pdfp-root');
    this.viewportEl = q('.pdfp-viewport');
    this.pagesEl = q('.pdfp-pages');
    this.emptyEl = q('.pdfp-empty');
    this.emptyOpenBtn = q('.pdfp-open');
    this.loadingEl = q('.pdfp-loading');
    this.loadingTextEl = q('.pdfp-loading-text');
    this.loadingFillEl = q('.pdfp-progress-fill');
    this.prevBtn = q('.pdfp-prev');
    this.nextBtn = q('.pdfp-next');
    this.pageInput = q('.pdfp-pageinput');
    this.zoomOutBtn = q('.pdfp-zoomout');
    this.zoomInBtn = q('.pdfp-zoomin');
    this.pctBtn = q('.pdfp-pct');
    this.fitBtn = q('.pdfp-fit');

    // 模板里的手柄容器不参与渲染，真正的手柄在选区创建时再克隆生成
    const tpl = q('.pdfp-sel[data-template]');
    this._handleTpl = tpl ? tpl.innerHTML : handles;
    if (tpl) tpl.remove();
  }

  _bind() {
    const sig = { signal: this._abort.signal };

    this.prevBtn.addEventListener('click', () => this.prevPage(), sig);
    this.nextBtn.addEventListener('click', () => this.nextPage(), sig);
    this.zoomInBtn.addEventListener('click', () => this.zoomIn(), sig);
    this.zoomOutBtn.addEventListener('click', () => this.zoomOut(), sig);
    this.fitBtn.addEventListener('click', () => this.fitWidth(), sig);
    this.pctBtn.addEventListener('click', () => this.setZoom(1), sig);

    if (this.emptyOpenBtn) {
      this.emptyOpenBtn.addEventListener(
        'click',
        () => {
          const input = document.getElementById('filePdf');
          if (input) input.click();
        },
        sig
      );
    }

    this.pageInput.addEventListener('keydown', this._onPageInputKey, sig);
    this.pageInput.addEventListener('focus', this._onPageInputFocus, sig);
    this.pageInput.addEventListener('blur', this._onPageInputBlur, sig);

    this.viewportEl.addEventListener('scroll', this._onScroll, { signal: this._abort.signal, passive: true });
    // wheel 必须 passive:false，才能在 Ctrl/Cmd+滚轮时 preventDefault 掉浏览器整页缩放
    this.viewportEl.addEventListener('wheel', this._onWheel, { signal: this._abort.signal, passive: false });
    // 工具条区域也兜住 Ctrl+滚轮，避免光标在工具条上时仍然整页缩放
    this.rootEl.addEventListener('wheel', this._onRootWheel, { signal: this._abort.signal, passive: false });
    this.viewportEl.addEventListener('pointerdown', this._onViewportDown, sig);
    this.pagesEl.addEventListener('pointerdown', this._onPageDown, sig);
    this.rootEl.addEventListener('keydown', this._onKeyDown, sig);
    window.addEventListener('resize', this._onResize, sig);
  }

  _observe() {
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(this.viewportEl);
    }
    if (typeof IntersectionObserver === 'function') {
      this._io = new IntersectionObserver(this._onIntersect, {
        root: this.viewportEl,
        rootMargin: `${IO_MARGIN}px 0px`,
        threshold: 0,
      });
    }
  }

  /* ============================================================
     文档装载 / 卸载
     ============================================================ */

  async _toBytes(src) {
    if (!src) return null;
    if (src instanceof Uint8Array) return src;
    if (src instanceof ArrayBuffer) return new Uint8Array(src);
    if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    if (typeof src.arrayBuffer === 'function') return new Uint8Array(await src.arrayBuffer());
    return null;
  }

  _openErrorText(err) {
    const name = err && err.name;
    if (name === 'PasswordException') return '打开失败：文件已加密，需要密码';
    if (name === 'InvalidPDFException') return '打开失败：文件已损坏或不是有效的 PDF';
    if (name === 'MissingPDFException') return '打开失败：找不到这个文件';
    if (name === 'UnexpectedResponseException') return '打开失败：读取文件时出错';
    const raw = err && err.message ? String(err.message) : '';
    const brief = raw ? raw.slice(0, 60) : '未知错误';
    return '打开失败：' + brief;
  }

  async _mountDocument(doc, token) {
    this._pdf = doc;
    this._pageCache.clear();
    this._textCache.clear();
    this._pageSizes = [];
    this._pageCss = [];
    this._tops = [];
    this._heights = [];
    this._currentPage = 1;
    this._fitMode = true;
    this._sel = null;
    this._clip = null;
    this._clipBlob = null;
    this._clipKey = '';

    const first = await doc.getPage(1);
    if (token !== this._openToken || this._disposed) return;
    const vp = first.getViewport({ scale: 1 });
    const defW = vp.width > 0 ? vp.width : 612;
    const defH = vp.height > 0 ? vp.height : 792;

    const total = doc.numPages;
    const sizes = new Array(total);
    for (let i = 0; i < total; i++) sizes[i] = { w: defW, h: defH };
    this._pageSizes = sizes;

    this._buildPages(total);

    // 先按 1:1 布局，再切到「适应宽度」（宿主宽度为 0 时保持 1:1，等 ResizeObserver 修正）
    this._scale = 1;
    this._layout();
    this._scale = this._computeFitScale();
    this._layout();
    this._cacheTops();
    this._updateToolbar();
  }

  _buildPages(total) {
    let html = '';
    for (let i = 0; i < total; i++) {
      html += `<div class="pdfp-page" data-page="${i + 1}"><canvas class="pdfp-canvas"></canvas></div>`;
    }
    this.pagesEl.innerHTML = html;

    this._pageEls = Array.from(this.pagesEl.children);
    this._canvasEls = this._pageEls.map((el) => el.querySelector('canvas'));
    this._renderedScale = new Array(total).fill(0);
    this._renderSeq = new Array(total).fill(0);
    this._tasks = new Array(total).fill(null);
    this._visible.clear();

    if (this._io) {
      this._io.disconnect();
      for (const el of this._pageEls) this._io.observe(el);
    }
  }

  /** 后台补齐每页真实尺寸；尺寸不同才触发重排，避免长文档无谓抖动 */
  async _fetchPageSizes(token) {
    const total = this._pageSizes.length;
    let prevMaxW = this._maxPageWidth();
    let dirty = false;

    for (let i = 1; i < total; i++) {
      if (this._disposed || token !== this._openToken || !this._pdf) return;
      let size = null;
      try {
        const page = await this._getPage(i + 1);
        if (this._disposed || token !== this._openToken) return;
        const vp = page.getViewport({ scale: 1 });
        if (vp && vp.width > 0 && vp.height > 0) size = { w: vp.width, h: vp.height };
      } catch {
        size = null;
      }
      if (size) {
        const cur = this._pageSizes[i];
        if (!cur || Math.abs(cur.w - size.w) > 0.5 || Math.abs(cur.h - size.h) > 0.5) {
          this._pageSizes[i] = size;
          dirty = true;
        }
      }
      if (i % 8 === 0) {
        if (dirty) {
          this._relayoutKeepAnchor();
          dirty = false;
        }
        this._refitIfNeeded(prevMaxW);
        prevMaxW = this._maxPageWidth();
        await nextTask();
      }
    }
    if (this._disposed || token !== this._openToken || !this._pdf) return;
    if (dirty) this._relayoutKeepAnchor();
    this._refitIfNeeded(prevMaxW);
  }

  /** 卸下当前文档的 DOM / 选区 / 渲染任务，但**不销毁** PDFDocumentProxy（由调用方决定） */
  _stripCurrentDoc() {
    if (this._dragAc) {
      try {
        this._dragAc.abort();
      } catch {
        /* 忽略 */
      }
      this._dragAc = null;
    }
    this._drag = null;
    this._clearSelection();
    this._resetWheelZoom();

    for (let i = 0; i < this._tasks.length; i++) void this._cancelRender(i);
    this._tasks = [];
    this._pageCache.clear();
    this._textCache.clear();
    if (this._io) this._io.disconnect();
    this._visible.clear();

    if (this.pagesEl) this.pagesEl.innerHTML = '';
    this._pageEls = [];
    this._canvasEls = [];
    this._pageSizes = [];
    this._pageCss = [];
    this._tops = [];
    this._heights = [];
    this._renderedScale = [];
    this._renderSeq = [];
    this._currentPage = 1;
    this._scale = 1;
    this._fitMode = true;
    this._clipTask = null;
    this._pdf = null;
    this._loadingTask = null;
    this._hideLoading();
    if (this.emptyEl) this.emptyEl.hidden = false;
    this._updateToolbar();
  }

  _getPage(n) {
    if (!this._pdf) return Promise.reject(new Error('PDF 未加载'));
    let p = this._pageCache.get(n);
    if (!p) {
      p = this._pdf.getPage(n);
      // 失败的 promise 不能一直缓存在 Map 里，否则会反复抛出未处理拒绝
      p.catch(() => {
        if (this._pageCache.get(n) === p) this._pageCache.delete(n);
      });
      this._pageCache.set(n, p);
    }
    return p;
  }

  _getTextContent(idx, page) {
    let p = this._textCache.get(idx);
    if (!p) {
      p = Promise.resolve()
        .then(() => page.getTextContent())
        .catch(() => ({ items: [] }));
      this._textCache.set(idx, p);
    }
    return p;
  }

  /* ============================================================
     布局
     ============================================================ */

  _layout() {
    if (!this._pdf) return;
    const scale = this._scale;
    for (let i = 0; i < this._pageEls.length; i++) {
      const size = this._pageSizes[i] || this._pageSizes[0] || { w: 612, h: 792 };
      const w = Math.max(1, size.w * scale);
      const h = Math.max(1, size.h * scale);
      this._pageCss[i] = { w, h };
      const el = this._pageEls[i];
      if (!el) continue;
      el.style.width = w.toFixed(2) + 'px';
      el.style.height = h.toFixed(2) + 'px';
    }
    this._cacheTops();
  }

  _cacheTops() {
    this._tops = [];
    this._heights = [];
    for (const el of this._pageEls) {
      this._tops.push(el.offsetTop);
      this._heights.push(el.offsetHeight);
    }
  }

  _maxPageWidth() {
    let m = 0;
    for (const s of this._pageSizes) if (s && s.w > m) m = s.w;
    return m || 612;
  }

  _computeFitScale() {
    if (!this.viewportEl) return this._scale;
    // 用 border-box 宽度而不是 clientWidth：clientWidth 会随纵向滚动条出现而变小，
    // 会让「适应宽度」在滚动条刚出现时抖一下（先大后小）。border-box 宽度稳定。
    const boxW = this.viewportEl.getBoundingClientRect().width || this.viewportEl.clientWidth;
    if (!boxW) return this._scale;               // 宿主宽为 0：保持当前缩放，等 ResizeObserver
    const avail = Math.max(60, boxW - PAGE_PADDING * 2 - SCROLLBAR_RESERVE);
    return clamp(avail / this._maxPageWidth(), MIN_SCALE, MAX_SCALE);
  }

  _relayoutKeepAnchor() {
    const a = this._captureTopAnchor();
    this._layout();
    this._restoreTopAnchor(a);
    if (this._sel) {
      this._positionSel();
      if (this._barEl && this._barEl.classList.contains('pdfp-on')) this._placeBar();
    }
    this._renderVisiblePages();
  }

  _refitIfNeeded(prevMaxW) {
    if (!this._fitMode || !this._pdf) return;
    const maxW = this._maxPageWidth();
    if (Math.abs(maxW - prevMaxW) <= 0.5) return;
    const s = this._computeFitScale();
    if (Math.abs(s - this._scale) < 0.002) return;
    this._applyScale(s, this._viewportCenter());
  }

  _captureTopAnchor() {
    if (!this._pdf || !this._tops.length) return null;
    const y = this.viewportEl.scrollTop + 1;
    const base = this.pagesEl.offsetTop;
    const tops = this._tops;
    let idx = 0;
    for (let i = 0; i < tops.length; i++) {
      if (base + tops[i] <= y) idx = i;
      else break;
    }
    const el = this._pageEls[idx];
    if (!el) return null;
    const h = this._heights[idx] || el.offsetHeight || 1;
    return { idx, frac: clamp((y - base - tops[idx]) / Math.max(1, h), 0, 1) };
  }

  _restoreTopAnchor(a) {
    if (!a) return;
    const el = this._pageEls[a.idx];
    if (!el) return;
    const h = this._heights[a.idx] || el.offsetHeight || 0;
    const top = this.pagesEl.offsetTop + this._tops[a.idx] + h * a.frac;
    this.viewportEl.scrollTop = Math.max(0, top);
  }

  /* ============================================================
     缩放
     ============================================================ */

  _viewportCenter() {
    const r = this.viewportEl.getBoundingClientRect();
    return {
      x: r.left + this.viewportEl.clientWidth / 2,
      y: r.top + this.viewportEl.clientHeight / 2,
    };
  }

  _anchorFromClient(pt) {
    const els = this._pageEls;
    if (!pt || !els.length) return null;
    let best = null;
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const d = pt.y < r.top ? r.top - pt.y : pt.y > r.bottom ? pt.y - r.bottom : 0;
      if (!best || d < best.d) best = { d, i, r };
      if (d === 0) break;
    }
    if (!best) return null;
    const r = best.r;
    return {
      idx: best.i,
      rx: clamp((pt.x - r.left) / r.width, 0, 1),
      ry: clamp((pt.y - r.top) / r.height, 0, 1),
    };
  }

  _restoreAnchor(a, pt) {
    if (!a || !pt) return;
    const el = this._pageEls[a.idx];
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dy = r.top + a.ry * r.height - pt.y;
    const dx = r.left + a.rx * r.width - pt.x;
    if (Math.abs(dy) > 0.5) this.viewportEl.scrollTop += dy;
    if (Math.abs(dx) > 0.5) this.viewportEl.scrollLeft += dx;
  }

  _applyScale(scale, anchorClient, { deferRender = false } = {}) {
    if (!this._pdf || this._disposed) return;
    const next = clamp(Number(scale) || this._scale, MIN_SCALE, MAX_SCALE);
    const anchor = anchorClient || this._viewportCenter();
    const a = this._anchorFromClient(anchor);

    this._scale = next;
    this._layout();
    this._restoreAnchor(a, anchor);
    // 滚轮/触控板连续缩放时先别逐帧重新渲染（会不停 cancel 渲染任务），
    // 等手势停下 140ms 再统一渲染可见页，界面先看缩放后的旧位图。
    if (!deferRender) this._renderVisiblePages();
    this._updateToolbar();

    if (this._sel) {
      this._positionSel();
      if (this._barEl) this._placeBar();
      this._clipKey = '';                 // 缩放变了，旧剪贴块的 dpr 已失效
      this._scheduleClipRegen();
    }
  }

  _flushDeferredRender = () => {
    this._renderIdleTimer = 0;
    if (this._disposed || !this._pdf) return;
    this._renderVisiblePages();
  };

  _scheduleClipRegen() {
    clearTimeout(this._clipTimer);
    this._clipTimer = 0;
    if (!this._sel) return;
    this._clipTimer = setTimeout(() => {
      this._clipTimer = 0;
      if (!this._disposed && this._sel) this._startClip({ writeClipboard: false }).catch(() => {});
    }, 220);
  }

  _onResize = () => {
    if (this._disposed) return;
    const w = this.viewportEl ? this.viewportEl.clientWidth : 0;
    const h = this.viewportEl ? this.viewportEl.clientHeight : 0;
    if (!w || !h) return;                                    // 宿主折叠/隐藏：直接跳过
    if (Math.abs(w - this._lastVpW) < 0.5 && Math.abs(h - this._lastVpH) < 0.5) return;
    this._lastVpW = w;
    this._lastVpH = h;
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(this._applyResize, 120);  // 防抖，避免拖分割条时疯狂重排
  };

  _applyResize = () => {
    this._resizeTimer = 0;
    if (this._disposed || !this._pdf) return;
    const w = this.viewportEl.clientWidth;
    const h = this.viewportEl.clientHeight;
    if (!w || !h) return;
    if (this._fitMode) {
      const scale = this._computeFitScale();
      if (Math.abs(scale - this._scale) > 0.002) {
        this._applyScale(scale, this._viewportCenter());
        return;
      }
    }
    if (this._sel) {
      this._positionSel();
      if (this._barEl && this._barEl.classList.contains('pdfp-on')) this._placeBar();
    }
  };

  /* ============================================================
     滚轮
     - Ctrl/Cmd + 滚轮（含触控板双指捏合上报的 ctrlKey=true wheel）：以光标为锚点缩放 PDF，
       并 preventDefault 掉浏览器整页缩放（否则顶栏/布局会跟着放大）。
     - 普通滚轮：完全不拦截，保持原生滚动。
     - Shift + 滚轮：横向滚动（等价于原生 shift+wheel 行为，这里显式处理保证一致）。
     缩放增量按帧合并，避免触控板高频事件把每页重排/重渲染打爆。
     ============================================================ */

  /** 把 deltaMode 归一化成像素（0=像素，1=行，2=页） */
  _deltaPx(delta, axis) {
    const base = Number(delta) || 0;
    if (base === 0) return 0;
    if (axis === undefined) axis = 'y';
    const unit = axis === 'x' ? this.viewportEl.clientWidth : this.viewportEl.clientHeight;
    if (this._wheelDeltaMode === 1) return base * 16;
    if (this._wheelDeltaMode === 2) return base * (unit || 600);
    return base;
  }

  _onWheel = (e) => {
    this._handleWheel(e, true);
  };

  /** 工具条等滚动区外的 wheel：只处理 Ctrl/Cmd 缩放，避免整页缩放 */
  _onRootWheel = (e) => {
    if (e.defaultPrevented) return;
    const target = e.target;
    if (target instanceof Element && this.viewportEl.contains(target)) return;
    this._handleWheel(e, false);
  };

  _handleWheel(e, insideViewport) {
    if (this._disposed || !this._pdf) return;
    if (e.defaultPrevented) return;
    this._wheelDeltaMode = e.deltaMode || 0;

    const zoomMod = e.ctrlKey || e.metaKey;
    if (zoomMod) {
      // 必须同步 preventDefault，否则浏览器已经在做整页缩放 / 触控板捏合缩放了
      e.preventDefault();
      const dy = this._deltaPx(e.deltaY, 'y');
      if (!dy) return;
      const prev = this._wheelAcc;
      this._wheelAcc = {
        x: e.clientX,
        y: e.clientY,
        dy: (prev ? prev.dy : 0) + dy,
      };
      if (!this._wheelRaf) this._wheelRaf = requestAnimationFrame(this._applyWheelZoom);
      return;
    }

    if (!insideViewport || !e.shiftKey) return;   // 普通滚轮 / 触控板横向滑动交给原生
    const dx = this._deltaPx(e.deltaY || e.deltaX, 'x');
    if (!dx) return;
    e.preventDefault();
    this.viewportEl.scrollLeft += dx;
  }

  _applyWheelZoom = () => {
    this._wheelRaf = 0;
    const acc = this._wheelAcc;
    this._wheelAcc = null;
    if (!acc || this._disposed || !this._pdf) return;

    // 光标可能停在工具条上（root 兜底），锚点夹进视口内，保证一定能找到页面
    const vpRect = this.viewportEl.getBoundingClientRect();
    const anchor = {
      x: clamp(acc.x, vpRect.left + 1, vpRect.left + Math.max(1, this.viewportEl.clientWidth - 1)),
      y: clamp(acc.y, vpRect.top + 1, vpRect.top + Math.max(1, this.viewportEl.clientHeight - 1)),
    };

    const factor = Math.exp(-acc.dy * WHEEL_ZOOM_RATE);
    const next = clamp(this._scale * factor, MIN_SCALE, MAX_SCALE);
    if (Math.abs(next - this._scale) < 0.0005) return;   // 已到边界 / 增量太小：不重排

    this._fitMode = false;                                // 手动缩放后不再自动适应宽度
    this._applyScale(next, anchor, { deferRender: true });

    // 手势停顿后再补渲染可见页，避免每帧取消/重启渲染任务
    clearTimeout(this._renderIdleTimer);
    this._renderIdleTimer = setTimeout(this._flushDeferredRender, 140);
  };

  _resetWheelZoom() {
    if (this._wheelRaf) cancelAnimationFrame(this._wheelRaf);
    this._wheelRaf = 0;
    this._wheelAcc = null;
    clearTimeout(this._renderIdleTimer);
    this._renderIdleTimer = 0;
  }

  /* ============================================================
     渲染
     ============================================================ */

  _onIntersect = (entries) => {
    if (this._disposed || !this._pdf) return;
    for (const entry of entries) {
      const idx = Number(entry.target.dataset.page) - 1;
      if (!(idx >= 0)) continue;
      if (entry.isIntersecting) {
        this._visible.add(idx);
        // 滚轮/捏合缩放进行中：先不逐帧渲染，等 _flushDeferredRender 统一补渲染
        if (this._wheelRaf || this._renderIdleTimer) continue;
        if (this._renderedScale[idx] !== this._scale) this._renderPage(idx).catch(() => {});
      } else {
        this._visible.delete(idx);
        this._releasePage(idx).catch(() => {});
      }
    }
  };

  _renderVisiblePages() {
    if (!this._pdf) return;
    const st = this.viewportEl.scrollTop;
    const vh = this.viewportEl.clientHeight;
    const base = this.pagesEl.offsetTop;
    const top = st - PRELOAD_MARGIN;
    const bottom = st + vh + PRELOAD_MARGIN;
    for (let i = 0; i < this._tops.length; i++) {
      const y0 = base + this._tops[i];
      const y1 = y0 + (this._heights[i] || 0);
      if (y1 < top || y0 > bottom) continue;
      if (this._renderedScale[i] !== this._scale) this._renderPage(i).catch(() => {});
    }
  }

  async _renderPage(idx) {
    if (!this._pdf || this._disposed) return;
    const el = this._pageEls[idx];
    const canvas = this._canvasEls[idx];
    if (!el || !canvas) return;

    const token = this._openToken;
    const scale = this._scale;
    const seq = (this._renderSeq[idx] = (this._renderSeq[idx] || 0) + 1);

    await this._cancelRender(idx);
    if (this._disposed || token !== this._openToken || seq !== this._renderSeq[idx] || scale !== this._scale) return;

    let page;
    try {
      page = await this._getPage(idx + 1);
    } catch {
      this._pageError(el, '此页无法加载');
      return;
    }
    // 预热文字层：用户框选时就能立刻拿到文字，不必现等 getTextContent 解析
    if (!this._textCache.has(idx)) this._getTextContent(idx, page);
    if (this._disposed || token !== this._openToken || seq !== this._renderSeq[idx] || scale !== this._scale) return;

    let viewport;
    try {
      viewport = page.getViewport({ scale });
    } catch {
      return;
    }
    if (!(viewport.width > 0) || !(viewport.height > 0)) return;

    // 画布像素 = CSS 尺寸 × DPR（受上限约束），保证清晰；显示尺寸交给 CSS 100%
    let out = Math.min(window.devicePixelRatio || 1, MAX_RENDER_DPR);
    if (out <= 0) out = 1;
    const pixelCount = viewport.width * out * viewport.height * out;
    if (pixelCount > MAX_RENDER_PIXELS) {
      out = Math.sqrt(MAX_RENDER_PIXELS / (viewport.width * viewport.height));
    }
    out = Math.max(out, 0.25);
    const cw = Math.max(1, Math.floor(viewport.width * out));
    const ch = Math.max(1, Math.floor(viewport.height * out));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;

    let ctx = null;
    try {
      ctx = canvas.getContext('2d', { alpha: false });
    } catch {
      ctx = null;
    }
    if (!ctx) return;

    let task = null;
    try {
      task = page.render({
        canvasContext: ctx,
        viewport,
        transform: out !== 1 ? [out, 0, 0, out, 0, 0] : null,
        intent: 'display',
      });
    } catch {
      this._pageError(el, '此页渲染失败');
      return;
    }
    this._tasks[idx] = task;

    try {
      await task.promise;
    } catch (err) {
      if (!err || err.name !== 'RenderingCancelledException') this._pageError(el, '此页渲染失败');
      return;
    } finally {
      if (this._tasks[idx] === task) this._tasks[idx] = null;
    }

    if (this._disposed || token !== this._openToken || seq !== this._renderSeq[idx] || scale !== this._scale) return;
    this._renderedScale[idx] = scale;
    el.classList.add('pdfp-page--ready');
    const errEl = el.querySelector('.pdfp-page-err');
    if (errEl) errEl.remove();
  }

  async _cancelRender(idx) {
    const task = this._tasks[idx];
    if (!task) return;
    this._tasks[idx] = null;
    try {
      task.cancel();
    } catch {
      /* 忽略 */
    }
    try {
      await task.promise;
    } catch {
      /* 取消导致的拒绝是正常情况 */
    }
  }

  async _releasePage(idx) {
    if (this._disposed) return;
    if (this._sel && this._sel.pageIdx === idx) return;   // 选区所在页保留位图
    await this._cancelRender(idx);
    if (this._disposed) return;
    if (this._visible.has(idx)) return;                   // 取消渲染期间又滚回来了
    const canvas = this._canvasEls[idx];
    if (canvas && (canvas.width || canvas.height)) {
      canvas.width = 0;
      canvas.height = 0;
    }
    this._renderedScale[idx] = 0;
    const el = this._pageEls[idx];
    if (el) el.classList.remove('pdfp-page--ready');
  }

  _pageError(el, msg) {
    if (!el) return;
    let node = el.querySelector('.pdfp-page-err');
    if (!node) {
      node = document.createElement('div');
      node.className = 'pdfp-page-err';
      el.appendChild(node);
    }
    node.textContent = msg || '此页无法显示';
    el.classList.add('pdfp-page--error');
  }

  /* ============================================================
     滚动 / 页码同步
     ============================================================ */

  _onScroll = () => {
    if (this._scrollRaf) return;
    this._scrollRaf = requestAnimationFrame(() => {
      this._scrollRaf = 0;
      if (this._disposed) return;
      this._syncCurrentPage();
      if (this._barEl && this._barEl.classList.contains('pdfp-on')) this._placeBar();
    });
  };

  _syncCurrentPage() {
    if (!this._pdf || !this._tops.length) return;
    const y = this.viewportEl.scrollTop + this.viewportEl.clientHeight * 0.3;
    const base = this.pagesEl.offsetTop;
    let idx = 0;
    for (let i = 0; i < this._tops.length; i++) {
      if (base + this._tops[i] <= y) idx = i;
      else break;
    }
    this._setCurrentPage(idx + 1);
  }

  _setCurrentPage(n) {
    const total = this.pageCount;
    if (!total) return;
    const page = clamp(Math.round(Number(n) || 1), 1, total);
    if (page === this._currentPage) return;
    this._currentPage = page;
    this._updateToolbar();
  }

  _refreshPageInput() {
    const total = this.pageCount;
    if (this.pageInput) this.pageInput.value = total ? `${this._currentPage} / ${total}` : '– / –';
  }

  _updateToolbar() {
    const loaded = !!this._pdf;
    const total = this.pageCount;
    const cur = this._currentPage;

    if (this.prevBtn) this.prevBtn.disabled = !loaded || cur <= 1;
    if (this.nextBtn) this.nextBtn.disabled = !loaded || cur >= total;
    if (this.pageInput) {
      this.pageInput.disabled = !loaded;
      if (document.activeElement !== this.pageInput) this._refreshPageInput();
    }
    if (this.zoomInBtn) this.zoomInBtn.disabled = !loaded;
    if (this.zoomOutBtn) this.zoomOutBtn.disabled = !loaded;
    if (this.pctBtn) {
      this.pctBtn.disabled = !loaded;
      this.pctBtn.textContent = loaded ? Math.round(this._scale * 100) + '%' : '100%';
    }
    if (this.fitBtn) this.fitBtn.disabled = !loaded;
    if (this.emptyEl) this.emptyEl.hidden = loaded;
  }

  _onPageInputFocus = () => {
    try {
      this.pageInput.select();
    } catch {
      /* 忽略 */
    }
  };

  _onPageInputBlur = () => {
    this._refreshPageInput();
  };

  _onPageInputKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const m = String(this.pageInput.value || '').match(/\d+/);
      if (m && this._pdf) this.goToPage(parseInt(m[0], 10));
      this._refreshPageInput();
      try {
        this.pageInput.select();
      } catch {
        /* 忽略 */
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this._refreshPageInput();
      this.pageInput.blur();
    }
  };

  /* ============================================================
     键盘
     ============================================================ */

  _onKeyDown = (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      return;
    }
    const mod = e.ctrlKey || e.metaKey;

    if (e.key === 'Escape') {
      if (this._drag) this._abortDrag();
      if (this._sel) {
        this._clearSelection();
        e.preventDefault();
      }
      return;
    }
    if (mod && (e.key === 'c' || e.key === 'C')) {
      if (!this._sel) return;                 // 没有选区就不抢 Ctrl+C
      e.preventDefault();
      this._copySelection().catch(() => {});
      return;
    }
    if (mod || e.altKey) return;

    switch (e.key) {
      case 'ArrowLeft':
        if (this._pdf) {
          e.preventDefault();
          this.prevPage();
        }
        break;
      case 'ArrowRight':
        if (this._pdf) {
          e.preventDefault();
          this.nextPage();
        }
        break;
      case '+':
      case '=':
        e.preventDefault();
        this.zoomIn();
        break;
      case '-':
      case '_':
        e.preventDefault();
        this.zoomOut();
        break;
      default:
        break;
    }
  };

  /* ============================================================
     选区
     ============================================================ */

  _focusViewport() {
    const el = this.viewportEl;
    if (!el) return;
    if (document.activeElement === el) return;
    // 点击滚动区时把焦点收进面板，键盘快捷键（Ctrl+C / ← → / + - / Esc）才可用；
    // 注意不要因为焦点还停在浮条按钮上就跳过——浮条会被销毁，焦点会掉到 body。
    try {
      el.focus({ preventScroll: true });
    } catch {
      try {
        el.focus();
      } catch {
        /* 忽略 */
      }
    }
  }

  _onViewportDown = (e) => {
    if (!this._pdf) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    // 点在滚动条上：不处理（避免拖滚动条时误清选区）
    const r = this.viewportEl.getBoundingClientRect();
    if (e.clientX - r.left >= this.viewportEl.clientWidth || e.clientY - r.top >= this.viewportEl.clientHeight) return;
    if (target.closest('.pdfp-page')) return;
    if (target.closest('.pdfp-loading') || target.closest('.pdfp-empty')) return;
    if (this._sel) this._clearSelection();
    this._focusViewport();
  };

  _onPageDown = (e) => {
    if (!this._pdf || e.button !== 0 || e.pointerType === 'touch') return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.pdfp-bar') || target.closest('.pdfp-h')) return;   // 浮条/手柄自行处理
    const pageEl = target.closest('.pdfp-page');
    if (!pageEl) return;
    const idx = Number(pageEl.dataset.page) - 1;
    if (!(idx >= 0)) return;

    this._focusViewport();
    if (this._drag) this._abortDrag();           // 上一次拖拽没结束时先丢弃
    const rect = pageEl.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    const start = fracOf(e.clientX, e.clientY, rect);
    this._clearSelection();                       // 在页面上按下即视为重新开始框选

    const drag = {
      mode: 'new',
      pageIdx: idx,
      pageEl,
      captureEl: pageEl,
      pointerId: e.pointerId,
      start,
      moved: false,
    };
    this._sel = { pageIdx: idx, x0: start.x, y0: start.y, x1: start.x, y1: start.y };
    this._drag = drag;

    this._dragAc = new AbortController();
    const opt = { signal: this._dragAc.signal };
    pageEl.addEventListener('pointermove', this._onDragMove, opt);
    pageEl.addEventListener('pointerup', this._onDragEnd, opt);
    pageEl.addEventListener('pointercancel', this._onDragEnd, opt);
    try {
      pageEl.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略：没有捕获也能靠 window 之外的 pointerup 结束 */
    }
  };

  _onSelDown = (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const dir = target.dataset ? target.dataset.dir : '';
    if (!dir || !this._sel || !this._pdf) return;
    e.stopPropagation();
    e.preventDefault();

    const pageEl = this._pageEls[this._sel.pageIdx];
    if (!pageEl) return;
    const rect = pageEl.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    this._hideBar();
    this._drag = {
      mode: 'resize',
      dir,
      pageIdx: this._sel.pageIdx,
      pageEl,
      captureEl: target,
      pointerId: e.pointerId,
      startFrac: fracOf(e.clientX, e.clientY, rect),
      start: { ...this._sel },
      moved: false,
    };
    this._dragAc = new AbortController();
    const opt = { signal: this._dragAc.signal };
    target.addEventListener('pointermove', this._onDragMove, opt);
    target.addEventListener('pointerup', this._onDragEnd, opt);
    target.addEventListener('pointercancel', this._onDragEnd, opt);
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
  };

  _onDragMove = (e) => {
    const d = this._drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const rect = d.pageEl.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    if (d.mode === 'new') {
      const p = fracOf(e.clientX, e.clientY, rect);
      const x0 = Math.min(d.start.x, p.x);
      const x1 = Math.max(d.start.x, p.x);
      const y0 = Math.min(d.start.y, p.y);
      const y1 = Math.max(d.start.y, p.y);
      if ((x1 - x0) * rect.width > 2 || (y1 - y0) * rect.height > 2) d.moved = true;
      if (!d.moved) return;
      this._sel = { pageIdx: d.pageIdx, x0, y0, x1, y1 };
      this._ensureSelEls();
      this._positionSel();
      this._hideBar();
      return;
    }

    // resize
    const p = fracOf(e.clientX, e.clientY, rect);
    const fx = p.x - d.startFrac.x;
    const fy = p.y - d.startFrac.y;
    const minW = MIN_SEL_PX / Math.max(1, rect.width);
    const minH = MIN_SEL_PX / Math.max(1, rect.height);
    let { x0, y0, x1, y1 } = d.start;
    if (d.dir.includes('w')) x0 = clamp(d.start.x0 + fx, 0, Math.max(0, d.start.x1 - minW));
    if (d.dir.includes('e')) x1 = clamp(d.start.x1 + fx, d.start.x0 + minW, 1);
    if (d.dir.includes('n')) y0 = clamp(d.start.y0 + fy, 0, Math.max(0, d.start.y1 - minH));
    if (d.dir.includes('s')) y1 = clamp(d.start.y1 + fy, d.start.y0 + minH, 1);
    d.moved = true;
    this._sel = { pageIdx: d.pageIdx, x0, y0, x1, y1 };
    this._positionSel();
  };

  _onDragEnd = (e) => {
    const d = this._drag;
    if (!d) return;
    if (e && typeof e.pointerId === 'number' && e.pointerId !== d.pointerId) return;
    this._finishDrag();
  };

  /** 放弃当前拖拽（不产生选区/剪贴块），只做监听与指针捕获的收尾 */
  _abortDrag() {
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    if (this._dragAc) {
      try {
        this._dragAc.abort();
      } catch {
        /* 忽略 */
      }
      this._dragAc = null;
    }
    try {
      (d.captureEl || d.pageEl)?.releasePointerCapture?.(d.pointerId);
    } catch {
      /* 忽略 */
    }
  }

  _finishDrag() {
    const d = this._drag;
    if (!d) return;
    this._abortDrag();

    if (d.mode === 'resize') {
      if (this._sel) {
        this._ensureSelEls();
        this._showBar();
        this._startClip({ writeClipboard: false }).catch(() => {});
      }
      return;
    }

    if (!d.moved || !this._sel) {
      this._clearSelection();
      return;
    }
    const rect = d.pageEl.getBoundingClientRect();
    const w = (this._sel.x1 - this._sel.x0) * rect.width;
    const h = (this._sel.y1 - this._sel.y0) * rect.height;
    if (w < MIN_SEL_PX || h < MIN_SEL_PX) {
      this._clearSelection();
      return;
    }
    this._ensureSelEls();
    this._showBar();
    this._startClip({ writeClipboard: true }).catch(() => {});
  }

  _clearSelection() {
    this._sel = null;
    this._clip = null;
    this._clipBlob = null;
    this._clipKey = '';
    this._clipTask = null;
    clearTimeout(this._clipTimer);
    this._clipTimer = 0;
    if (this._selAc) {
      try {
        this._selAc.abort();
      } catch {
        /* 忽略 */
      }
      this._selAc = null;
    }
    if (this._selEl) {
      this._selEl.remove();
      this._selEl = null;
    }
    if (this._barEl) {
      this._barEl.remove();
      this._barEl = null;
    }
  }

  _ensureSelEls() {
    const sel = this._sel;
    if (!sel || !this._pdf) return false;
    const pageEl = this._pageEls[sel.pageIdx];
    if (!pageEl) return false;
    if (!this._selAc) this._selAc = new AbortController();
    const opt = { signal: this._selAc.signal };

    if (!this._selEl) {
      const box = document.createElement('div');
      box.className = 'pdfp-sel';
      box.innerHTML = this._handleTpl;
      box.addEventListener('pointerdown', this._onSelDown, opt);
      this._selEl = box;
    }
    if (this._selEl.parentNode !== pageEl) pageEl.appendChild(this._selEl);

    if (!this._barEl) {
      const bar = document.createElement('div');
      bar.className = 'pdfp-bar';
      bar.innerHTML =
        '<span class="pdfp-bar-spin" aria-hidden="true"></span>' +
        '<button type="button" class="pdfp-bar-btn pdfp-bar-main" data-act="send" title="把选区截图贴到右侧白板">→ 贴到白板</button>' +
        '<button type="button" class="pdfp-bar-btn" data-act="text" title="把框内文字贴到白板">贴文本</button>' +
        '<button type="button" class="pdfp-bar-btn" data-act="copy" title="复制选区图片（Ctrl+C）">复制</button>' +
        '<button type="button" class="pdfp-bar-btn pdfp-bar-x" data-act="close" title="取消选区（Esc）" aria-label="取消选区">×</button>';
      bar.addEventListener('pointerdown', this._onBarDown, opt);
      bar.addEventListener('click', this._onBarClick, opt);
      this._barEl = bar;
    }
    if (this._barEl.parentNode !== pageEl) pageEl.appendChild(this._barEl);

    this._selEl.classList.add('pdfp-on');
    this._positionSel();
    return true;
  }

  _positionSel() {
    const sel = this._sel;
    if (!sel || !this._selEl) return;
    const css = this._pageCss[sel.pageIdx];
    if (!css) return;
    this._selEl.style.left = (sel.x0 * css.w).toFixed(2) + 'px';
    this._selEl.style.top = (sel.y0 * css.h).toFixed(2) + 'px';
    this._selEl.style.width = Math.max(1, (sel.x1 - sel.x0) * css.w).toFixed(2) + 'px';
    this._selEl.style.height = Math.max(1, (sel.y1 - sel.y0) * css.h).toFixed(2) + 'px';
  }

  _hideBar() {
    if (this._barEl) this._barEl.classList.remove('pdfp-on');
  }

  _showBar() {
    if (!this._ensureSelEls()) return;
    if (!this._barEl) return;
    this._barEl.classList.add('pdfp-on');
    this._placeBar();
    this._syncBar();
  }

  /** 浮条默认贴在选区上沿，上方放不下就翻到下方；水平居中并夹在页面内 */
  _placeBar() {
    const bar = this._barEl;
    const sel = this._sel;
    if (!bar || !sel) return;
    const pageEl = this._pageEls[sel.pageIdx];
    const css = this._pageCss[sel.pageIdx];
    if (!pageEl || !css) return;

    const pageRect = pageEl.getBoundingClientRect();
    const vpRect = this.viewportEl.getBoundingClientRect();
    const bw = bar.offsetWidth || 220;
    const bh = bar.offsetHeight || 32;

    const selLeft = sel.x0 * css.w;
    const selTop = sel.y0 * css.h;
    const selW = Math.max(1, (sel.x1 - sel.x0) * css.w);
    const selH = Math.max(1, (sel.y1 - sel.y0) * css.h);

    let left = selLeft + selW / 2 - bw / 2;
    left = clamp(left, 2, Math.max(2, css.w - bw - 2));

    const topAbove = selTop - bh - 8;
    const topBelow = selTop + selH + 8;
    const clientAbove = pageRect.top + topAbove;
    const clientBelow = pageRect.top + topBelow;

    let top;
    if (clientAbove >= vpRect.top + 4) {
      top = topAbove;
    } else if (clientBelow + bh <= vpRect.bottom - 4) {
      top = topBelow;
    } else {
      // 上下都放不下（选区几乎占满视口）：贴住视口上沿
      top = clamp(vpRect.top + 4 - pageRect.top, 0, Math.max(0, css.h - bh));
    }
    bar.style.left = left.toFixed(2) + 'px';
    bar.style.top = top.toFixed(2) + 'px';
  }

  _syncBar() {
    const bar = this._barEl;
    if (!bar) return;
    const btn = bar.querySelector('[data-act="text"]');
    if (!btn) return;
    const ready = !!this._clip;
    const text = ready ? String(this._clip.text || '').trim() : '';
    btn.classList.toggle('pdfp-off', ready && !text);
    btn.title = !ready ? '把框内文字贴到白板' : text ? '把框内文字贴到白板' : '本页无文本层（扫描件）';
    btn.setAttribute('aria-disabled', ready && !text ? 'true' : 'false');
  }

  _setBarBusy(busy) {
    if (!this._barEl) return;
    this._barEl.classList.toggle('pdfp-busy', !!busy);
  }

  _onBarDown = (e) => {
    // 只做阻止冒泡：避免点到浮条时在页面上重新开始框选
    e.stopPropagation();
  };

  _onBarClick = (e) => {
    e.stopPropagation();
    const target = e.target;
    const btn = target instanceof Element ? target.closest('[data-act]') : null;
    if (!btn) return;
    e.preventDefault();
    const act = btn.dataset.act;
    if (act === 'send') this._sendToBoard().catch(() => {});
    else if (act === 'text') this._pasteText().catch(() => {});
    else if (act === 'copy') this._copySelection().catch(() => {});
    else if (act === 'close') this._clearSelection();
  };

  /* ============================================================
     剪贴块生成
     ============================================================ */

  async _ensureClip() {
    if (!this._sel) return null;
    const key = selKey(this._sel);
    if (this._clip && this._clipKey === key) return this._clip;
    if (this._clipTask) {
      try {
        return await this._clipTask;
      } catch {
        return null;
      }
    }
    return this._startClip({ writeClipboard: false });
  }

  _startClip({ writeClipboard = false } = {}) {
    const sel = this._sel;
    if (!sel || !this._pdf || this._disposed) return Promise.resolve(null);
    const snapshot = { ...sel };
    const key = selKey(snapshot);
    const seq = ++this._clipSeq;
    const token = this._openToken;

    const promise = (async () => {
      if (seq === this._clipSeq) this._setBarBusy(true);
      let result = null;
      try {
        result = await this._buildClip(snapshot);
      } catch {
        result = null;
      }
      if (this._disposed || token !== this._openToken) return null;
      const payload = result ? result.payload : null;
      if (seq !== this._clipSeq) return payload;       // 已被更新的请求取代

      this._setBarBusy(false);
      if (!this._sel || selKey(this._sel) !== key) return payload;   // 选区已变，丢弃

      this._clip = payload;
      this._clipBlob = result ? result.blob : null;
      this._clipKey = payload ? key : '';
      this._syncBar();
      if (payload) {
        try {
          this.opts.onClipAvailable?.(payload);
        } catch {
          /* 外壳回调异常不应影响阅读器 */
        }
        if (writeClipboard && this._clipBlob) void this._copyBlob(this._clipBlob);
      } else {
        this._toast('截图生成失败，请重新框选');
      }
      return payload;
    })();

    this._clipTask = promise;
    const clear = () => {
      if (this._clipTask === promise) this._clipTask = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  /**
   * 高倍离屏渲染整页 → 按选区相对坐标裁切 → PNG。
   * cropScale = clamp(视图缩放 × 1.8, 2, 6)，并保证整页像素宽 ≤ 4000；
   * dpr = cropScale / 视图缩放，白板按 width / dpr 显示即等于屏幕所见大小。
   */
  async _buildClip(sel) {
    const token = this._openToken;
    const viewScale = this._scale > 0 ? this._scale : 1;
    const page = await this._getPage(sel.pageIdx + 1);
    if (this._disposed || token !== this._openToken) return null;

    const size = this._pageSizes[sel.pageIdx] || { w: 612, h: 792 };
    let cropScale = clamp(viewScale * 1.8, 2, 6);
    if (size.w * cropScale > CROP_MAX_WIDTH) cropScale = CROP_MAX_WIDTH / size.w;
    if (size.w * size.h * cropScale * cropScale > CROP_MAX_PIXELS) {
      cropScale = Math.sqrt(CROP_MAX_PIXELS / (size.w * size.h));
    }
    cropScale = Math.max(0.2, cropScale);

    const viewport = page.getViewport({ scale: cropScale });
    const fullW = Math.max(1, Math.round(viewport.width));
    const fullH = Math.max(1, Math.round(viewport.height));
    const full = document.createElement('canvas');
    full.width = fullW;
    full.height = fullH;
    const ctx = full.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('无法创建离屏画布');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, fullW, fullH);

    await page.render({ canvasContext: ctx, viewport, intent: 'display' }).promise;
    if (this._disposed || token !== this._openToken) return null;

    let sx = Math.round(sel.x0 * fullW);
    let sy = Math.round(sel.y0 * fullH);
    let ex = Math.round(sel.x1 * fullW);
    let ey = Math.round(sel.y1 * fullH);
    sx = clamp(sx, 0, fullW - 1);
    sy = clamp(sy, 0, fullH - 1);
    ex = clamp(ex, sx + 1, fullW);
    ey = clamp(ey, sy + 1, fullH);
    const w = Math.max(1, ex - sx);
    const h = Math.max(1, ey - sy);

    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d');
    if (!octx) throw new Error('无法创建裁切画布');
    octx.drawImage(full, sx, sy, w, h, 0, 0, w, h);

    const dataUrl = out.toDataURL('image/png');
    const blob = await canvasToBlob(out);
    const text = await this._extractText(sel);
    if (this._disposed || token !== this._openToken) return null;

    // 及时释放大画布，降低内存峰值
    full.width = 0;
    full.height = 0;

    const payload = {
      type: 'clip',
      page: sel.pageIdx + 1,
      dataUrl,
      width: w,
      height: h,
      text,
      dpr: cropScale / viewScale,
    };
    return { payload, blob };
  }

  async _extractText(sel) {
    try {
      const page = await this._getPage(sel.pageIdx + 1);
      const viewport = page.getViewport({ scale: 1 });
      const content = await this._getTextContent(sel.pageIdx, page);
      return extractTextInRect(content, viewport, sel);
    } catch {
      return '';
    }
  }

  /* ============================================================
     剪贴板 / 送板
     ============================================================ */

  async _copyBlob(blob) {
    if (!blob) return false;
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function') return false;
      if (typeof window.ClipboardItem !== 'function') return false;
      const item = new window.ClipboardItem({ 'image/png': blob });
      await navigator.clipboard.write([item]);
      return true;
    } catch {
      return false;   // 权限/焦点等原因失败时静默忽略
    }
  }

  /** 取当前选区的 PNG Blob；正常情况下 _buildClip 已经生成了，兜底再从 dataURL 还原 */
  async _clipPngBlob() {
    if (this._clipBlob) return this._clipBlob;
    const url = this._clip && this._clip.dataUrl;
    if (!url) return null;
    try {
      const res = await fetch(url);
      return await res.blob();
    } catch {
      return null;
    }
  }

  async _copySelection() {
    if (!this._sel) return;
    const clip = await this._ensureClip();
    if (!clip) {
      this._toast('截图还没准备好，请稍候重试');
      return;
    }
    const blob = await this._clipPngBlob();
    const ok = await this._copyBlob(blob);
    this._toast(ok ? '已复制选区图片' : '复制失败：浏览器拒绝了剪贴板写入');
  }

  async _sendToBoard() {
    if (!this._sel) {
      this._toast('先在页面上拖拽框选一块区域');
      return;
    }
    const clip = await this._ensureClip();
    if (!clip) {
      this._toast('截图还没准备好，请稍候重试');
      return;
    }
    if (typeof this.opts.onSendToBoard !== 'function') {
      this._toast('外壳没有提供“贴到白板”接口');
      return;
    }
    try {
      this.opts.onSendToBoard(clip);
    } catch {
      this._toast('贴到白板失败');
    }
  }

  async _pasteText() {
    if (!this._sel) return;
    const clip = await this._ensureClip();
    const text = clip ? String(clip.text || '').trim() : '';
    if (!text) {
      this._toast('本页无文本层（扫描件）');
      return;
    }
    // 优先走外壳注入的 onTextToBoard 回调；没有回调时退回 Board.addText
    const direct = this.opts.onTextToBoard;
    const board = window.dsh && window.dsh.board;
    try {
      if (typeof direct === 'function') {
        direct(text);
        this._toast('已贴文本到白板');
        return;
      }
      if (board && typeof board.addText === 'function') {
        board.addText(text, { fontSize: 16 });
        this._toast('已贴文本到白板');
        return;
      }
    } catch {
      /* 落到剪贴板方案 */
    }
    try {
      await navigator.clipboard.writeText(text);
      this._toast('已复制框内文字，可到白板双击新建文字后粘贴');
    } catch {
      this._toast('复制文字失败');
    }
  }

  /* ============================================================
     加载提示
     ============================================================ */

  _setLoading(text, pct) {
    if (this.loadingTextEl) this.loadingTextEl.textContent = text;
    if (this.loadingFillEl) this.loadingFillEl.style.width = clamp(Number(pct) || 0, 0, 100) + '%';
  }

  _showLoading(text, pct) {
    if (!this.loadingEl) return;
    this.loadingEl.hidden = false;
    this._setLoading(text || '正在加载 PDF…', pct);
  }

  _hideLoading() {
    if (this.loadingEl) this.loadingEl.hidden = true;
    this._setLoading('正在加载 PDF…', 0);
  }

  _updateLoadingProgress(p) {
    const loaded = p && Number.isFinite(p.loaded) ? p.loaded : 0;
    const total = p && Number.isFinite(p.total) ? p.total : 0;
    if (total > 0) {
      const pct = Math.round((loaded / total) * 100);
      this._setLoading(`正在加载 PDF… ${pct}%`, pct);
    } else {
      this._setLoading('正在加载 PDF…', 0);
    }
  }
}
