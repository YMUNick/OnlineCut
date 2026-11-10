// 文字動畫的計算（可在 Node 測試）：給片段裡的時間，算出這一格文字的位移、縮放、旋轉、透明度、模糊與顯示的字數。
// 位移與模糊以「字級」為單位，畫的時候再乘上字級。

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOut = (q) => 1 - Math.pow(1 - q, 3);
/** 稍微衝過頭再回來（彈出） */
const backOut = (q) => { const c = 1.7; return 1 + (c + 1) * Math.pow(q - 1, 3) + c * Math.pow(q - 1, 2); };
/** 落地彈兩下 */
function bounceOut(q) {
  const n = 7.5625, d = 2.75;
  if (q < 1 / d) return n * q * q;
  if (q < 2 / d) return n * (q -= 1.5 / d) * q + 0.75;
  if (q < 2.5 / d) return n * (q -= 2.25 / d) * q + 0.9375;
  return n * (q -= 2.625 / d) * q + 0.984375;
}

/** 進場 / 出場效果：q = 1 表示完全出現，0 表示還沒出現（出場時倒著播） */
function applyReveal(st, kind, q) {
  q = clamp01(q);
  switch (kind) {
    case 'fade': st.alpha *= q; break;
    case 'pop': st.scale *= Math.max(0, backOut(q)); st.alpha *= clamp01(q * 3); break;
    case 'slideUp': st.dy += (1 - easeOut(q)) * 1.2; st.alpha *= q; break;
    case 'slideLeft': st.dx += (1 - easeOut(q)) * 3; st.alpha *= q; break;
    case 'zoom': st.scale *= 1 + (1 - easeOut(q)) * 1.6; st.alpha *= q; break;
    case 'drop': st.dy -= (1 - bounceOut(q)) * 4; st.alpha *= clamp01(q * 4); break;
    case 'blur': st.blur += (1 - q) * 0.45; st.alpha *= q; break;
    case 'typewriter': st.chars = Math.min(st.chars, q); break;
  }
}

/** 持續的動態：t = 片段開始後的秒數 */
function applyLoop(st, kind, t) {
  const w = (period) => Math.sin((2 * Math.PI * t) / period);
  switch (kind) {
    case 'pulse': st.scale *= 1 + 0.06 * w(1.2); break;
    case 'shake': st.dx += 0.035 * w(0.11); st.rot += 2 * w(0.14); break;
    case 'float': st.dy += 0.12 * w(2); break;
    case 'swing': st.rot += 6 * w(1.6); break;
    case 'blink': st.alpha *= 0.55 + 0.45 * Math.cos((2 * Math.PI * t) / 0.9); break;
    case 'rainbow': st.hue = ((t * 120) % 360 + 360) % 360; break;
  }
}

/**
 * anim = { in, out, loop, duration }；local = 片段開始後的秒數；duration = 片段長度。
 * 回傳 { alpha, dx, dy, scale, rot（度）, blur, chars（0–1，打字機顯示的比例）, hue（度） }
 */
export function textAnimState(anim, local, duration) {
  const st = { alpha: 1, dx: 0, dy: 0, scale: 1, rot: 0, blur: 0, chars: 1, hue: 0 };
  if (!anim) return st;
  // 進場和出場都有時各佔不超過一半，不會重疊
  const d = Math.max(1e-3, Math.min(anim.duration, anim.in && anim.out ? duration / 2 : duration));
  if (anim.in && local < d) applyReveal(st, anim.in, local / d);
  if (anim.out && duration - local < d) applyReveal(st, anim.out, (duration - local) / d);
  if (anim.loop) applyLoop(st, anim.loop, local);
  st.alpha = clamp01(st.alpha);
  return st;
}

/** 打字機：一共要顯示幾個字（以字元計，換行不算） */
export function visibleCount(lines, fraction) {
  const total = lines.reduce((n, l) => n + [...l].length, 0);
  return fraction >= 1 ? total : Math.floor(total * clamp01(fraction) + 1e-6);
}
