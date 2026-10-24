// 產生 README 與首頁用的截圖和示範 GIF（中文、英文各一份）。
// 用真的編輯器操作一遍：載入範例、加貼圖、套用圓形小窗，畫面上有假的游標與點擊效果。
//
//   node tools/make-media.mjs            # 需要 playwright（含 chromium）與 ffmpeg
//
// 輸出：assets/img/editor-preview.jpg、editor-preview-en.jpg、demo-zh.gif、demo-en.gif

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'assets/img');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
const FPS = 12;

function serve() {
  const server = createServer(async (req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    try {
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

/** 游標與點擊漣漪（只在錄影時加進頁面） */
const CURSOR = `
  const c = document.createElement('div');
  c.id = '__cursor';
  c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.3-6.6L4 20z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  c.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;pointer-events:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5));transform:translate(-3px,-2px)';
  document.body.appendChild(c);
  window.__ripple = (x, y) => {
    const r = document.createElement('div');
    r.style.cssText = 'position:fixed;z-index:99998;pointer-events:none;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #ff5c39;left:' + x + 'px;top:' + y + 'px;opacity:.9';
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 420);
  };
`;

async function record(browser, base, lang, tmp) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: lang === 'en' ? 'en-US' : 'zh-TW' });
  const page = await ctx.newPage();
  await page.goto(`${base}/editor.html?lang=${lang === 'en' ? 'en' : 'zh-TW'}`);
  await page.waitForFunction(() => window.__oc);
  await page.click('#welcomeSample');
  await page.waitForFunction(() => window.__oc.store.project.clips.length >= 7);
  // 第二個畫面：夜景圖片放在最上面一條新軌，跟標題同時出現（給圓形小窗用）
  await page.evaluate(async () => {
    const P = await import('./assets/js/core/project.js');
    const { store, player } = window.__oc;
    const night = Object.values(store.project.media).filter(m => m.type === 'image')[2];
    let p = P.addTrack(store.project, 'video');
    p = P.addClip(p, 'image', { mediaId: night.id, trackId: p.tracks[0].id, start: 0, duration: 12, name: night.name }).project;
    store.commit(p, { select: [] });
    player.seek(0.6);
    // 暫時把這張圖藏起來，套用版型的時候才出現
    store.commit(P.updateTrack(store.project, store.project.tracks[0].id, { hidden: true }));
  });
  await page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
  await page.addStyleTag({ content: '.toast{display:none!important}' });
  await page.evaluate(CURSOR);
  await page.waitForTimeout(500);

  let frame = 0, t = 0.6, cx = 640, cy = 420;
  const dir = path.join(tmp, lang);
  execFileSync('mkdir', ['-p', dir]);
  const shot = async () => {
    await page.evaluate(([x, y, t]) => {
      const c = document.getElementById('__cursor');
      c.style.left = `${x}px`; c.style.top = `${y}px`;
      window.__oc.player.seek(t);
    }, [cx, cy, t]);
    await page.waitForTimeout(40);
    await page.screenshot({ path: path.join(dir, `f${String(frame++).padStart(4, '0')}.png`) });
    t += 1 / FPS; // 影片跟著時間走，看起來像在播放
  };
  const hold = async (sec) => { for (let i = 0; i < sec * FPS; i++) await shot(); };
  const moveTo = async (sel, sec = 0.34) => {
    const b = await page.locator(sel).first().boundingBox();
    const tx = b.x + b.width / 2, ty = b.y + b.height / 2;
    const n = Math.max(1, Math.round(sec * FPS));
    const x0 = cx, y0 = cy;
    for (let i = 1; i <= n; i++) {
      const k = i / n, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // ease in-out
      cx = x0 + (tx - x0) * e; cy = y0 + (ty - y0) * e;
      await shot();
    }
  };
  const click = async (sel, after = 0.5) => {
    await moveTo(sel);
    await page.evaluate(([x, y]) => window.__ripple(x, y), [cx, cy]);
    await page.locator(sel).first().click();
    await hold(after);
  };

  await hold(0.3);
  await click('.tab[data-tab="graphics"]', 0.15);
  await click('[data-graphic="tx-burst"]', 0.5);
  await click('.tab[data-tab="layout"]', 0.1);
  // 顯示第二個畫面並套用版型（同一格裡完成，看不到中間狀態）
  await moveTo('[data-layout="circle-bl"]');
  await page.evaluate(([x, y]) => window.__ripple(x, y), [cx, cy]);
  await page.evaluate(async () => {
    const P = await import('./assets/js/core/project.js');
    const { store } = window.__oc;
    const hidden = store.project.tracks.find(tr => tr.hidden);
    store.commit(P.updateTrack(store.project, hidden.id, { hidden: false }), { select: [] });
    window.__oc.applyLayout('circle-bl');
  });
  await hold(0.8);
  await click('[data-layout="split-h"]', 1.1);

  // 首頁截圖：子母畫面 + 貼圖 + 標題，游標拿掉
  await page.evaluate(() => { document.getElementById('__cursor').remove(); window.__oc.store.select([]); window.__oc.applyLayout('pip-bl'); window.__oc.store.select([]); });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__oc.player.seek(2.4));
  await page.waitForTimeout(400);
  const jpg = path.join(OUT, lang === 'en' ? 'editor-preview-en.jpg' : 'editor-preview.jpg');
  const png = path.join(tmp, `${lang}.png`);
  await page.screenshot({ path: png });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', png, '-q:v', '3', jpg]);
  await ctx.close();

  // GIF：兩階段調色盤，寬 880（GitHub README 的顯示寬度）
  const gif = path.join(OUT, `demo-${lang === 'en' ? 'en' : 'zh'}.gif`);
  const pal = path.join(tmp, `${lang}-pal.png`);
  const scale = 'scale=880:-1:flags=lanczos';
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(FPS), '-i', path.join(dir, 'f%04d.png'), '-vf', `${scale},palettegen=max_colors=192:stats_mode=diff`, pal]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(FPS), '-i', path.join(dir, 'f%04d.png'), '-i', pal, '-lavfi', `${scale}[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle`, '-loop', '0', gif]);
  console.log(`${lang}: ${frame} frames → ${path.relative(ROOT, gif)}, ${path.relative(ROOT, jpg)}`);
}

const tmp = await mkdtemp(path.join(tmpdir(), 'onlinecut-media-'));
const server = await serve();
const browser = await chromium.launch();
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const lang of ['en', 'zh']) await record(browser, base, lang, tmp);
} finally {
  await browser.close();
  server.close();
  await rm(tmp, { recursive: true, force: true });
}
