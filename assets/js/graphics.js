import { _t } from './i18n.js';
// 內建圖案：文字貼圖、背景、貼圖、邊框裝飾。
// 文字貼圖是有外框造型的文字片段（可以改字、換字型）；其他是即時產生的 SVG，不用下載、放大也清楚。
// 背景與邊框依專案解析度產生；貼圖固定 512×512、背景透明。

export const GRAPHIC_CATEGORIES = [
  { id: 'text', label: _t('文字貼圖'), hint: _t('可以改字：在預覽上點兩下') },
  { id: 'bg', label: _t('背景') },
  { id: 'sticker', label: _t('貼圖') },
  { id: 'frame', label: _t('邊框裝飾') },
];

export const STICKER_SIZE = 512;
const FONT = 'Arial Black, Arial, Helvetica, sans-serif';

/** 可重現的亂數，讓同一個圖案每次產生都一樣 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (n) => Math.round(n * 10) / 10;
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
const linear = (id, stops, [x1, y1, x2, y2] = [0, 0, 1, 1]) =>
  `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops.map((c, i) => `<stop offset="${i / (stops.length - 1)}" stop-color="${c}"/>`).join('')}</linearGradient>`;
const glow = (id, color, opacity = 0.85) =>
  `<radialGradient id="${id}"><stop offset="0" stop-color="${color}" stop-opacity="${opacity}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`;

/** 正弦波的封閉路徑（從底部往上填） */
function wavePath(W, H, base, amp, len, phase) {
  const pts = [];
  const n = 64;
  for (let i = 0; i <= n; i++) {
    const x = (W * i) / n;
    pts.push(`${r1(x)} ${r1(base + Math.sin((x / len) * Math.PI * 2 + phase) * amp)}`);
  }
  return `M0 ${H}L${pts.join('L')}L${W} ${H}Z`;
}

/** 星形（n 個尖角） */
function starPoints(cx, cy, n, outer, inner, rot = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? inner : outer;
    const a = rot + (i * Math.PI) / n;
    pts.push(`${r1(cx + Math.cos(a) * r)},${r1(cy + Math.sin(a) * r)}`);
  }
  return pts.join(' ');
}

/** 四角閃光 */
const sparkle = (cx, cy, r) =>
  `M${cx} ${cy - r}Q${cx} ${cy} ${cx + r} ${cy}Q${cx} ${cy} ${cx} ${cy + r}Q${cx} ${cy} ${cx - r} ${cy}Q${cx} ${cy} ${cx} ${cy - r}Z`;

