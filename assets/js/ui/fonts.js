// 文字可以用的字型。思源黑體 / 宋體在頁面載入時就有；其他 Google Fonts 用到時才載入，
// 讓編輯器開啟得快。canvas 畫字之前字型必須載入完成，所以匯出前也要確認一次。

import { _t } from '../i18n.js';

export const FONTS = [
  { family: 'Noto Sans TC', label: _t('思源黑體') },
  { family: 'Noto Serif TC', label: _t('思源宋體') },
  { family: 'LXGW WenKai TC', label: _t('霞鶩文楷（手寫感）'), css: 'LXGW+WenKai+TC:wght@400;700' },
  { family: 'Huninn', label: _t('粉圓體（圓潤可愛）'), css: 'Huninn' },
  { family: 'Bebas Neue', label: _t('Bebas Neue（英文標題）'), css: 'Bebas+Neue' },
  { family: 'Bungee', label: _t('Bungee（英文招牌字）'), css: 'Bungee' },
  { family: 'Permanent Marker', label: _t('Permanent Marker（英文麥克筆）'), css: 'Permanent+Marker' },
  { family: 'Pacifico', label: _t('Pacifico（英文草寫）'), css: 'Pacifico' },
  { family: 'Playfair Display', label: _t('Playfair（英文襯線）'), css: 'Playfair+Display:wght@400;700;900' },
  { family: 'system-ui', label: _t('系統字型') },
  { family: 'ui-monospace', label: _t('等寬字型') },
];

const linked = new Set();

/** 載入字型（第一次用到時加上 Google Fonts 的樣式表），sample 是要顯示的字，中文字型依字分批下載 */
export async function ensureFont(family, sample = 'Aa') {
  const f = FONTS.find(x => x.family === family);
  if (f?.css && !linked.has(family)) {
    linked.add(family);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${f.css}&display=swap`;
    const loaded = new Promise(r => { link.onload = r; link.onerror = r; setTimeout(r, 4000); });
    document.head.appendChild(link);
    await loaded;
  }
  if (!document.fonts?.load || !f || family.startsWith('system') || family.startsWith('ui-')) return;
  try {
    await Promise.race([
      Promise.all([400, 700, 900].map(w => document.fonts.load(`${w} 48px "${family}"`, sample || 'Aa'))),
      new Promise(r => setTimeout(r, 6000)), // 網路很慢時不要卡住
    ]);
  } catch { /* 載入失敗就用後備字型 */ }
}

/** 專案裡所有文字用到的字型 */
export function ensureProjectFonts(project) {
  const byFamily = new Map();
  for (const c of project.clips) {
    if (c.type !== 'text') continue;
    byFamily.set(c.text.fontFamily, (byFamily.get(c.text.fontFamily) || '') + c.text.content);
  }
  return Promise.all([...byFamily].map(([family, sample]) => ensureFont(family, sample)));
}
