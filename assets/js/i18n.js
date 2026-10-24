// 介面語言：繁體中文（預設）與英文。
// 程式裡的文字一律寫中文、用 _t() 包起來（t 在這個專案常用來表示時間，所以不用 t）；中文本身就是字典的 key，英文字典只在需要時載入。
//   _t('已匯入 {n} 個素材', { n: 3 })
// 英文字典的值可以是 { one, other }（依 vars.n 決定單複數）。

export const LANGS = [
  { id: 'zh-TW', label: '中文' },
  { id: 'en', label: 'English' },
];
const KEY = 'onlinecut.lang';

function normalize(l) {
  if (!l) return null;
  if (/^zh/i.test(l)) return 'zh-TW';
  if (/^en/i.test(l)) return 'en';
  return null;
}

/** ?lang= 參數 → 上次的選擇 → 瀏覽器語言（中文以外都用英文） */
function detect() {
  if (typeof window === 'undefined') return 'zh-TW'; // Node（單元測試）
  try {
    const q = normalize(new URLSearchParams(location.search).get('lang'));
    if (q) { try { localStorage.setItem(KEY, q); } catch { /* 私密模式 */ } return q; }
  } catch { /* 忽略 */ }
  try {
    const saved = normalize(localStorage.getItem(KEY));
    if (saved) return saved;
  } catch { /* 私密模式 */ }
  const nav = (typeof navigator !== 'undefined' && (navigator.languages?.[0] || navigator.language)) || '';
  return normalize(nav) === 'zh-TW' ? 'zh-TW' : 'en';
}

export const lang = detect();
export const isEn = lang === 'en';
const dict = isEn ? (await import('./i18n-en.js')).default : null;

export function _t(zh, vars) {
  let s = dict?.[zh] ?? zh;
  if (s && typeof s === 'object') s = vars?.n === 1 ? s.one : s.other;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

/** 換語言：記住選擇並重新載入（網址帶 ?lang=，方便分享） */
export function setLang(id) {
  try { localStorage.setItem(KEY, id); } catch { /* 私密模式 */ }
  const url = new URL(location.href);
  url.searchParams.set('lang', id);
  location.href = url.toString();
}

/** 連到站內其他頁面時帶上目前的語言 */
export function withLang(href) {
  if (!isEn) return href;
  return href + (href.includes('?') ? '&' : '?') + 'lang=en';
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const ATTRS = ['title', 'aria-label', 'placeholder', 'alt', 'content'];

/**
 * 翻譯靜態 HTML：先試整個元素的 innerHTML（段落裡夾著 <kbd>、<b> 的句子），
 * 再試個別的文字節點與屬性。
 */
export function translateDom(root = document.documentElement) {
  if (!dict) return;
  const visit = (el) => {
    for (const a of ATTRS) {
      const v = el.getAttribute?.(a);
      if (v && dict[norm(v)] != null) el.setAttribute(a, _t(norm(v)));
    }
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
    if (el.children?.length) {
      const html = norm(el.innerHTML);
      if (dict[html] != null) { el.innerHTML = _t(html); return; }
    }
    for (const n of [...el.childNodes]) {
      if (n.nodeType === 3) {
        const k = norm(n.nodeValue);
        if (k && dict[k] != null) n.nodeValue = n.nodeValue.replace(n.nodeValue.trim(), _t(k));
      } else if (n.nodeType === 1) {
        visit(n);
      }
    }
  };
  visit(root);
  document.documentElement.lang = 'en';
}

/** 語言切換按鈕（頂端列 / 首頁導覽列用） */
export function languageSwitch(className = '') {
  const other = LANGS.find(l => l.id !== lang);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = other.id === 'en' ? 'EN' : '中文';
  b.title = other.id === 'en' ? 'Switch to English' : '切換成中文';
  b.setAttribute('aria-label', b.title);
  b.lang = other.id;
  b.addEventListener('click', () => setLang(other.id));
  return b;
}