// ============================================================
// 背景
// ============================================================
const BACKGROUNDS = [
  {
    id: 'sunset', label: _t('夕陽漸層'),
    draw: (W, H) => `<defs>${linear('g', ['#ffc371', '#ff5c39', '#c2185b', '#5b2a86'])}${glow('s', '#fff5d6', 0.7)}</defs>
      <rect width="${W}" height="${H}" fill="url(#g)"/><circle cx="${W * 0.78}" cy="${H * 0.2}" r="${Math.max(W, H) * 0.42}" fill="url(#s)"/>`,
  },
  {
    id: 'ocean', label: _t('海洋藍'),
    draw: (W, H) => `<defs>${linear('g', ['#5ee7df', '#2f7de1', '#1b1464'], [0, 0, 0.4, 1])}${glow('s', '#ffffff', 0.35)}</defs>
      <rect width="${W}" height="${H}" fill="url(#g)"/><circle cx="${W * 0.2}" cy="${H * 0.1}" r="${Math.max(W, H) * 0.5}" fill="url(#s)"/>`,
  },
  {
    id: 'mint', label: _t('清新薄荷'),
    draw: (W, H) => `<defs>${linear('g', ['#f6ffe0', '#b8f0b0', '#4fc3a1'], [0, 0, 1, 1])}</defs><rect width="${W}" height="${H}" fill="url(#g)"/>`,
  },
  {
    id: 'aurora', label: _t('霓虹光暈'),
    draw: (W, H) => {
      const R = Math.max(W, H);
      const blobs = [['#ff3d7f', 0.15, 0.25, 0.55], ['#7b5cff', 0.85, 0.2, 0.6], ['#00d4ff', 0.7, 0.95, 0.55], ['#ffb84d', 0.1, 0.95, 0.45]];
      return `<defs>${blobs.map(([c], i) => glow(`b${i}`, c, 0.9)).join('')}</defs><rect width="${W}" height="${H}" fill="#0d0a24"/>`
        + blobs.map(([, x, y, r], i) => `<circle cx="${W * x}" cy="${H * y}" r="${R * r}" fill="url(#b${i})"/>`).join('');
    },
  },
  {
    id: 'polka', label: _t('復古波點'),
    draw: (W, H) => {
      const s = Math.round(Math.min(W, H) / 8);
      return `<defs><pattern id="p" width="${s}" height="${s}" patternUnits="userSpaceOnUse">
        <circle cx="${s / 4}" cy="${s / 4}" r="${s * 0.13}" fill="#ff7a59"/><circle cx="${(s * 3) / 4}" cy="${(s * 3) / 4}" r="${s * 0.13}" fill="#ff7a59"/></pattern></defs>
        <rect width="${W}" height="${H}" fill="#fff1dc"/><rect width="${W}" height="${H}" fill="url(#p)"/>`;
    },
  },
  {
    id: 'stripes', label: _t('糖果條紋'),
    draw: (W, H) => {
      const s = Math.round(Math.min(W, H) / 7);
      return `<defs><pattern id="p" width="${s}" height="${s}" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
        <rect width="${s / 2}" height="${s}" fill="#ffc8d7"/></pattern></defs>
        <rect width="${W}" height="${H}" fill="#fff4c9"/><rect width="${W}" height="${H}" fill="url(#p)"/>`;
    },
  },
  {
    id: 'gridpaper', label: _t('方格紙'),
    draw: (W, H) => {
      const s = Math.round(Math.min(W, H) / 14);
      return `<defs><pattern id="p" width="${s}" height="${s}" patternUnits="userSpaceOnUse">
        <path d="M${s} 0V${s}M0 ${s}H${s}" stroke="#b4c9e4" stroke-width="2.5" fill="none"/></pattern></defs>
        <rect width="${W}" height="${H}" fill="#fbfaf5"/><rect width="${W}" height="${H}" fill="url(#p)"/>`;
    },
  },
  {
    id: 'waves', label: _t('海浪'),
    draw: (W, H) => `<defs>${linear('g', ['#fff0e0', '#ffc9a8'], [0, 0, 0, 1])}</defs><rect width="${W}" height="${H}" fill="url(#g)"/>
      <path d="${wavePath(W, H, H * 0.62, H * 0.035, W * 0.55, 0)}" fill="#8fd3ff"/>
      <path d="${wavePath(W, H, H * 0.72, H * 0.04, W * 0.42, 1.8)}" fill="#3fa9f5"/>
      <path d="${wavePath(W, H, H * 0.83, H * 0.03, W * 0.33, 3.1)}" fill="#1c6fd1"/>`,
  },
  {
    id: 'confetti', label: _t('彩色紙花'),
    draw: (W, H) => {
      const r = rng(11);
      const colors = ['#ff5c39', '#ffd23f', '#3ddc97', '#4cc9f0', '#f72585', '#ffffff'];
      const s = Math.min(W, H);
      let out = `<rect width="${W}" height="${H}" fill="#1d1b3a"/>`;
      for (let i = 0; i < 160; i++) {
        const x = r1(r() * W), y = r1(r() * H), c = colors[Math.floor(r() * colors.length)], z = s * (0.008 + r() * 0.014);
        out += r() < 0.6
          ? `<rect x="${r1(x - z)}" y="${r1(y - z / 2.5)}" width="${r1(z * 2)}" height="${r1(z / 1.25)}" rx="${r1(z / 5)}" fill="${c}" transform="rotate(${Math.round(r() * 180)} ${x} ${y})"/>`
          : `<circle cx="${x}" cy="${y}" r="${r1(z * 0.6)}" fill="${c}"/>`;
      }
      return out;
    },
  },
  {
    id: 'night', label: _t('星空'),
    draw: (W, H) => {
      const r = rng(5);
      const s = Math.min(W, H);
      let stars = '';
      for (let i = 0; i < 220; i++) stars += `<circle cx="${r1(r() * W)}" cy="${r1(r() * H * 0.9)}" r="${r1(s * (0.0012 + r() * 0.0025))}" fill="#fff" opacity="${(0.3 + r() * 0.7).toFixed(2)}"/>`;
      for (let i = 0; i < 6; i++) stars += `<path d="${sparkle(r1(r() * W), r1(r() * H * 0.7), r1(s * (0.012 + r() * 0.012)))}" fill="#fff"/>`;
      return `<defs>${linear('g', ['#0b1026', '#2b1d5c', '#7a4bb0'], [0, 0, 0, 1])}${glow('m', '#fff6d5', 0.5)}</defs>
        <rect width="${W}" height="${H}" fill="url(#g)"/>${stars}
        <circle cx="${W * 0.8}" cy="${H * 0.22}" r="${s * 0.22}" fill="url(#m)"/><circle cx="${W * 0.8}" cy="${H * 0.22}" r="${s * 0.07}" fill="#fff6d5"/>`;
    },
  },
];

