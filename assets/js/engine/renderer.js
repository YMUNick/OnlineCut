// 畫面合成：把某個時間點的所有片段畫到 canvas 上。預覽與匯出共用。
// 座標一律以「專案解析度」的像素計算；canvas 比較小時會整體縮放。

import { activeClipsAt, clipOpacityAt } from '../core/project.js';

export const TEXT_LINE_HEIGHT = 1.25;
export const TEXT_PAD = 0.3; // 背景框內距（字級的倍數）

export function fontString(text, size = text.fontSize) {
  const family = text.fontFamily ? `"${text.fontFamily}", ` : '';
  return `${text.italic ? 'italic ' : ''}${text.fontWeight || 400} ${size}px ${family}"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif`;
}

/**
 * 計算片段在畫面上的位置與大小（專案像素，未旋轉前）。
 * 影像預設「完整放進畫面」(contain)，scale = 1 時剛好塞滿其中一邊。
 * measureText(font, line) 用來量文字寬度。
 */
export function clipLayout(project, clip, mediaInfo, measureText) {
  const W = project.width, H = project.height;
  const { x, y, scale, rotation } = clip.transform;
  let w, h;
  if (clip.type === 'text') {
    const t = clip.text;
    const lines = String(t.content ?? '').split('\n');
    const font = fontString(t);
    const textW = Math.max(1, ...lines.map(l => measureText(font, l)));
    const pad = t.background ? t.fontSize * TEXT_PAD * 2 : 0;
    w = (textW + pad) * scale;
    h = (lines.length * t.fontSize * TEXT_LINE_HEIGHT + pad) * scale;
  } else {
    const mw = mediaInfo?.width || W, mh = mediaInfo?.height || H;
    const fit = Math.min(W / mw, H / mh);
    w = mw * fit * scale;
    h = mh * fit * scale;
  }
  return { cx: W / 2 + x, cy: H / 2 + y, w, h, rotation };
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
export function drawFrame(ctx, project, t, { getSource, getMediaInfo }) {
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
      drawText(ctx, clip, layout);
    } else {
      const src = getSource(clip);
      if (src && isDrawable(src)) {
        try {
          // mediabunny 的 VideoSample 自己會處理旋轉資訊（手機直拍影片）
          if (typeof src.draw === 'function') src.draw(ctx, -layout.w / 2, -layout.h / 2, layout.w, layout.h);
          else ctx.drawImage(src, -layout.w / 2, -layout.h / 2, layout.w, layout.h);
        } catch { /* 畫面尚未就緒 */ }
      }
    }
    ctx.restore();
  }
  ctx.restore();
  return layouts;
}

function isDrawable(src) {
  if (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement) return src.readyState >= 2;
  if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) return src.complete && src.naturalWidth > 0;
  return true;
}

function drawText(ctx, clip, layout) {
  const t = clip.text;
  const s = clip.transform.scale;
  ctx.scale(s, s);
  const w = layout.w / s, h = layout.h / s;
  const lines = String(t.content ?? '').split('\n');
  const lh = t.fontSize * TEXT_LINE_HEIGHT;
  const pad = t.background ? t.fontSize * TEXT_PAD : 0;

  if (t.background) {
    ctx.fillStyle = t.background;
    roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(t.fontSize * 0.25, h / 2));
    ctx.fill();
  }
  ctx.font = fontString(t);
  ctx.textBaseline = 'middle';
  ctx.textAlign = t.align || 'center';
  const ax = t.align === 'left' ? -w / 2 + pad : t.align === 'right' ? w / 2 - pad : 0;
  const top = -h / 2 + pad + lh / 2;

  if (t.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = t.fontSize * 0.12;
    ctx.shadowOffsetY = t.fontSize * 0.04;
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
