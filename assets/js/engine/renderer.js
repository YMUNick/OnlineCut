// 畫面合成：把某個時間點的所有片段畫到 canvas 上。預覽與匯出共用。
// 座標一律以「專案解析度」的像素計算；canvas 比較小時會整體縮放。

import { activeClipsAt, clipOpacityAt } from '../core/project.js';
import { TEXT_DECOS } from './text-deco.js';

export const TEXT_LINE_HEIGHT = 1.25;
export const TEXT_PAD = 0.3; // 背景框內距（字級的倍數）

export function fontString(text, size = text.fontSize) {
  const family = text.fontFamily ? `"${text.fontFamily}", ` : '';
  return `${text.italic ? 'italic ' : ''}${text.fontWeight || 400} ${size}px ${family}"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif`;
}

/** 文字本身（含背景框內距）的大小，未縮放 */
export function textBox(t, measureText) {
  const lines = String(t.content ?? '').split('\n');
  const font = fontString(t);
  const textW = Math.max(1, ...lines.map(l => measureText(font, l)));
  const pad = t.background ? t.fontSize * TEXT_PAD : 0;
  const lh = t.fontSize * TEXT_LINE_HEIGHT;
  return { lines, pad, lh, w: textW + pad * 2, h: lines.length * lh + pad * 2 };
}

/** 文字加上外框造型之後的大小；ox / oy 是文字框中心相對於造型中心的位移（未縮放） */
export function textOuter(t, box) {
  const deco = TEXT_DECOS[t.deco];
  return deco ? deco.box(box.w, box.h, t.fontSize) : { w: box.w, h: box.h, ox: 0, oy: 0 };
}

/**
 * 計算片段在畫面上的位置與大小（專案像素，未旋轉前）。
 * 影像預設「完整放進畫面」(contain)，scale = 1 時剛好塞滿其中一邊。
 * measureText(font, line) 用來量文字寬度。
 */
export function clipLayout(project, clip, mediaInfo, measureText) {
  const W = project.width, H = project.height;
  const { x, y, scale, rotation } = clip.transform;
  if (clip.frame && clip.type !== 'text') {
    // 有畫面框：範圍就是框本身，不旋轉
    const f = clip.frame;
    return { cx: (f.x + f.w / 2) * W, cy: (f.y + f.h / 2) * H, w: f.w * W, h: f.h * H, rotation: 0, framed: true };
  }
  let w, h;
  if (clip.type === 'text') {
    const box = textBox(clip.text, measureText);
    const outer = textOuter(clip.text, box);
    // text：文字框本身的位置（雙擊編輯時用來對齊輸入框）
    return {
      cx: W / 2 + x, cy: H / 2 + y, w: outer.w * scale, h: outer.h * scale, rotation,
      text: { ox: outer.ox * scale, oy: outer.oy * scale, w: box.w * scale, h: box.h * scale },
    };
  } else {
    const mw = mediaInfo?.width || W, mh = mediaInfo?.height || H;
    const fit = Math.min(W / mw, H / mh);
    w = mw * fit * scale;
    h = mh * fit * scale;
  }
  return { cx: W / 2 + x, cy: H / 2 + y, w, h, rotation };
}

/**
 * 畫面框裡的影像位置（相對於框的中心）：裁切填滿框，
 * transform.scale 是取景縮放、transform.x / y 是取景平移。
 */
export function framedContent(clip, layout, mediaInfo) {
  const mw = mediaInfo?.width || layout.w, mh = mediaInfo?.height || layout.h;
  const s = Math.max(layout.w / mw, layout.h / mh) * clip.transform.scale;
  const w = mw * s, h = mh * s;
  return { x: clip.transform.x - w / 2, y: clip.transform.y - h / 2, w, h };
}