BACKGROUNDS.push(
  {
    id: 'synthwave', label: _t('復古霓虹'),
    draw: (W, H) => {
      const hz = H * 0.62, cx = W / 2, sunR = Math.min(W, H) * 0.24;
      let grid = '';
      for (let i = 1; i <= 9; i++) { const y = hz + (H - hz) * Math.pow(i / 9, 1.9); grid += `M0 ${r1(y)}H${W}`; }
      for (let i = -14; i <= 14; i++) grid += `M${r1(cx + i * W * 0.012)} ${r1(hz)}L${r1(cx + i * W * 0.11)} ${H}`;
      let bars = '';
      for (let i = 0; i < 6; i++) { const y = hz - sunR * 0.5 + i * sunR * 0.11; bars += `<rect x="${r1(cx - sunR)}" y="${r1(y)}" width="${r1(sunR * 2)}" height="${r1(sunR * (0.025 + i * 0.012))}" fill="#2a0845"/>`; }
      return `<defs>${linear('sky', ['#12002b', '#4a0a6b', '#ff2e88'], [0, 0, 0, 1])}${linear('sun', ['#ffe66d', '#ff8a5c', '#ff2e88'], [0, 0, 0, 1])}
        <clipPath id="above"><rect width="${W}" height="${r1(hz)}"/></clipPath></defs>
        <rect width="${W}" height="${H}" fill="url(#sky)"/>
        <g clip-path="url(#above)"><circle cx="${cx}" cy="${r1(hz)}" r="${r1(sunR)}" fill="url(#sun)"/>${bars}</g>
        <rect y="${r1(hz)}" width="${W}" height="${r1(H - hz)}" fill="#14002a"/>
        <path d="${grid}" stroke="#ff4fd8" stroke-width="${r1(Math.min(W, H) * 0.003)}" stroke-opacity=".85" fill="none"/>
        <rect y="${r1(hz - 2)}" width="${W}" height="4" fill="#ff8ad8"/>`;
    },
  },
  {
    id: 'pastel', label: _t('粉彩泡泡'),
    draw: (W, H) => {
      const R = Math.max(W, H);
      const blobs = [['#ffc8dd', 0.1, 0.2, 0.45], ['#bde0fe', 0.9, 0.15, 0.5], ['#cdb4db', 0.75, 0.9, 0.5], ['#a2d2ff', 0.2, 0.95, 0.4], ['#ffafcc', 0.5, 0.5, 0.3]];
      return `<defs>${blobs.map(([c], i) => glow(`p${i}`, c, 1)).join('')}</defs><rect width="${W}" height="${H}" fill="#fff6fb"/>`
        + blobs.map(([, x, y, r], i) => `<circle cx="${W * x}" cy="${H * y}" r="${R * r}" fill="url(#p${i})"/>`).join('');
    },
  },
  {
    id: 'halftone', label: _t('漫畫網點'),
    draw: (W, H) => {
      const s = Math.round(Math.min(W, H) / 26);
      return `<defs><pattern id="d" width="${s}" height="${s}" patternUnits="userSpaceOnUse" patternTransform="rotate(20)"><circle cx="${s / 2}" cy="${s / 2}" r="${s * 0.32}" fill="#ff7a45"/></pattern>
        <radialGradient id="fade" cx=".75" cy=".25" r=".9"><stop offset="0" stop-color="#ffd23f" stop-opacity="0"/><stop offset=".55" stop-color="#ffd23f" stop-opacity=".2"/><stop offset="1" stop-color="#ffd23f" stop-opacity="1"/></radialGradient></defs>
        <rect width="${W}" height="${H}" fill="#ffd23f"/><rect width="${W}" height="${H}" fill="url(#d)"/><rect width="${W}" height="${H}" fill="url(#fade)"/>`;
    },
  },
);

