// 文字的外框造型（爆炸標、對話框、絲帶…）。造型跟著文字大小變化，所以文字可以隨時修改。
// 每個造型：
//   box(bw, bh, fs) → { w, h, ox, oy }：整個造型的大小，以及文字框中心相對於造型中心的位移
//   draw(ctx, w, h, t, fs)：以 (0, 0) 為中心畫出造型（文字由 renderer 畫在上面）
// t.decoColor 是主色、t.decoColor2 是第二色（描邊 / 陰影 / 裝飾）。

const TAU = Math.PI * 2;

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fillStroke(ctx, fill, stroke, lw) {
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke && lw > 0) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = lw;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

/** 柔和的落地陰影（shadowBlur 不受 transform 影響，所以用 transform 的縮放換算） */
function softShadow(ctx, fs, alpha = 0.35) {
  const k = Math.hypot(ctx.getTransform().a, ctx.getTransform().b) || 1;
  ctx.shadowColor = `rgba(0,0,0,${alpha})`;
  ctx.shadowBlur = fs * 0.35 * k;
  ctx.shadowOffsetY = fs * 0.1 * k;
}

export const TEXT_DECOS = {
  // 爆炸標：星形放射，文字在中間
  burst: {
    box: (bw, bh, fs) => { const d = Math.max(bw, bh) * 1.45 + fs * 0.9; return { w: d, h: d, ox: 0, oy: 0 }; },
    draw(ctx, w, h, t, fs) {
      const R = w / 2, r = R * 0.8, n = 16;
      ctx.beginPath();
      for (let i = 0; i < n * 2; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / n;
        const rr = i % 2 ? r : R - fs * 0.05;
        ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
      fillStroke(ctx, t.decoColor, t.decoColor2, fs * 0.09);
    },
  },
  // 對話框：圓角框，下方有尾巴
  bubble: {
    box: (bw, bh, fs) => { const tail = fs * 0.65; return { w: bw + fs * 1.3, h: bh + fs * 0.9 + tail, ox: 0, oy: -tail / 2 }; },
    draw(ctx, w, h, t, fs) {
      const tail = fs * 0.65, x0 = -w / 2, x1 = w / 2, y0 = -h / 2, y1 = h / 2 - tail;
      const r = Math.min((y1 - y0) / 2, fs * 0.7);
      const tx1 = x0 + w * 0.22, tx2 = x0 + w * 0.42, tipX = x0 + w * 0.16;
      ctx.beginPath();
      ctx.moveTo(x0 + r, y0);
      ctx.arcTo(x1, y0, x1, y0 + r, r);
      ctx.arcTo(x1, y1, x1 - r, y1, r);
      ctx.lineTo(tx2, y1);
      ctx.lineTo(tipX, h / 2);
      ctx.lineTo(tx1, y1);
      ctx.arcTo(x0, y1, x0, y1 - r, r);
      ctx.arcTo(x0, y0, x0 + r, y0, r);
      ctx.closePath();
      fillStroke(ctx, t.decoColor, t.decoColor2, fs * 0.08);
    },
  },
  // 膠囊按鈕（例如「訂閱」）
  pill: {
    box: (bw, bh, fs) => ({ w: bw + fs * 1.5, h: bh + fs * 0.7, ox: 0, oy: 0 }),
    draw(ctx, w, h, t, fs) {
      ctx.save();
      softShadow(ctx, fs, 0.3);
      ctx.beginPath();
      roundRectPath(ctx, -w / 2, -h / 2, w, h, h / 2);
      fillStroke(ctx, t.decoColor);
      ctx.restore();
      // 上半部一點光澤
      ctx.beginPath();
      roundRectPath(ctx, -w / 2 + h * 0.18, -h / 2 + h * 0.1, w - h * 0.36, h * 0.32, h * 0.16);
      ctx.fillStyle = 'rgba(255,255,255,.18)';
      ctx.fill();
    },
  },
  // 絲帶標題：中間一條帶子，兩端往後折、有缺口
  ribbon: {
    box: (bw, bh, fs) => ({ w: bw + fs * 3.2, h: bh + fs * 0.8, ox: 0, oy: -fs * 0.15 }),
    draw(ctx, w, h, t, fs) {
      const drop = fs * 0.3, bandW = w - fs * 1.9, bandH = h - drop;
      const by0 = -h / 2, by1 = by0 + bandH;
      const tailIn = bandW / 2 - fs * 0.35, notch = fs * 0.45;
      for (const dir of [-1, 1]) {
        // 往後折的尾巴（暗色）
        ctx.beginPath();
        ctx.moveTo(dir * tailIn, by0 + drop);
        ctx.lineTo(dir * (w / 2), by0 + drop);
        ctx.lineTo(dir * (w / 2 - notch), by0 + drop + bandH / 2);
        ctx.lineTo(dir * (w / 2), by1 + drop);
        ctx.lineTo(dir * tailIn, by1 + drop);
        ctx.closePath();
        fillStroke(ctx, t.decoColor2);
        // 折痕的小三角
        ctx.beginPath();
        ctx.moveTo(dir * (bandW / 2), by1);
        ctx.lineTo(dir * tailIn, by1 + drop);
        ctx.lineTo(dir * tailIn, by1);
        ctx.closePath();
        ctx.fillStyle = 'rgba(0,0,0,.45)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.rect(-bandW / 2, by0, bandW, bandH);
      fillStroke(ctx, t.decoColor);
    },
  },
  // 下方字幕條（名牌）：半透明底，左邊一條亮色
  lower: {
    box: (bw, bh, fs) => ({ w: bw + fs * 1.6, h: bh + fs * 0.6, ox: fs * 0.15, oy: 0 }),
    draw(ctx, w, h, t, fs) {
      ctx.save();
      softShadow(ctx, fs, 0.25);
      ctx.beginPath();
      ctx.rect(-w / 2, -h / 2, w, h);
      fillStroke(ctx, t.decoColor);
      ctx.restore();
      ctx.beginPath();
      ctx.rect(-w / 2, -h / 2, fs * 0.28, h);
      fillStroke(ctx, t.decoColor2);
    },
  },
  // 圓章：實心圓加內圈
  badge: {
    box: (bw, bh, fs) => { const d = Math.hypot(bw, bh) + fs * 0.8; return { w: d, h: d, ox: 0, oy: 0 }; },
    draw(ctx, w, h, t, fs) {
      ctx.save();
      softShadow(ctx, fs, 0.3);
      ctx.beginPath();
      ctx.arc(0, 0, w / 2, 0, TAU);
      fillStroke(ctx, t.decoColor);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(0, 0, w / 2 - fs * 0.22, 0, TAU);
      ctx.setLineDash([fs * 0.12, fs * 0.1]);
      ctx.lineWidth = fs * 0.06;
      ctx.strokeStyle = t.decoColor2;
      ctx.stroke();
      ctx.setLineDash([]);
    },
  },
  // 便利貼：方形紙片、膠帶、右下角摺角
  note: {
    box: (bw, bh, fs) => { const w = bw + fs * 1.4; return { w, h: Math.max(bh + fs * 1.6, w * 0.7), ox: 0, oy: fs * 0.1 }; },
    draw(ctx, w, h, t, fs) {
      const fold = Math.min(w, h) * 0.16;
      ctx.save();
      softShadow(ctx, fs, 0.3);
      ctx.beginPath();
      ctx.moveTo(-w / 2, -h / 2);
      ctx.lineTo(w / 2, -h / 2);
      ctx.lineTo(w / 2, h / 2 - fold);
      ctx.lineTo(w / 2 - fold, h / 2);
      ctx.lineTo(-w / 2, h / 2);
      ctx.closePath();
      fillStroke(ctx, t.decoColor);
      ctx.restore();
      ctx.beginPath();
      ctx.moveTo(w / 2, h / 2 - fold);
      ctx.lineTo(w / 2 - fold, h / 2 - fold);
      ctx.lineTo(w / 2 - fold, h / 2);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,.15)';
      ctx.fill();
      // 膠帶
      ctx.save();
      ctx.rotate(-0.06);
      ctx.beginPath();
      ctx.rect(-w * 0.18, -h / 2 - fs * 0.25, w * 0.36, fs * 0.55);
      ctx.fillStyle = t.decoColor2;
      ctx.globalAlpha *= 0.75;
      ctx.fill();
      ctx.restore();
    },
  },
  // 螢光筆：文字下半部畫一道斜斜的螢光
  marker: {
    box: (bw, bh, fs) => ({ w: bw + fs * 0.6, h: bh + fs * 0.2, ox: 0, oy: 0 }),
    draw(ctx, w, h, t, fs) {
      const y0 = -h / 2 + h * 0.42, y1 = h / 2 - fs * 0.02;
      ctx.beginPath();
      ctx.moveTo(-w / 2 + fs * 0.1, y0 + fs * 0.08);
      ctx.lineTo(w / 2, y0 - fs * 0.04);
      ctx.lineTo(w / 2 - fs * 0.1, y1);
      ctx.lineTo(-w / 2, y1 + fs * 0.04);
      ctx.closePath();
      ctx.fillStyle = t.decoColor;
      ctx.globalAlpha *= 0.9;
      ctx.fill();
    },
  },
  // 價格標籤：左邊尖角、有個小洞
  tag: {
    box: (bw, bh, fs) => { const point = (bh + fs * 0.7) * 0.5; return { w: bw + fs * 1.4 + point, h: bh + fs * 0.7, ox: point / 2, oy: 0 }; },
    draw(ctx, w, h, t, fs) {
      const point = h * 0.5, x0 = -w / 2, r = fs * 0.2;
      ctx.save();
      softShadow(ctx, fs, 0.28);
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.lineTo(x0 + point, -h / 2);
      ctx.arcTo(w / 2, -h / 2, w / 2, h / 2, r);
      ctx.arcTo(w / 2, h / 2, x0 + point, h / 2, r);
      ctx.lineTo(x0 + point, h / 2);
      ctx.closePath();
      fillStroke(ctx, t.decoColor);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(x0 + point * 0.75, 0, fs * 0.13, 0, TAU);
      ctx.fillStyle = t.decoColor2;
      ctx.fill();
    },
  },
};