/** 畫面框的形狀路徑（以框的中心為原點） */
export function framePath(ctx, shape, w, h, inset = 0) {
  const x = -w / 2 + inset, y = -h / 2 + inset;
  const iw = Math.max(0, w - inset * 2), ih = Math.max(0, h - inset * 2);
  if (shape === 'circle') {
    ctx.beginPath();
    ctx.ellipse(0, 0, iw / 2, ih / 2, 0, 0, Math.PI * 2);
  } else if (shape === 'round') {
    roundRect(ctx, x, y, iw, ih, Math.max(0, Math.min(w, h) * 0.08 - inset));
  } else {
    ctx.beginPath();
    ctx.rect(x, y, iw, ih);
  }
}

/** 點 (px, py) 是否落在旋轉後的片段範圍內 */
export function hitTest(layout, px, py) {
  const rad = (-layout.rotation * Math.PI) / 180;
  const dx = px - layout.cx, dy = py - layout.cy;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.abs(lx) <= layout.w / 2 && Math.abs(ly) <= layout.h / 2;
}

export function filterString(f, k = 1) {
  const parts = [];
  if (f.brightness !== 100) parts.push(`brightness(${f.brightness}%)`);
  if (f.contrast !== 100) parts.push(`contrast(${f.contrast}%)`);
  if (f.saturation !== 100) parts.push(`saturate(${f.saturation}%)`);
  if (f.grayscale > 0) parts.push(`grayscale(${f.grayscale}%)`);
  if (f.blur > 0) parts.push(`blur(${f.blur * k}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

const measureCache = new Map();
/** 字型載入完成後要清掉：之前量到的是後備字型的寬度 */
export function clearTextMeasureCache() { measureCache.clear(); }
function makeMeasurer(ctx) {
  return (font, line) => {
    const key = font + '\u0000' + line;
    let w = measureCache.get(key);
    if (w === undefined) {
      ctx.save();
      ctx.font = font;
      w = ctx.measureText(line).width;
      ctx.restore();
      if (measureCache.size > 2000) measureCache.clear();
      measureCache.set(key, w);
    }
    return w;
  };
}

/**
 * 畫一格。getSource(clip) 回傳可以 drawImage 的東西（video / image / canvas），沒有就跳過。
 * 回傳每個畫出來的片段的 layout（給預覽的選取框用）。
 */
export function drawFrame(ctx, project, t, { getSource, getMediaInfo, hideTextFor = null }) {
  const canvas = ctx.canvas;
  const k = canvas.width / project.width;
  const measure = makeMeasurer(ctx);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = project.background || '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.imageSmoothingQuality = 'high';

  const layouts = new Map();
  for (const clip of activeClipsAt(project, t)) {
    if (clip.type === 'audio') continue;
    const alpha = clipOpacityAt(clip, t);
    const layout = clipLayout(project, clip, getMediaInfo(clip), measure);
    layouts.set(clip.id, layout);
    if (alpha <= 0) continue;

    ctx.save();
    ctx.globalAlpha = alpha;
    const filter = filterString(clip.filters, k);
    if (filter !== 'none') ctx.filter = filter;
    ctx.translate(layout.cx, layout.cy);
    if (layout.rotation) ctx.rotate((layout.rotation * Math.PI) / 180);

    if (clip.type === 'text') {
      drawText(ctx, clip, layout, measure, clip.id === hideTextFor);
    } else if (layout.framed) {
      ctx.filter = 'none';
      drawFramed(ctx, clip, layout, getSource(clip), getMediaInfo(clip), filter, k);
    } else {
      drawSource(ctx, getSource(clip), -layout.w / 2, -layout.h / 2, layout.w, layout.h);
    }
    ctx.restore();
  }
  ctx.restore();
  return layouts;
}

function drawSource(ctx, src, x, y, w, h) {
  if (!src || !isDrawable(src)) return;
  try {
    // mediabunny 的 VideoSample 自己會處理旋轉資訊（手機直拍影片）
    if (typeof src.draw === 'function') src.draw(ctx, x, y, w, h);
    else ctx.drawImage(src, x, y, w, h);
  } catch { /* 畫面尚未就緒 */ }
}

function drawFramed(ctx, clip, layout, src, mediaInfo, filter, k) {
  const f = clip.frame;
  const { w, h } = layout;
  if (f.shadow) {
    // shadowBlur / offset 不受 transform 影響，要自己換算成 canvas 像素
    const short = Math.min(w, h);
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = short * 0.08 * k;
    ctx.shadowOffsetY = short * 0.02 * k;
    ctx.fillStyle = '#000';
    framePath(ctx, f.shape, w, h);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  framePath(ctx, f.shape, w, h);
  ctx.clip();
  if (filter !== 'none') ctx.filter = filter;
  const c = framedContent(clip, layout, mediaInfo);
  drawSource(ctx, src, c.x, c.y, c.w, c.h);
  ctx.restore();
  if (f.border > 0) {
    ctx.lineWidth = f.border;
    ctx.strokeStyle = f.borderColor;
    framePath(ctx, f.shape, w, h, f.border / 2);
    ctx.stroke();
  }
}

function isDrawable(src) {
  if (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement) return src.readyState >= 2;
  if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) return src.complete && src.naturalWidth > 0;
  return true;
}

/** hideGlyphs：正在預覽上直接編輯這段文字時，只畫外框造型與背景，字由輸入框顯示 */
function drawText(ctx, clip, layout, measure, hideGlyphs = false) {
  const t = clip.text;
  const s = clip.transform.scale;
  ctx.scale(s, s);
  const { lines, pad, lh, w, h } = textBox(t, measure);
  const deco = TEXT_DECOS[t.deco];
  if (deco) {
    const outer = textOuter(t, { w, h });
    ctx.save();
    deco.draw(ctx, outer.w, outer.h, t, t.fontSize);
    ctx.restore();
    ctx.translate(outer.ox, outer.oy);
  }

  if (t.background) {
    ctx.fillStyle = t.background;
    roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(t.fontSize * 0.25, h / 2));
    ctx.fill();
  }
  if (hideGlyphs) return;
  ctx.font = fontString(t);
  ctx.textBaseline = 'middle';
  ctx.textAlign = t.align || 'center';
  const ax = t.align === 'left' ? -w / 2 + pad : t.align === 'right' ? w / 2 - pad : 0;
  const top = -h / 2 + pad + lh / 2;

  // shadowBlur 不受 transform 影響，要換算成 canvas 像素
  const k = Math.hypot(ctx.getTransform().a, ctx.getTransform().b) || 1;
  if (t.glow) {
    // 發光：同色的大範圍模糊，畫兩次比較亮
    ctx.shadowColor = t.glow;
    ctx.shadowBlur = t.fontSize * 0.35 * k;
  } else if (t.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = t.fontSize * 0.12 * k;
    ctx.shadowOffsetY = t.fontSize * 0.04 * k;
  }
  lines.forEach((line, i) => {
    const y = top + i * lh;
    if (t.strokeWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = t.strokeWidth * 2;
      ctx.strokeStyle = t.strokeColor || '#000';
      ctx.strokeText(line, ax, y);
    }
    ctx.fillStyle = t.color || '#fff';
    ctx.fillText(line, ax, y);
    if (t.glow) ctx.fillText(line, ax, y);
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 文字貼圖的縮圖：用跟預覽一樣的方式畫，縮放到放得進 canvas */
export function renderTextPreview(canvas, text, rotation = 0) {
  const ctx = canvas.getContext('2d');
  const measure = makeMeasurer(ctx);
  const box = textBox(text, measure);
  const outer = textOuter(text, box);
  const k = Math.min(canvas.width * 0.86 / outer.w, canvas.height * 0.8 / outer.h);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.scale(k, k);
  drawText(ctx, { text, transform: { scale: 1 } }, null, measure);
  ctx.restore();
}