// ============================================================
// 貼圖（512×512，背景透明）
// ============================================================
const INK = '#1b1440';
const STICKERS = [
  {
    id: 'heart', label: _t('愛心'),
    draw: () => {
      const d = 'M256 448C120 352 48 280 48 190c0-62 48-110 108-110 42 0 78 22 100 58 22-36 58-58 100-58 60 0 108 48 108 110 0 90-72 162-208 258z';
      return `<defs>${linear('g', ['#ff8fb1', '#ff2d55'], [0, 0, 0.6, 1])}</defs>
        <path d="${d}" fill="#c2003a" transform="translate(0 14)" opacity=".35"/><path d="${d}" fill="url(#g)" stroke="#fff" stroke-width="14" stroke-linejoin="round"/>
        <ellipse cx="160" cy="170" rx="44" ry="26" fill="#fff" opacity=".45" transform="rotate(-35 160 170)"/>`;
    },
  },
  {
    id: 'sparkles', label: _t('閃閃發亮'),
    draw: () => `<defs>${linear('g', ['#fff7c2', '#ffc93c', '#ff9f1c'], [0, 0, 1, 1])}</defs>
      <path d="${sparkle(220, 280, 190)}" fill="url(#g)"/><path d="${sparkle(400, 120, 90)}" fill="url(#g)"/><path d="${sparkle(410, 400, 56)}" fill="url(#g)"/>`,
  },
  {
    id: 'arrow', label: _t('手繪箭頭'),
    draw: () => {
      const line = 'M80 420C120 260 250 160 420 150';
      const head = 'M340 90L425 150L350 222';
      const stroke = (c, w) => `<path d="${line}" stroke="${c}" stroke-width="${w}" fill="none" stroke-linecap="round"/><path d="${head}" stroke="${c}" stroke-width="${w}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
      return stroke('#ffffff', 54) + stroke('#ff5c39', 30);
    },
  },
  {
    id: 'pin', label: _t('地點'),
    draw: () => `<ellipse cx="256" cy="470" rx="90" ry="22" fill="#000" opacity=".25"/>
      <path d="M256 466C176 360 104 282 104 198a152 152 0 0 1 304 0c0 84-72 162-152 268z" fill="#ff3d5a" stroke="#fff" stroke-width="14" stroke-linejoin="round"/>
      <circle cx="256" cy="198" r="58" fill="#fff"/>`,
  },
  {
    id: 'check', label: _t('打勾'),
    draw: () => `<circle cx="256" cy="256" r="220" fill="#2ecc71" stroke="#fff" stroke-width="18"/><path d="M150 262l72 72 142-150" stroke="#fff" stroke-width="46" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  {
    id: 'smile', label: _t('笑臉'),
    draw: () => `<defs>${linear('g', ['#ffe680', '#ffb800'], [0, 0, 0, 1])}</defs><circle cx="256" cy="256" r="220" fill="url(#g)" stroke="#fff" stroke-width="14"/>
      <ellipse cx="186" cy="210" rx="24" ry="34" fill="#5a3a00"/><ellipse cx="326" cy="210" rx="24" ry="34" fill="#5a3a00"/>
      <circle cx="140" cy="290" r="28" fill="#ff7a8a" opacity=".55"/><circle cx="372" cy="290" r="28" fill="#ff7a8a" opacity=".55"/>
      <path d="M160 300q96 100 192 0" stroke="#5a3a00" stroke-width="22" fill="none" stroke-linecap="round"/>`,
  },
];

STICKERS.push(
  {
    id: 'star', label: _t('星星'),
    draw: () => `<defs>${linear('g', ['#fff3a0', '#ffc93c', '#ff9f1c'], [0, 0, 0.3, 1])}</defs>
      <polygon points="${starPoints(256, 272, 5, 226, 100)}" fill="#b86e00" transform="translate(0 12)" opacity=".35"/>
      <polygon points="${starPoints(256, 272, 5, 226, 100)}" fill="url(#g)" stroke="#fff" stroke-width="16" stroke-linejoin="round"/>
      <ellipse cx="210" cy="200" rx="34" ry="18" fill="#fff" opacity=".5" transform="rotate(-30 210 200)"/>`,
  },
  {
    id: 'fire', label: _t('火焰'),
    draw: () => `<defs>${linear('g', ['#ffd23f', '#ff7a1a', '#ff2e2e'], [0, 1, 0, 0])}</defs>
      <path d="M256 36C300 128 412 182 402 322C394 420 322 482 256 482C182 482 110 424 110 330C110 252 168 212 190 140C208 190 228 210 250 216C238 150 238 92 256 36Z" fill="url(#g)" stroke="#fff" stroke-width="14" stroke-linejoin="round"/>
      <path d="M256 236C292 292 340 322 330 392C322 440 290 462 256 462C220 462 186 440 184 396C182 352 214 332 226 292C236 316 248 322 256 324C252 292 248 262 256 236Z" fill="#fff3a0"/>`,
  },
  {
    id: 'crown', label: _t('王冠'),
    draw: () => `<defs>${linear('g', ['#fff1a8', '#ffc93c', '#e0a000'], [0, 0, 0, 1])}</defs>
      <path d="M78 382L104 160L190 272L256 112L322 272L408 160L434 382Z" fill="url(#g)" stroke="#fff" stroke-width="14" stroke-linejoin="round"/>
      <rect x="70" y="372" width="372" height="62" rx="16" fill="#e0a000" stroke="#fff" stroke-width="14"/>
      <circle cx="104" cy="156" r="24" fill="#ff3d5a" stroke="#fff" stroke-width="8"/><circle cx="256" cy="108" r="28" fill="#4cc9f0" stroke="#fff" stroke-width="8"/><circle cx="408" cy="156" r="24" fill="#ff3d5a" stroke="#fff" stroke-width="8"/>
      <circle cx="176" cy="403" r="14" fill="#ff3d5a"/><circle cx="256" cy="403" r="14" fill="#2ecc71"/><circle cx="336" cy="403" r="14" fill="#ff3d5a"/>`,
  },
  {
    id: 'music', label: _t('音符'),
    draw: () => `<g fill="#7b5cff" stroke="#fff" stroke-width="16" stroke-linejoin="round" paint-order="stroke">
      <path d="M176 120L392 70V350H364V150L204 186V392H176Z"/>
      <ellipse cx="146" cy="394" rx="66" ry="48" transform="rotate(-18 146 394)"/>
      <ellipse cx="334" cy="352" rx="66" ry="48" transform="rotate(-18 334 352)"/></g>`,
  },
  {
    id: 'bolt', label: _t('閃電'),
    draw: () => `<polygon points="300,26 112,292 236,292 194,486 404,196 276,196 340,26" fill="#ffd23f" stroke="#1b1440" stroke-width="14" stroke-linejoin="round"/>
      <polygon points="300,60 160,262 250,262 230,380 352,224 254,224 306,60" fill="#fff6c2" opacity=".55"/>`,
  },
  {
    id: 'like', label: _t('按讚'),
    draw: () => `<circle cx="256" cy="256" r="226" fill="#2f7de1" stroke="#fff" stroke-width="16"/>
      <rect x="128" y="236" width="60" height="148" rx="12" fill="#fff"/>
      <path d="M204 236L258 140C266 120 300 122 300 150L292 214H368C392 214 406 236 400 258L380 362C376 378 362 388 346 388H204Z" fill="#fff"/>`,
  },
);

// ============================================================
// 邊框裝飾（跟畫面一樣大，中間透明）
// ============================================================
/** 有洞的形狀：外框是整個畫面，中間挖掉一個圓角矩形 */
function holePath(W, H, l, t, r, b, rad) {
  const x0 = l, y0 = t, x1 = W - r, y1 = H - b;
  return `M0 0H${W}V${H}H0Z M${x0 + rad} ${y0}H${x1 - rad}Q${x1} ${y0} ${x1} ${y0 + rad}V${y1 - rad}Q${x1} ${y1} ${x1 - rad} ${y1}H${x0 + rad}Q${x0} ${y1} ${x0} ${y1 - rad}V${y0 + rad}Q${x0} ${y0} ${x0 + rad} ${y0}Z`;
}

const FRAMES = [
  {
    id: 'border', label: _t('白色圓角框'),
    draw: (W, H) => { const s = Math.min(W, H), m = s * 0.035; return `<path d="${holePath(W, H, m, m, m, m, s * 0.045)}" fill="#fff" fill-rule="evenodd"/>`; },
  },
  {
    id: 'polaroid', label: _t('拍立得'),
    draw: (W, H) => {
      const s = Math.min(W, H), m = s * 0.055;
      return `<path d="${holePath(W, H, m, m, m, m * 3, s * 0.006)}" fill="#fbfaf6" fill-rule="evenodd"/>
        <rect x="${m}" y="${m}" width="${W - 2 * m}" height="${H - 4 * m}" fill="none" stroke="#000" stroke-opacity=".12" stroke-width="${s * 0.004}"/>`;
    },
  },
  {
    id: 'film', label: _t('底片'),
    draw: (W, H) => {
      const s = Math.min(W, H), bar = s * 0.11, hole = bar * 0.42, gap = hole * 1.6;
      let holes = '';
      for (let x = gap / 2; x < W; x += gap) for (const y of [(bar - hole) / 2, H - bar + (bar - hole) / 2]) holes += `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(hole * 0.8)}" height="${r1(hole)}" rx="${r1(hole * 0.15)}" fill="#f4efe4"/>`;
      return `<rect width="${W}" height="${bar}" fill="#111"/><rect y="${H - bar}" width="${W}" height="${bar}" fill="#111"/>${holes}`;
    },
  },
  {
    id: 'vignette', label: _t('暗角'),
    draw: (W, H) => `<defs><radialGradient id="v" cx=".5" cy=".5" r=".75"><stop offset=".5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".85"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#v)"/>`,
  },
  {
    id: 'cinema', label: _t('電影黑邊'),
    draw: (W, H) => {
      const bar = W >= H ? Math.max(H * 0.06, (H - W / 2.39) / 2) : H * 0.12;
      return `<rect width="${W}" height="${r1(bar)}" fill="#000"/><rect y="${r1(H - bar)}" width="${W}" height="${r1(bar)}" fill="#000"/>`;
    },
  },
  {
    id: 'neon', label: _t('霓虹框'),
    draw: (W, H) => {
      const s = Math.min(W, H), m = s * 0.05, w = s * 0.012;
      const rect = (inset, c, sw) => `<rect x="${m + inset}" y="${m + inset}" width="${W - 2 * (m + inset)}" height="${H - 2 * (m + inset)}" rx="${s * 0.04}" fill="none" stroke="${c}" stroke-width="${sw}"/>`;
      return `<defs><filter id="f" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${r1(w * 1.2)}"/></filter></defs>
        <g filter="url(#f)">${rect(0, '#ff4fd8', w * 2)}${rect(w * 2.5, '#4cf0ff', w * 1.4)}</g>${rect(0, '#ffd6f6', w * 0.7)}${rect(w * 2.5, '#d8fdff', w * 0.5)}`;
    },
  },
  {
    id: 'rec', label: _t('錄影畫面'),
    draw: (W, H) => {
      const s = Math.min(W, H), m = s * 0.06, L = s * 0.1, w = s * 0.008;
      const c = (x, y, dx, dy) => `<path d="M${x} ${y + dy * L}V${y}H${x + dx * L}" stroke="#fff" stroke-width="${w}" fill="none" stroke-linecap="round"/>`;
      return c(m, m, 1, 1) + c(W - m, m, -1, 1) + c(m, H - m, 1, -1) + c(W - m, H - m, -1, -1)
        + `<circle cx="${m + s * 0.05}" cy="${m + s * 0.06}" r="${s * 0.018}" fill="#ff3030"/>`
        + `<text x="${m + s * 0.085}" y="${m + s * 0.06}" dy=".35em" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${r1(s * 0.045)}" fill="#fff">REC</text>`
        + `<path d="M${W / 2 - s * 0.025} ${H / 2}H${W / 2 + s * 0.025}M${W / 2} ${H / 2 - s * 0.025}V${H / 2 + s * 0.025}" stroke="#fff" stroke-opacity=".8" stroke-width="${w * 0.6}"/>`;
    },
  },
];

FRAMES.push(
  {
    id: 'speedlines', label: _t('漫畫集中線'),
    draw: (W, H) => {
      const r = rng(21), cx = W / 2, cy = H / 2, R = Math.hypot(W, H) / 2, n = 110;
      let d = '';
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + r() * 0.04, spread = 0.008 + r() * 0.018, inner = 0.55 + r() * 0.25;
        // 外緣兩點在畫面外，尖端朝向中心（橢圓形的空白區）
        const ex = (ang) => `${r1(cx + Math.cos(ang) * R * 1.05)} ${r1(cy + Math.sin(ang) * R * 1.05)}`;
        const tip = `${r1(cx + Math.cos(a) * W / 2 * inner)} ${r1(cy + Math.sin(a) * H / 2 * inner)}`;
        d += `M${ex(a - spread)}L${tip}L${ex(a + spread)}Z`;
      }
      return `<path d="${d}" fill="#111" fill-opacity=".88"/>`;
    },
  },
  {
    id: 'crt', label: _t('復古電視'),
    draw: (W, H) => {
      const s = Math.min(W, H), m = s * 0.05;
      return `<defs><pattern id="sl" width="8" height="6" patternUnits="userSpaceOnUse"><rect width="8" height="2" fill="#000" fill-opacity=".22"/></pattern>
        <radialGradient id="v" cx=".5" cy=".5" r=".72"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".7"/></radialGradient></defs>
        <rect width="${W}" height="${H}" fill="url(#sl)"/><rect width="${W}" height="${H}" fill="url(#v)"/>
        <path d="${holePath(W, H, m, m, m, m, s * 0.09)}" fill="#1a1a1a" fill-rule="evenodd"/>
        <path d="${holePath(W, H, m, m, m, m, s * 0.09)}" fill="none" stroke="#3a3a3a" stroke-width="${r1(s * 0.006)}"/>`;
    },
  },
);

export const GRAPHICS = [
  ...BACKGROUNDS.map(g => ({ ...g, category: 'bg' })),
  ...STICKERS.map(g => ({ ...g, category: 'sticker' })),
  ...FRAMES.map(g => ({ ...g, category: 'frame' })),
];

export function getGraphic(id) {
  return GRAPHICS.find(g => g.id === id) ?? null;
}

/** 產生圖案的 SVG。背景與邊框依畫面大小產生，檔名裡帶尺寸，方便同一個圖案重複使用 */
export function renderGraphic(g, W, H) {
  const sticker = g.category === 'sticker';
  const width = sticker ? STICKER_SIZE : W, height = sticker ? STICKER_SIZE : H;
  return {
    name: sticker ? `${g.label}.svg` : `${g.label} ${W}×${H}.svg`,
    width, height,
    svg: svg(width, height, g.draw(width, height)),
  };
}

// ============================================================
// 文字貼圖：有外框造型的文字片段，加入後可以直接改字、換字型
// place：放在畫面的哪裡（tr 右上、bl 左下、bottom 下方、center 中間）
// ============================================================
const base = { fontFamily: 'Noto Sans TC', italic: false, background: '', strokeWidth: 0, strokeColor: '#000000', align: 'center', shadow: false };
export const TEXT_GRAPHICS = [
  { id: 'tx-burst', label: _t('NEW 爆炸貼'), place: 'tr', rotation: -10,
    text: { ...base, content: 'NEW', fontSize: 110, fontWeight: 900, color: '#ff3d5a', strokeColor: '#1b1440', strokeWidth: 5, deco: 'burst', decoColor: '#ffd23f', decoColor2: '#1b1440' } },
  { id: 'tx-sale', label: _t('特價爆炸貼'), place: 'tr', rotation: 8,
    text: { ...base, content: 'SALE', fontSize: 96, fontWeight: 900, color: '#ffffff', deco: 'burst', decoColor: '#ff3d5a', decoColor2: '#ffffff' } },
  { id: 'tx-bubble', label: _t('對話框'), place: 'center',
    text: { ...base, content: 'WOW!', fontSize: 100, fontWeight: 900, color: '#1b1440', deco: 'bubble', decoColor: '#ffffff', decoColor2: '#1b1440' } },
  { id: 'tx-callout', label: _t('說明框'), place: 'center',
    text: { ...base, content: _t('這裡可以打字'), fontSize: 64, fontWeight: 700, color: '#ffffff', deco: 'bubble', decoColor: '#1b1440', decoColor2: '#ff5c39' } },
  { id: 'tx-subscribe', label: _t('訂閱按鈕'), place: 'bottom',
    text: { ...base, content: _t('訂閱'), fontSize: 64, fontWeight: 900, color: '#ffffff', deco: 'pill', decoColor: '#ff2742', decoColor2: '#ffffff' } },
  { id: 'tx-ribbon', label: _t('絲帶標題'), place: 'center',
    text: { ...base, content: _t('精彩回顧'), fontSize: 80, fontWeight: 900, color: '#ffffff', deco: 'ribbon', decoColor: '#ff5c39', decoColor2: '#b23a1e' } },
  { id: 'tx-lower', label: _t('姓名字幕條'), place: 'bl',
    text: { ...base, content: _t('王小明\n攝影師'), fontSize: 52, fontWeight: 700, color: '#ffffff', align: 'left', deco: 'lower', decoColor: 'rgba(15, 17, 22, 0.82)', decoColor2: '#ff5c39' } },
  { id: 'tx-badge', label: _t('圓章'), place: 'tr', rotation: -8,
    text: { ...base, content: '100%', fontSize: 84, fontWeight: 900, color: '#ffffff', deco: 'badge', decoColor: '#2f7de1', decoColor2: '#ffffff' } },
  { id: 'tx-note', label: _t('便利貼'), place: 'center', rotation: -4,
    text: { ...base, content: _t('記得\n按讚！'), fontSize: 64, fontWeight: 700, color: '#3a2a00', deco: 'note', decoColor: '#ffe873', decoColor2: 'rgba(255, 255, 255, 0.7)' } },
  { id: 'tx-marker', label: _t('螢光筆重點'), place: 'center',
    text: { ...base, content: _t('重點在這裡'), fontSize: 88, fontWeight: 900, color: '#111111', deco: 'marker', decoColor: '#ffe14d', decoColor2: '#ffe14d' } },
  { id: 'tx-tag', label: _t('價格標籤'), place: 'tr', rotation: 6,
    text: { ...base, content: '$199', fontSize: 76, fontWeight: 900, color: '#ffffff', deco: 'tag', decoColor: '#2ecc71', decoColor2: 'rgba(255, 255, 255, 0.85)' } },
];

export function getTextGraphic(id) {
  return TEXT_GRAPHICS.find(g => g.id === id) ?? null;
}
