#!/usr/bin/env node
// 端到端測試：在真的 Chromium 裡匯入素材、剪輯、儲存、匯出，並用 ffprobe 檢查輸出檔。
//
// 需要：playwright（含 chromium）、ffmpeg / ffprobe
// 執行：node tests/e2e/run.mjs
// 測試已部署的網站：BASE_URL=https://ymunick.github.io/OnlineCut node tests/e2e/run.mjs

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webp': 'image/webp' };

let failures = 0, passed = 0;
async function test(name, fn) {
  // ONLY=關鍵字：只跑名稱包含它的測試（獨立的測試才適合單獨跑）
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${name}\n      ${String(e.stack || e).split('\n').slice(0, 6).join('\n      ')}`);
    // 在 GitHub Actions 上另外輸出成 annotation，不用下載完整紀錄就看得到哪裡失敗
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=${name.replace(/[\r\n:,]/g, ' ')}::${String(e.message || e).slice(0, 600).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  }
}

function serve() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, path.normalize(p));
      if (!file.startsWith(ROOT)) throw new Error('forbidden');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]); }
function probe(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]).toString());
}

async function makeFixtures(dir) {
  const f = {
    video: path.join(dir, 'clip.mp4'), // 註：Playwright 的 setInputFiles 會漏掉中文檔名，所以測試檔用英文
    portrait: path.join(dir, 'vertical.mp4'),
    silent: path.join(dir, 'silent.webm'),
    audio: path.join(dir, 'tone.mp3'),
    image: path.join(dir, 'photo.png'),
    bad: path.join(dir, 'notes.txt'),
    fake: path.join(dir, 'broken.mp4'),
    rotated: path.join(dir, 'phone.mp4'),
    red: path.join(dir, 'red.mp4'),
    blue: path.join(dir, 'blue.mp4'),
  };
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f.video]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f.portrait]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=2', '-c:v', 'libvpx', '-b:v', '300k', f.silent]);
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=5', '-c:a', 'libmp3lame', '-b:a', '96k', f.audio]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=orange:size=800x600:duration=1', '-frames:v', '1', f.image]);
  // 雙畫面版型用：純紅、純藍兩支短片
  for (const c of ['red', 'blue']) ffmpeg(['-f', 'lavfi', '-i', `color=c=${c}:size=640x360:rate=30:duration=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f[c]]);
  // 模擬手機直拍：實際存的是橫的畫面（左紅右藍），加上旋轉 90° 的標記
  const plain = path.join(dir, 'plain.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=red:s=320x360:d=2[a];color=blue:s=320x360:d=2[b];[a][b]hstack', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', plain]);
  ffmpeg(['-display_rotation', '90', '-i', plain, '-c', 'copy', f.rotated]);
  await import('node:fs').then(fs => {
    fs.writeFileSync(f.bad, 'hello');
    fs.writeFileSync(f.fake, Buffer.from('this is not a video'));
  });
  return f;
}

// ----------------------------------------------------------------
const tmp = await mkdtemp(path.join(tmpdir(), 'onlinecut-e2e-'));
const fx = await makeFixtures(tmp);
// 有 BASE_URL 時直接測那個網址（例如 GitHub Pages），否則在本機起一個靜態伺服器
const server = process.env.BASE_URL ? null : await serve();
const BASE = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/+$/, '') : `http://127.0.0.1:${server.address().port}`;
console.log(`測試網址：${BASE}`);
const browser = await chromium.launch();
// 測試用中文介面（Playwright 的瀏覽器預設是英文）；英文版另外測
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, locale: 'zh-TW' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
// 記錄所有錯誤通知，最後檢查有沒有預期以外的
await context.addInitScript(() => {
  // 存在 sessionStorage，重新整理之後也不會遺失
  const KEY = '__errorToasts';
  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('toasts')) return; // 首頁沒有通知區
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
      if (!n.classList?.contains('error')) return;
      const list = JSON.parse(sessionStorage.getItem(KEY) || '[]');
      list.push(n.textContent);
      sessionStorage.setItem(KEY, JSON.stringify(list));
    }))).observe(document.getElementById('toasts'), { childList: true });
  });
});
// 字型走外網，測試環境不載入
await context.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ body: '', contentType: 'text/css' }));

const state = () => page.evaluate(() => {
  const { store, player } = window.__oc;
  return { project: store.project, selection: store.selection, time: player.time, playing: player.playing, canUndo: store.history.canUndo };
});
/** 比對兩個專案，失敗時列出不同的欄位路徑 */
function diffPaths(a, b, p = '') {
  if (a === b) return [];
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return [`${p || '(root)'}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap(k => diffPaths(a[k], b[k], p ? `${p}.${k}` : k));
}
function assertSameProject(actual, expected) {
  const d = diffPaths(actual, expected);
  assert.deepEqual(d, [], `專案不一樣：\n${d.slice(0, 10).join('\n')}`);
}
const clipBox = async (id) => page.locator(`.clip[data-clip-id="${id}"]`).boundingBox();
const waitFor = async (fn, timeout = 10000, label = 'condition') => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await page.waitForTimeout(100); }
  throw new Error(`等待逾時：${label}`);
};

try {
  const newProjectUI = async () => {
    await page.click('#btnProjectMenu');
    await page.click('#btnNew');
    if (await page.locator('.modal .danger-btn').count()) await page.click('.modal .danger-btn');
    await waitFor(async () => { const s = await state(); return !s.project.clips.length && !Object.keys(s.project.media).length; }, 5000, '清空');
  };
  console.log('編輯器');
  await page.goto(`${BASE}/editor.html`);
  await page.waitForFunction(() => window.__oc);

  await test('第一次開啟顯示歡迎畫面、沒有 JS 錯誤', async () => {
    assert.equal(await page.isVisible('#welcome'), true);
    assert.deepEqual(errors, []);
  });

  await test('匯入不支援的檔案會顯示錯誤，不會壞掉', async () => {
    await page.setInputFiles('#fileInput', [fx.bad, fx.fake]);
    await waitFor(async () => (await page.locator('.toast.error').count()) >= 2, 10000, '兩個錯誤通知');
    const s = await state();
    assert.equal(Object.keys(s.project.media).length, 0);
    assert.equal(await page.locator('.media-card.loading').count(), 0);
  });

  await test('匯入影片 + 音樂 + 圖片：自動排進時間軸', async () => {
    await page.setInputFiles('#fileInput', [fx.video, fx.audio, fx.image]);
    await waitFor(async () => (await state()).project.clips.length === 3, 15000, '3 個片段');
    const s = await state();
    const types = s.project.clips.map(c => c.type).sort();
    assert.deepEqual(types, ['audio', 'image', 'video']);
    const v = s.project.clips.find(c => c.type === 'video');
    assert.ok(Math.abs(v.duration - 4) < 0.1, `影片長度 ${v.duration}`);
    const a = s.project.clips.find(c => c.type === 'audio');
    assert.ok(Math.abs(a.duration - 5) < 0.15, `音訊長度 ${a.duration}`);
    const img = s.project.clips.find(c => c.type === 'image');
    assert.equal(img.start, v.duration, '圖片接在影片後面');
    assert.equal(s.project.aspect, '16:9');
    assert.equal(await page.isVisible('#welcome'), false);
    assert.equal(await page.locator('.media-card:not(.loading)').count(), 3);
  });

  await test('產生縮圖與波形', async () => {
    await waitFor(() => page.evaluate(() => {
      const items = [...window.__oc.runtime.items.values()];
      return items.find(i => i.info.type === 'video')?.thumbs.length > 0 && items.find(i => i.info.type === 'audio')?.peaks;
    }), 15000, '縮圖與波形');
  });

  await test('播放：時間往前走、畫面有內容；暫停', async () => {
    await page.keyboard.press('Home');
    await page.locator('#tlScroll').click({ position: { x: 5, y: 200 } }).catch(() => {});
    await page.evaluate(() => window.__oc.player.seek(0));
    await page.click('#btnPlay');
    await page.waitForTimeout(1200);
    const s1 = await state();
    assert.equal(s1.playing, true);
    assert.ok(s1.time > 0.6 && s1.time < 2.5, `播放時間 ${s1.time}`);
    await page.keyboard.press('Space');
    const s2 = await state();
    assert.equal(s2.playing, false);
    // 預覽不是全黑
    const lit = await page.evaluate(() => {
      const c = document.getElementById('previewCanvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 400) sum += d[i] + d[i + 1] + d[i + 2];
      return sum;
    });
    const dbg = await page.evaluate(() => { const c = document.getElementById('previewCanvas'); const p = window.__oc.player; return JSON.stringify({ w: c.width, h: c.height, t: p.time, lay: [...(p.layouts?.values?.() ?? [])], els: [...document.querySelectorAll('video')].map(v => v.readyState), frame: document.getElementById('frame').style.cssText }); });
    assert.ok(lit > 1000, '預覽畫面有東西 ' + dbg);
  });

  await test('播完會停在結尾', async () => {
    const dur = (await state()).project.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    await page.evaluate((d) => window.__oc.player.seek(d - 0.3), dur);
    await page.click('#btnPlay');
    await page.waitForTimeout(900);
    const s = await state();
    assert.equal(s.playing, false);
    assert.ok(Math.abs(s.time - dur) < 0.05, `停在 ${s.time}`);
  });

  let videoId;
  await test('點選片段：屬性面板顯示影片設定', async () => {
    videoId = (await state()).project.clips.find(c => c.type === 'video').id;
    const box = await clipBox(videoId);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.deepEqual((await state()).selection, [videoId]);
    assert.equal(await page.textContent('#inspectorTitle'), '影片片段');
    assert.ok(await page.locator('.inspector >> text=聲音與速度').count());
  });

  await test('屬性面板：輸入不透明度數值', async () => {
    const num = page.locator('.field:has(label:text("不透明")) .num');
    await num.fill('40');
    await num.press('Enter');
    const c = (await state()).project.clips.find(c => c.id === videoId);
    assert.equal(c.opacity, 0.4);
  });

  await test('屬性面板：濾鏡預設「黑白」', async () => {
    await page.click('.chip:text("黑白")');
    const c = (await state()).project.clips.find(c => c.id === videoId);
    assert.equal(c.filters.grayscale, 100);
  });

  await test('復原 / 重做', async () => {
    await page.keyboard.press('Control+z');
    let c = (await state()).project.clips.find(c => c.id === videoId);
    assert.equal(c.filters.grayscale, 0);
    await page.keyboard.press('Control+Shift+z');
    c = (await state()).project.clips.find(c => c.id === videoId);
    assert.equal(c.filters.grayscale, 100);
  });

  await test('拖曳右緣修剪（含吸附到播放頭）', async () => {
    await page.evaluate(() => window.__oc.player.seek(3));
    const box = await clipBox(videoId);
    const pps = await page.evaluate(() => window.__oc.store.pxPerSec);
    await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 3 - pps * 0.97, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    const c = (await state()).project.clips.find(c => c.id === videoId);
    assert.ok(Math.abs(c.duration - 3) < 1e-6, `修剪後長度 ${c.duration}（應吸附到 3）`);
  });

  await test('在播放頭分割 (S)', async () => {
    await page.evaluate(() => window.__oc.player.seek(1.5));
    await page.keyboard.press('s');
    const s = await state();
    const vids = s.project.clips.filter(c => c.type === 'video').sort((a, b) => a.start - b.start);
    assert.equal(vids.length, 2);
    assert.ok(Math.abs(vids[1].srcIn - 1.5) < 1e-6);
  });

  await test('拖曳移動片段到另一條影像軌', async () => {
    const s = await state();
    const right = s.project.clips.filter(c => c.type === 'video').sort((a, b) => b.start - a.start)[0];
    const box = await clipBox(right.id);
    const v2 = await page.locator('.tl-track').first().boundingBox();
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, v2.y + v2.height / 2, { steps: 10 });
    await page.mouse.up();
    const after = (await state()).project;
    const moved = after.clips.find(c => c.id === right.id);
    assert.equal(moved.trackId, after.tracks[0].id, '移到最上面的 V2');
    assert.ok(moved.start > right.start, '往右移');
  });

  await test('波紋刪除 (Shift+Delete) 會補位', async () => {
    const s = await state();
    const v1 = [...s.project.tracks].reverse().find(t => t.kind === 'video');
    const onV1 = s.project.clips.filter(c => c.trackId === v1.id).sort((a, b) => a.start - b.start);
    assert.ok(onV1.length >= 2, `V1 上有 ${onV1.length} 個片段`);
    const [first, second] = onV1;
    await page.evaluate((id) => window.__oc.store.select([id]), first.id);
    await page.keyboard.press('Shift+Delete');
    const after = (await state()).project.clips.find(c => c.id === second.id);
    assert.ok(Math.abs(after.start - (second.start - first.duration)) < 1e-6, `補位後開頭 ${after.start}`);
    await page.keyboard.press('Control+z');
    assert.ok((await state()).project.clips.some(c => c.id === first.id), '復原後回來');
  });

  await test('加入文字並編輯內容', async () => {
    await page.click('.tab[data-tab="text"]');
    await page.evaluate(() => window.__oc.player.seek(0.5));
    await page.click('.text-preset[data-preset="title"]');
    const s = await state();
    const t = s.project.clips.find(c => c.type === 'text');
    assert.ok(t);
    assert.deepEqual(s.selection, [t.id]);
    await page.fill('.inspector textarea', '你好，世界\n第二行');
    const t2 = (await state()).project.clips.find(c => c.id === t.id);
    assert.equal(t2.text.content, '你好，世界\n第二行');
    await page.click('.tab[data-tab="media"]');
  });

  await test('在預覽畫面上拖曳文字（靠近中心會對齊）', async () => {
    const t = (await state()).project.clips.find(c => c.type === 'text');
    await page.evaluate(() => window.__oc.player.seek(1));
    await page.waitForTimeout(150);
    const frame = await page.locator('#frame').boundingBox();
    const cx = frame.x + frame.width / 2, cy = frame.y + frame.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 60, { steps: 6 });
    await page.mouse.up();
    let c = (await state()).project.clips.find(c => c.id === t.id);
    assert.ok(c.transform.x > 100 && c.transform.y > 50, `移動到 ${c.transform.x}, ${c.transform.y}`);
    // 拖回中心附近 → 吸附到 0
    await page.mouse.move(cx + 120, cy + 60);
    await page.mouse.down();
    await page.mouse.move(cx + 2, cy + 1, { steps: 6 });
    await page.mouse.up();
    c = (await state()).project.clips.find(c => c.id === t.id);
    assert.deepEqual([c.transform.x, c.transform.y], [0, 0]);
  });

  await test('專案會自動儲存，重新整理後還在（含素材檔）', async () => {
    const before = await state();
    await page.waitForTimeout(1200);
    await page.reload();
    await page.waitForFunction(() => window.__oc && window.__oc.store.project.clips.length > 0);
    const after = await state();
    assert.equal(after.project.clips.length, before.project.clips.length);
    assert.equal(after.project.name, before.project.name);
    const loaded = await page.evaluate(() => Object.keys(window.__oc.store.project.media).every(id => window.__oc.runtime.has(id)));
    assert.equal(loaded, true, '素材檔都有載回來');
  });

  await test('匯出 MP4：長度、解析度、影音軌都正確', async () => {
    const dur = (await state()).project.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    await page.click('#btnExport');
    try {
      await page.click('#exRes .seg-btn[data-v="480"]');
      await page.click('#exFps .seg-btn[data-v="30"]');
      await page.fill('#exName', 'e2e:export/test'); // 不合法字元要被換掉
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 120000 }),
        page.click('.modal [data-go]'),
      ]);
      const out = path.join(tmp, 'out.mp4');
      await download.saveAs(out);
      assert.equal(download.suggestedFilename(), 'e2e export test.mp4');
      await checkExport(out, dur);
    } finally {
      if (await page.locator('.modal').count()) await page.keyboard.press('Escape');
    }
  });

  await test('匯出預設檔名用專案名稱（中文）', async () => {
    const name = await page.evaluate(async () => {
      const { sanitizeFilename } = await import('./assets/js/engine/exporter.js');
      return sanitizeFilename(window.__oc.store.project.name);
    });
    assert.equal(name, '未命名專案');
  });

  async function checkExport(out, dur) {
    const info = probe(out);
    const v = info.streams.find(s => s.codec_type === 'video');
    const a = info.streams.find(s => s.codec_type === 'audio');
    assert.equal(v.codec_name, 'h264');
    assert.deepEqual([v.width, v.height], [854, 480]);
    assert.ok(a, '有音軌');
    assert.ok(Math.abs(parseFloat(info.format.duration) - dur) < 0.25, `長度 ${info.format.duration} vs ${dur}`);
    assert.ok(await page.isVisible('.export-done'));
  }

  await test('匯出的畫面內容正確（黑白濾鏡 + 前段是測試影像）', async () => {
    const out = path.join(tmp, 'out.mp4');
    const frame = path.join(tmp, 'frame.png');
    ffmpeg(['-ss', '0.2', '-i', out, '-frames:v', '1', frame]);
    const st = await stat(frame);
    assert.ok(st.size > 2000, '有擷取到畫面');
    // 用 ffmpeg 量平均飽和度：套了黑白濾鏡應該接近 0（原始測試影像是彩色的）
    const stats = (file) => {
      const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vf', 'signalstats,metadata=print', '-f', 'null', '-'], { encoding: 'utf8' });
      const num = (k) => parseFloat((r.stderr.match(new RegExp(`lavfi\\.signalstats\\.${k}=([\\d.]+)`)) || [])[1]);
      return { sat: num('SATAVG'), y: num('YAVG') };
    };
    const original = path.join(tmp, 'orig.png');
    ffmpeg(['-ss', '0.2', '-i', fx.video, '-frames:v', '1', original]);
    const o = stats(original), e = stats(frame);
    assert.ok(o.sat > 20, `原始影像飽和度 ${o.sat}`);
    assert.ok(e.sat < 3, `匯出畫面飽和度 ${e.sat}（應為黑白）`);
    assert.ok(e.y < o.y, `不透明度 40% 疊在黑底上應該比較暗：${e.y} vs ${o.y}`);
  });

  await test('只有圖片和文字（沒有聲音）也能匯出', async () => {
    const res = await page.evaluate(async () => {
      const { exportVideo } = await import('./assets/js/engine/exporter.js');
      const P = await import('./assets/js/core/project.js');
      let p = P.createProject({ aspect: '9:16' });
      p = P.addClip(p, 'text', { duration: 1.5, text: { content: '只有文字' } }).project;
      const r = await exportVideo({ project: p, runtime: window.__oc.runtime, settings: { short: 360, fps: 24 } });
      const buf = new Uint8Array(await r.blob.arrayBuffer());
      return { size: buf.length, ext: r.ext, head: Array.from(buf.slice(4, 8)) };
    });
    assert.equal(res.ext, 'mp4');
    assert.ok(res.size > 1000);
    assert.equal(String.fromCharCode(...res.head), 'ftyp');
  });

  await test('空的時間軸不能匯出', async () => {
    const msg = await page.evaluate(async () => {
      const { exportVideo } = await import('./assets/js/engine/exporter.js');
      const P = await import('./assets/js/core/project.js');
      try { await exportVideo({ project: P.createProject(), runtime: window.__oc.runtime }); return 'no error'; } catch (e) { return e.message; }
    });
    assert.match(msg, /空的/);
  });

  await test('取消匯出', async () => {
    const msg = await page.evaluate(async () => {
      const { exportVideo } = await import('./assets/js/engine/exporter.js');
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 50);
      try {
        await exportVideo({ project: window.__oc.store.project, runtime: window.__oc.runtime, signal: ctrl.signal, settings: { short: 480 } });
        return 'finished';
      } catch (e) { return e.name; }
    });
    assert.equal(msg, 'AbortError');
  });

  await test('備援：MediaRecorder 即時錄製 WebM', async () => {
    const res = await page.evaluate(async () => {
      const { exportVideo } = await import('./assets/js/engine/exporter.js');
      const P = await import('./assets/js/core/project.js');
      const src = window.__oc.store.project;
      const vid = Object.values(src.media).find(m => m.type === 'video');
      let p = P.createProject();
      p = P.addMedia(p, vid);
      p = P.addClip(p, 'video', { mediaId: vid.id, duration: 1.5 }).project;
      const r = await exportVideo({ project: p, runtime: window.__oc.runtime, settings: { short: 360, forceRecorder: true } });
      return { size: r.blob.size, ext: r.ext, method: r.method, bytes: Array.from(new Uint8Array(await r.blob.slice(0, 4).arrayBuffer())) };
    });
    assert.equal(res.method, 'recorder');
    assert.equal(res.ext, 'webm');
    assert.ok(res.size > 1000, `大小 ${res.size}`);
    assert.deepEqual(res.bytes, [0x1a, 0x45, 0xdf, 0xa3], 'EBML 開頭');
  });

  await test('瀏覽器不能編碼音訊時改用即時錄製，不會輸出沒有聲音的影片', async () => {
    const res = await page.evaluate(async () => {
      const { exportVideo, detectExportSupport } = await import('./assets/js/engine/exporter.js');
      const P = await import('./assets/js/core/project.js');
      const tone = Object.values(window.__oc.store.project.media).find(m => m.type === 'audio');
      let p = P.createProject();
      p = P.addMedia(p, tone);
      p = P.addClip(p, 'audio', { mediaId: tone.id, duration: 1.2 }).project;
      p = P.addClip(p, 'text', { duration: 1.2 }).project;
      const saved = window.AudioEncoder;
      window.AudioEncoder = undefined;
      try {
        const support = await detectExportSupport(p, { short: 360 });
        const r = await exportVideo({ project: p, runtime: window.__oc.runtime, settings: { short: 360 } });
        return { support: support.method, method: r.method, buf: Array.from(new Uint8Array(await r.blob.arrayBuffer())) };
      } finally {
        window.AudioEncoder = saved;
      }
    });
    assert.equal(res.support, 'recorder');
    assert.equal(res.method, 'recorder');
    const out = path.join(tmp, 'no-aenc.webm');
    await import('node:fs').then(fs => fs.writeFileSync(out, Buffer.from(res.buf)));
    assert.ok(probe(out).streams.some(s => s.codec_type === 'audio'), '要有音軌');
  });

  await test('手機直拍（有旋轉標記）的影片：預覽與匯出方向一致', async () => {
    await newProjectUI();
    await page.setInputFiles('#fileInput', [fx.rotated]);
    await waitFor(async () => (await state()).project.clips.length === 1, 10000, '匯入');
    assert.equal((await state()).project.aspect, '9:16', '顯示尺寸是直的');
    await page.evaluate(() => window.__oc.player.seek(0.5));
    await page.waitForTimeout(500);
    // 預覽（<video> 會自己處理旋轉）上半與下半的顏色
    const preview = await page.evaluate(() => {
      const c = document.getElementById('previewCanvas'), g = c.getContext('2d');
      const px = (fy) => Array.from(g.getImageData(Math.floor(c.width / 2), Math.floor(c.height * fy), 1, 1).data.slice(0, 3));
      return { top: px(0.25), bottom: px(0.75) };
    });
    const res = await page.evaluate(async () => {
      const { exportVideo } = await import('./assets/js/engine/exporter.js');
      const r = await exportVideo({ project: window.__oc.store.project, runtime: window.__oc.runtime, settings: { short: 360 } });
      return Array.from(new Uint8Array(await r.blob.arrayBuffer()));
    });
    const out = path.join(tmp, 'rot-out.mp4');
    await import('node:fs').then(fs => fs.writeFileSync(out, Buffer.from(res)));
    const v = probe(out).streams.find(s => s.codec_type === 'video');
    assert.deepEqual([v.width, v.height], [360, 640]);
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const at = (fy) => { const i = (Math.floor(640 * fy) * 360 + 180) * 3; return [raw[i], raw[i + 1], raw[i + 2]]; };
    const dominant = (rgb) => (rgb[0] > rgb[2] + 60 ? 'red' : rgb[2] > rgb[0] + 60 ? 'blue' : 'other');
    const exported = { top: dominant(at(0.25)), bottom: dominant(at(0.75)) };
    const shown = { top: dominant(preview.top), bottom: dominant(preview.bottom) };
    assert.notEqual(shown.top, shown.bottom, `預覽應該上下不同色：${JSON.stringify(preview)}`);
    assert.deepEqual(exported, shown, '匯出畫面的方向要跟預覽一樣');
  });

  await test('直式影片匯入到空專案會切換成 9:16', async () => {
    await newProjectUI();
    await page.setInputFiles('#fileInput', [fx.portrait]);
    await waitFor(async () => (await state()).project.clips.length === 1, 10000, '匯入直式');
    assert.equal((await state()).project.aspect, '9:16');
  });

  await test('沒有聲音的影片能匯入，並標記為沒有音軌', async () => {
    await page.setInputFiles('#fileInput', [fx.silent]);
    await waitFor(async () => Object.keys((await state()).project.media).length === 2, 10000, '匯入');
    const id = Object.values((await state()).project.media).find(m => m.name === 'silent.webm').id;
    await waitFor(() => page.evaluate((id) => window.__oc.runtime.get(id).hasAudio === false, id), 10000, '判斷出沒有音軌');
  });

  await test('素材卡片上的 ＋ 加到播放頭', async () => {
    const before = (await state()).project.clips.length;
    const card = page.locator('.media-card:not(.loading)').first();
    await card.hover();
    await card.locator('[data-act="add"]').click();
    assert.equal((await state()).project.clips.length, before + 1);
  });

  await test('快捷鍵說明', async () => {
    await page.keyboard.press('?');
    assert.ok(await page.isVisible('.modal >> text=鍵盤快捷鍵'));
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.modal').count(), 0);
  });

  await test('只出現預期中的錯誤通知', async () => {
    const toasts = await page.evaluate(() => JSON.parse(sessionStorage.getItem('__errorToasts') || '[]'));
    console.log(`      錯誤通知：${JSON.stringify(toasts)}`);
    assert.equal(toasts.length, 2, '匯入兩個壞檔應該各有一則');
    assert.match(toasts[0] + toasts[1], /不支援的檔案類型：notes\.txt/);
    assert.match(toasts[0] + toasts[1], /broken\.mp4：檔案損毀，或瀏覽器不支援這種格式/);
  });

  await test('整個流程沒有 JS 錯誤', async () => {
    const real = errors.filter(e => !/Failed to load resource/.test(e));
    assert.deepEqual(real, []);
  });

  console.log('\n專案檔');
  const downloadProject = async ({ includeMedia = true, name = 'e2e-project' } = {}) => {
    await page.keyboard.press('Control+s');
    await page.waitForSelector('.modal >> text=下載專案檔');
    await page.fill('#pfName', name);
    if (!includeMedia) await page.uncheck('#pfMedia');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.modal [data-go]')]);
    const out = path.join(tmp, `${name}-${includeMedia ? 'full' : 'lite'}.onlinecut`);
    await dl.saveAs(out);
    assert.equal(dl.suggestedFilename(), `${name}.onlinecut`);
    await page.keyboard.press('Escape');
    return out;
  };
  const openProjectViaInput = (file) => page.setInputFiles('#projectInput', file);
  let original, fullFile, liteFile;

  await test('新專案：只有素材（時間軸是空的）也會先確認', async () => {
    await newProjectUI();
    await page.setInputFiles('#fileInput', [fx.audio]);
    await waitFor(async () => Object.keys((await state()).project.media).length === 1, 10000, '匯入');
    await page.evaluate(() => window.__oc.store.commit(window.__oc.store.project.clips.reduce((p) => p, window.__oc.store.project)));
    await page.evaluate(async () => {
      const P = await import('./assets/js/core/project.js');
      const s = window.__oc.store;
      s.commit(P.deleteClips(s.project, s.project.clips.map(c => c.id)));
    });
    assert.equal((await state()).project.clips.length, 0);
    await page.click('#btnProjectMenu');
    await page.click('#btnNew');
    assert.ok(await page.isVisible('.modal >> text=開新專案？'), '要跳確認');
    await page.click('.modal [data-cancel]');
    assert.equal(Object.keys((await state()).project.media).length, 1, '取消後素材還在');
  });

  await test('下載專案檔（含素材）：是標準 ZIP，內容齊全', async () => {
    await newProjectUI();
    await page.setInputFiles('#fileInput', [fx.video, fx.audio, fx.image]);
    await waitFor(async () => (await state()).project.clips.length === 3, 15000, '匯入');
    await page.click('.tab[data-tab="text"]');
    await page.click('.text-preset[data-preset="caption"]');
    await page.click('.tab[data-tab="media"]');
    await page.fill('#projectName', '專案檔測試 / 第一集');
    await page.keyboard.press('Enter');
    original = (await state()).project;
    fullFile = await downloadProject();
    const listing = execFileSync('python3', ['-c', 'import zipfile,sys,json\nz=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None\nm=json.loads(z.read("project.json"))\nprint(json.dumps({"names": sorted(z.namelist()), "format": m["format"], "media": m["includesMedia"]}))', fullFile]).toString();
    const info = JSON.parse(listing);
    assert.equal(info.format, 'onlinecut-project');
    assert.equal(info.media, true);
    assert.equal(info.names.length, 4, info.names.join(','));
    assert.ok(info.names.includes('project.json'));
  });

  await test('Ctrl+S 在輸入框裡也會開啟下載專案檔（不會跳出瀏覽器另存網頁）', async () => {
    await page.click('#projectName');
    await page.keyboard.press('Control+s');
    assert.ok(await page.isVisible('.modal >> text=下載專案檔'));
    await page.keyboard.press('Escape');
  });

  await test('下載專案檔（不含素材）：檔案很小', async () => {
    liteFile = await downloadProject({ includeMedia: false, name: 'lite' });
    assert.ok((await stat(liteFile)).size < 20000, `大小 ${(await stat(liteFile)).size}`);
    assert.ok((await stat(fullFile)).size > 30000);
  });

  await test('開啟專案檔前會確認；按取消時目前的專案不變', async () => {
    const before = (await state()).project;
    await openProjectViaInput(fullFile);
    await page.waitForSelector('.modal >> text=開啟專案檔？');
    await page.click('.modal [data-cancel]');
    assert.deepEqual((await state()).project, before);
  });

  await test('開啟壞掉的檔案：顯示錯誤，目前的專案不受影響', async () => {
    const before = (await state()).project;
    const bad = {
      'truncated.onlinecut': (await readFile(fullFile)).subarray(0, 5000),
      'random.onlinecut': Buffer.from('this is definitely not a project file'),
      'future.onlinecut': Buffer.from(JSON.stringify({ format: 'onlinecut-project', version: 99, project: before })),
      'empty.onlinecut': Buffer.alloc(0),
    };
    for (const [name, buf] of Object.entries(bad)) {
      const f = path.join(tmp, name);
      await import('node:fs').then(fs => fs.writeFileSync(f, buf));
      await openProjectViaInput(f);
      await waitFor(async () => (await page.locator('.toast.error').count()) > 0, 5000, `${name} 的錯誤通知`);
      const msg = await page.locator('.toast.error').last().textContent();
      assert.match(msg, /[一-鿿]/, `${name}：${msg}`);
      assert.equal(await page.locator('.modal').count(), 0, `${name} 不應該跳出確認`);
      assert.deepEqual((await state()).project, before, `${name} 不能改到目前的專案`);
      await page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
    }
    const errs = await page.evaluate(() => JSON.parse(sessionStorage.getItem('__errorToasts') || '[]'));
    assert.ok(errs.some(t => /較新版本/.test(t)), '未來版本要提示更新');
  });

  await test('開啟完整專案檔：專案、素材、縮圖都回來，可以播放和匯出', async () => {
    await newProjectUI();
    await openProjectViaInput(fullFile);
    await waitFor(async () => (await state()).project.clips.length === original.clips.length, 15000, '開啟');
    const s = await state();
    assertSameProject(s.project, original);
    assert.equal(s.canUndo, false, '開啟後沒有 undo 紀錄');
    const loaded = await page.evaluate(() => Object.keys(window.__oc.store.project.media).every(id => window.__oc.runtime.has(id)));
    assert.equal(loaded, true);
    assert.equal(await page.locator('.media-card.missing').count(), 0);
    await waitFor(() => page.evaluate(() => [...window.__oc.runtime.items.values()].some(i => i.thumbs.length)), 10000, '縮圖');
    const r = await page.evaluate(async () => {
      const { exportVideo } = await import('./assets/js/engine/exporter.js');
      const res = await exportVideo({ project: window.__oc.store.project, runtime: window.__oc.runtime, settings: { short: 360 } });
      return res.blob.size;
    });
    assert.ok(r > 1000);
  });

  await test('開啟後重新整理還在（素材也存進了瀏覽器）', async () => {
    await page.waitForTimeout(800);
    await page.reload();
    await page.waitForFunction(() => window.__oc && window.__oc.store.project.clips.length > 0);
    assertSameProject((await state()).project, original);
    const loaded = await page.evaluate(() => Object.keys(window.__oc.store.project.media).every(id => window.__oc.runtime.has(id)));
    assert.equal(loaded, true);
  });

  await test('不含素材的專案檔：素材標示遺失、不能匯出；匯入原檔後自動接回', async () => {
    await openProjectViaInput(liteFile);
    await page.waitForSelector('.modal >> text=開啟專案檔？');
    await page.click('.modal .danger-btn');
    await waitFor(async () => (await page.locator('.media-card.missing').count()) === 3, 10000, '3 個遺失');
    const errs = await page.evaluate(() => JSON.parse(sessionStorage.getItem('__errorToasts') || '[]'));
    assert.match(errs[errs.length - 1], /3 個素材需要重新匯入（這個專案檔沒有包含素材）/);
    // 匯出要被擋下來
    await page.click('#btnExport');
    assert.equal(await page.locator('.modal').count(), 0, '不應該開啟匯出對話框');
    // 匯入同一個檔案 → 接回，不新增素材
    await page.setInputFiles('#fileInput', [fx.video, fx.image]);
    await waitFor(async () => (await page.locator('.media-card.missing').count()) === 1, 10000, '接回 2 個');
    const s = await state();
    assert.equal(Object.keys(s.project.media).length, 3, '不會多出新的素材');
    assert.deepEqual(s.project.clips, original.clips, '片段不變');
    await page.setInputFiles('#fileInput', [fx.audio]);
    await waitFor(async () => (await page.locator('.media-card.missing').count()) === 0, 10000, '全部接回');
    // 重新整理後還是接好的
    await page.waitForTimeout(500);
    await page.reload();
    await page.waitForFunction(() => window.__oc && window.__oc.store.project.clips.length > 0);
    assert.equal(await page.evaluate(() => Object.keys(window.__oc.store.project.media).every(id => window.__oc.runtime.has(id))), true);
  });

  await test('同名但大小不同的檔案不會被誤接', async () => {
    await openProjectViaInput(liteFile);
    await page.click('.modal .danger-btn');
    await waitFor(async () => (await page.locator('.media-card.missing').count()) === 3, 10000, '遺失');
    const imposter = path.join(tmp, 'imposter', path.basename(fx.image));
    await import('node:fs').then(fs => { fs.mkdirSync(path.dirname(imposter), { recursive: true }); });
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:size=200x200:duration=1', '-frames:v', '1', imposter]);
    await page.setInputFiles('#fileInput', [imposter]);
    await waitFor(async () => Object.keys((await state()).project.media).length === 4, 10000, '當成新素材');
    assert.equal(await page.locator('.media-card.missing').count(), 3);
  });

  await test('把專案檔拖進視窗也能開啟；同時拖了其他檔案會提示', async () => {
    const before = (await state()).project;
    const bytes = [...await readFile(fullFile)];
    await page.evaluate(async (bytes) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], 'dragged.onlinecut'));
      dt.items.add(new File(['x'], 'other.txt', { type: 'text/plain' }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, bytes);
    await page.waitForSelector('.modal >> text=開啟專案檔？');
    assert.ok(await page.locator('.toast >> text=一次只能開啟一個專案檔').count());
    await page.click('.modal .danger-btn');
    // 等素材真的換成專案檔裡的（拖之前有 4 個素材、3 個遺失）
    await waitFor(() => page.evaluate(() => {
      const ids = Object.keys(window.__oc.store.project.media);
      return ids.length === 3 && ids.every(id => window.__oc.runtime.has(id));
    }), 15000, '開啟');
    assert.equal(Object.keys(before.media).length, 4);
    assertSameProject((await state()).project, original);
  });

  await test('專案選單可以用鍵盤操作', async () => {
    await page.click('#btnProjectMenu');
    assert.equal(await page.isVisible('#projectMenu'), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'btnNew');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'btnOpenProject');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'btnSaveProject', '循環到最後一項');
    const clipsBefore = (await state()).project.clips.length;
    await page.keyboard.press('s'); // 選單開著時，不應該觸發「分割」
    assert.equal((await state()).project.clips.length, clipsBefore);
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#projectMenu'), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'btnProjectMenu');
    await page.click('#btnProjectMenu');
    await page.mouse.click(700, 400); // 點外面關閉
    assert.equal(await page.isVisible('#projectMenu'), false);
  });

  console.log('\n其他邊界情況');
  const errorToasts = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('__errorToasts') || '[]'));

  await test('同時開兩個編輯器分頁：兩邊都會警告；匯出中關閉分頁會先確認', async () => {
    const before = (await errorToasts()).length;
    const p2 = await context.newPage();
    p2.on('pageerror', e => errors.push(e.message));
    await p2.goto(`${BASE}/editor.html`);
    await p2.waitForFunction(() => window.__oc);
    await waitFor(async () => (await p2.locator('.toast.error >> text=另一個分頁').count()) > 0, 5000, '新分頁的警告');
    await waitFor(async () => (await errorToasts()).slice(before).some(t => /另一個分頁/.test(t)), 5000, '舊分頁的警告');
    // 在第二個分頁匯出，匯出中試著關閉
    await p2.evaluate(() => { window.__oc.store.select([]); });
    await p2.click('#btnExport');
    await p2.click('.modal [data-go]');
    await p2.waitForSelector('.modal >> text=/渲染畫面|混合聲音|封裝/');
    const dialog = new Promise(r => p2.once('dialog', r));
    await p2.close({ runBeforeUnload: true });
    const d = await Promise.race([dialog, new Promise(r => setTimeout(() => r(null), 5000))]);
    assert.ok(d, '應該要出現離開確認');
    assert.equal(d.type(), 'beforeunload');
    await d.accept();
  });

  await test('在文字框裡打字不會觸發快捷鍵', async () => {
    const t = (await state()).project.clips.find(c => c.type === 'text');
    await page.evaluate((id) => window.__oc.store.select([id]), t.id);
    const before = (await state()).project.clips.length;
    await page.click('.inspector textarea');
    await page.keyboard.type('s s del');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Space');
    const s = await state();
    assert.equal(s.project.clips.length, before, '沒有分割或刪除');
    assert.equal(s.playing, false, '沒有開始播放');
    assert.match(s.project.clips.find(c => c.id === t.id).text.content, /s s del/);
    await page.keyboard.press('Escape');
    await page.locator('#tlScroll').click({ position: { x: 5, y: 5 } });
  });

  await test('0 位元組的檔案：看得懂的錯誤', async () => {
    const f = path.join(tmp, 'zero.mp4');
    await import('node:fs').then(fs => fs.writeFileSync(f, Buffer.alloc(0)));
    const before = (await errorToasts()).length;
    await page.setInputFiles('#fileInput', f);
    await waitFor(async () => (await errorToasts()).length > before, 5000, '錯誤通知');
    assert.match((await errorToasts()).at(-1), /zero\.mp4：檔案損毀，或瀏覽器不支援這種格式/);
  });

  await test('同一個檔案匯入兩次：變成兩個素材，都能用', async () => {
    const n = Object.keys((await state()).project.media).length;
    await page.setInputFiles('#fileInput', [fx.image]);
    await page.setInputFiles('#fileInput', [fx.image]);
    await waitFor(async () => Object.keys((await state()).project.media).length === n + 2, 10000, '兩個新素材');
    assert.equal(await page.evaluate(() => Object.keys(window.__oc.store.project.media).every(id => window.__oc.runtime.has(id))), true);
  });

  await test('沒有 MIME 類型、副檔名大寫的檔案也能匯入（拖放）', async () => {
    const n = Object.keys((await state()).project.media).length;
    const bytes = [...await readFile(fx.audio)];
    await page.evaluate((bytes) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], 'VOICE.MP3', { type: '' }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, bytes);
    await waitFor(async () => Object.keys((await state()).project.media).length === n + 1, 10000, '匯入');
    const m = Object.values((await state()).project.media).find(m => m.name === 'VOICE.MP3');
    assert.equal(m.type, 'audio');
  });

  await test('瀏覽器空間不足（存檔失敗）：提示使用者，素材照樣能用', async () => {
    await page.evaluate(async () => {
      const { store } = await import('./assets/js/media/store.js');
      window.__realSaveFile = store.saveFile;
      store.saveFile = () => Promise.reject(new DOMException('quota', 'QuotaExceededError'));
    });
    try {
      const before = (await errorToasts()).length;
      const n = Object.keys((await state()).project.media).length;
      await page.setInputFiles('#fileInput', [fx.portrait]);
      await waitFor(async () => Object.keys((await state()).project.media).length === n + 1, 10000, '匯入');
      await waitFor(async () => (await errorToasts()).slice(before).some(t => /vertical\.mp4」無法存到瀏覽器（空間可能不足）/.test(t)), 5000, '空間不足的提示');
      const id = Object.values((await state()).project.media).find(m => m.name === 'vertical.mp4').id;
      assert.equal(await page.evaluate((id) => window.__oc.runtime.has(id), id), true);
    } finally {
      await page.evaluate(async () => {
        const { store } = await import('./assets/js/media/store.js');
        store.saveFile = window.__realSaveFile;
      });
    }
  });

  await test('移除素材後按復原：片段回來，素材也還能用', async () => {
    const s0 = await state();
    const used = Object.values(s0.project.media).find(m => s0.project.clips.some(c => c.mediaId === m.id) && m.type === 'video');
    const card = page.locator(`.media-card[data-media-id="${used.id}"]`);
    await card.hover();
    await card.locator('[data-act="remove"]').click();
    await page.click('.modal .danger-btn');
    assert.ok(!(await state()).project.media[used.id]);
    await page.keyboard.press('Control+z');
    const s1 = await state();
    assertSameProject(s1.project, s0.project);
    assert.equal(await page.locator(`.media-card[data-media-id="${used.id}"].missing`).count(), 0);
  });

  await test('鎖定的軌道：不能拖曳、不能刪除', async () => {
    const s0 = await state();
    const clip = s0.project.clips.find(c => c.type === 'video');
    await page.evaluate(async (trackId) => {
      const P = await import('./assets/js/core/project.js');
      const st = window.__oc.store;
      st.commit(P.updateTrack(st.project, trackId, { locked: true }));
    }, clip.trackId);
    const box = await clipBox(clip.id);
    await page.mouse.move(box.x + 10, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    assert.equal((await state()).project.clips.find(c => c.id === clip.id).start, clip.start, '沒有移動');
    await page.evaluate((id) => window.__oc.store.select([id]), clip.id);
    await page.keyboard.press('Delete');
    assert.ok((await state()).project.clips.find(c => c.id === clip.id), '沒有被刪除');
    await page.keyboard.press('Control+z'); // 解鎖
  });

  await test('變速、淡入淡出、表情符號與很長的文字都能正確匯出', async () => {
    const res = await page.evaluate(async () => {
      const P = await import('./assets/js/core/project.js');
      const { exportVideo } = await import('./assets/js/engine/exporter.js');
      const src = window.__oc.store.project;
      const vid = Object.values(src.media).find(m => m.name === 'clip.mp4');
      let p = P.createProject();
      p = P.addMedia(p, vid);
      let r = P.addClip(p, 'video', { mediaId: vid.id, fadeIn: 0.5, fadeOut: 0.5 });
      p = P.updateClip(r.project, r.clip.id, { speed: 2 });
      p = P.addClip(p, 'text', { trackId: p.tracks[0].id, start: 0, duration: 2, text: { content: '🎬🔥 慶祝 '.repeat(40) + '\n第二行 ✨', fontSize: 600 } }).project;
      const out = await exportVideo({ project: p, runtime: window.__oc.runtime, settings: { short: 360 } });
      return { expected: P.getDuration(p), bytes: Array.from(new Uint8Array(await out.blob.arrayBuffer())) };
    });
    const out = path.join(tmp, 'edge.mp4');
    await import('node:fs').then(fs => fs.writeFileSync(out, Buffer.from(res.bytes)));
    const info = probe(out);
    assert.ok(Math.abs(res.expected - 2) < 1e-6, '4 秒的影片 2 倍速 = 2 秒');
    assert.ok(Math.abs(parseFloat(info.format.duration) - 2) < 0.15, `長度 ${info.format.duration}`);
    assert.ok(info.streams.some(s => s.codec_type === 'audio'));
  });

  console.log('\n大型檔案（把門檻調低，用小檔案模擬）');
  const setLimits = (o) => page.evaluate(async (o) => {
    const { storageSettings } = await import('./assets/js/media/store.js');
    const { librarySettings } = await import('./assets/js/media/library.js');
    const { audioSettings } = await import('./assets/js/engine/audio.js');
    if (o.copy != null) storageSettings.copyLimitBytes = o.copy;
    if (o.decode != null) librarySettings.maxDecodeBytes = o.decode;
    if (o.chunk != null) audioSettings.chunkSeconds = o.chunk;
  }, o);
  const dbHas = (id) => page.evaluate(async (id) => {
    const { store } = await import('./assets/js/media/store.js');
    return { file: !!(await store.getFile(id)), handle: !!(await store.getHandle(id)) };
  }, id);
  const meanVolume = (file, ss, t) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(ss), '-t', String(t), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = r.stderr.match(/mean_volume: (-?[\d.]+) dB/);
    return m ? parseFloat(m[1]) : -Infinity;
  };

  await test('大檔案不複製到瀏覽器：匯入馬上完成；重新整理後提示重新匯入，匯入同一個檔案就接回', async () => {
    await newProjectUI();
    await setLimits({ copy: 1000 });
    await page.setInputFiles('#fileInput', [fx.video, fx.audio]);
    await waitFor(async () => (await state()).project.clips.length === 2, 10000, '匯入');
    const media = Object.values((await state()).project.media);
    for (const m of media) assert.deepEqual(await dbHas(m.id), { file: false, handle: false }, `${m.name} 不應該複製`);
    assert.ok(await page.locator('.toast >> text=沒有複製到瀏覽器').count(), '要告訴使用者');
    await page.waitForTimeout(800);
    await page.reload();
    await page.waitForFunction(() => window.__oc && window.__oc.store.project.clips.length === 2);
    await waitFor(async () => (await page.locator('.media-card.missing').count()) === 2, 5000, '兩個遺失');
    assert.ok((await errorToasts()).at(-1).includes('需要重新匯入'));
    await page.setInputFiles('#fileInput', [fx.video, fx.audio]);
    await waitFor(async () => (await page.locator('.media-card.missing').count()) === 0, 10000, '接回');
    assert.equal(Object.keys((await state()).project.media).length, 2, '沒有多出素材');
  });

  // 註：Playwright 的無頭 Chromium 從 IndexedDB 讀回檔案代號（FileSystemHandle）時會整個崩潰，
  // 所以這裡把儲存層換成記憶體裡的假代號，測試「授權、接回、檔案不見」的流程；
  // 「代號存進 IndexedDB 再讀回來」是瀏覽器本身的功能，這裡無法測試。
  let bigId;
  const installFakeHandles = () => page.evaluate(async () => {
    const { store } = await import('./assets/js/media/store.js');
    window.__handles = window.__handles || new Map();
    store.saveHandle = async (id, h) => { window.__handles.set(id, h); };
    store.getHandle = async (id) => window.__handles.get(id);
    store.listHandleIds = async () => [...window.__handles.keys()];
    store.deleteHandle = async (id) => { window.__handles.delete(id); };
  });
  /** 假的檔案代號：perm = 'granted' | 'prompt'；file 可以換掉或設成 null（檔案不見） */
  const importViaFakeHandle = async () => {
    const bytes = [...await readFile(fx.video)];
    await page.evaluate(async (bytes) => {
      const file = new File([new Uint8Array(bytes)], 'big-test.mp4', { type: 'video/mp4' });
      const h = window.__fakeHandle = {
        kind: 'file', name: file.name, perm: 'granted', file, asked: 0,
        async queryPermission() { return this.perm; },
        async requestPermission() { this.asked++; this.perm = 'granted'; return 'granted'; },
        async getFile() { if (!this.file) throw new DOMException('not found', 'NotFoundError'); return this.file; },
      };
      await window.__oc.importEntries([{ file, handle: h }]);
    }, bytes);
  };

  await test('Chrome / Edge：大檔案只記住檔案位置（不複製），重新開啟後自動接回', async () => {
    await newProjectUI();
    await setLimits({ copy: 1000 });
    await installFakeHandles();
    await importViaFakeHandle();
    await waitFor(async () => (await state()).project.clips.length === 1, 10000, '匯入');
    bigId = Object.keys((await state()).project.media)[0];
    assert.equal((await dbHas(bigId)).file, false, '沒有複製檔案');
    assert.equal(await page.evaluate((id) => window.__handles.has(id), bigId), true, '有記住檔案代號');
    await saveAndRestart();
    assert.equal(await page.evaluate((id) => window.__oc.runtime.has(id), bigId), true, '自動接回');
    assert.equal(await page.locator('.media-card.missing').count(), 0);
  });

  await test('需要重新授權時：顯示「允許讀取」，按下去才去請求權限並接回', async () => {
    await page.evaluate(() => { window.__fakeHandle.perm = 'prompt'; window.__fakeHandle.asked = 0; });
    await saveAndRestart();
    const btn = page.locator('.toast button:text("允許讀取")');
    await btn.waitFor({ timeout: 5000 });
    assert.equal(await page.evaluate((id) => window.__oc.runtime.has(id), bigId), false);
    assert.equal(await page.evaluate(() => window.__fakeHandle.asked), 0, '使用者按下去之前不能請求權限');
    await btn.click();
    await waitFor(() => page.evaluate((id) => window.__oc.runtime.has(id), bigId), 5000, '接回');
    assert.equal(await page.evaluate(() => window.__fakeHandle.asked), 1);
    assert.ok(await page.locator('.toast >> text=已接回 1 個大型素材').count());
  });

  await test('原始檔案被刪掉或被修改：清楚提示，素材標示遺失', async () => {
    for (const change of ['deleted', 'modified']) {
      await page.evaluate(async (change) => {
        const h = window.__fakeHandle;
        h.perm = 'granted';
        h.file = change === 'deleted' ? null : new File([new Uint8Array(10)], h.name);
      }, change);
      const before = (await errorToasts()).length;
      await saveAndRestart();
      await waitFor(async () => (await page.locator('.media-card.missing').count()) === 1, 5000, `${change}：遺失`);
      await waitFor(async () => (await errorToasts()).slice(before).some(t => /找不到原始檔案/.test(t)), 5000, `${change}：提示`);
    }
  });

  async function saveAndRestart() {
    await page.waitForTimeout(800); // 等自動儲存
    await page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
    await page.evaluate(() => window.__oc.simulateRestart());
    await page.waitForFunction(() => window.__oc.store.project.clips.length > 0);
  }

  await test('大檔案的聲音：串流計算波形、匯出有聲音（跨越多個混音段落）', async () => {
    await newProjectUI();
    await setLimits({ decode: 1000, chunk: 0.7 });
    try {
      await page.setInputFiles('#fileInput', [fx.video]);
      await waitFor(async () => (await state()).project.clips.length === 1, 10000, '匯入');
      const id = Object.keys((await state()).project.media)[0];
      await waitFor(() => page.evaluate((id) => !!window.__oc.runtime.get(id).peaks, id), 15000, '波形');
      const info = await page.evaluate((id) => { const it = window.__oc.runtime.get(id); return { hasAudio: it.hasAudio, decodedWhole: !!it.audioBuffer, max: Math.max(...it.peaks) }; }, id);
      assert.deepEqual([info.hasAudio, info.decodedWhole], [true, false], '沒有把整個檔案解碼');
      assert.ok(info.max > 0.1, `波形最大值 ${info.max}`);
      const res = await page.evaluate(async (id) => {
        const P = await import('./assets/js/core/project.js');
        const { exportVideo } = await import('./assets/js/engine/exporter.js');
        let p = P.createProject();
        p = P.addMedia(p, window.__oc.store.project.media[id]);
        p = P.addClip(p, 'video', { mediaId: id, srcIn: 0.5, duration: 3 }).project;
        const r = await exportVideo({ project: p, runtime: window.__oc.runtime, settings: { short: 360 } });
        return { warnings: r.warnings, bytes: Array.from(new Uint8Array(await r.blob.arrayBuffer())) };
      }, id);
      assert.deepEqual(res.warnings, []);
      const out = path.join(tmp, 'big-audio.mp4');
      await import('node:fs').then(fs => fs.writeFileSync(out, Buffer.from(res.bytes)));
      assert.ok(Math.abs(parseFloat(probe(out).format.duration) - 3) < 0.15);
      for (const [ss, t] of [[0.1, 0.5], [0.6, 0.3], [1.3, 0.5], [2.3, 0.5]]) {
        const v = meanVolume(out, ss, t);
        assert.ok(v > -30, `${ss}s 起的聲音 ${v} dB（應該有 440Hz 的聲音）`);
      }
    } finally {
      await setLimits({ decode: 400 * 1024 * 1024, chunk: 30 });
    }
  });

  await test('真的讀不到聲音時：匯出完成畫面會明確告知，不會默默沒聲音', async () => {
    await setLimits({ decode: 1000 });
    const saved = await page.evaluate(() => { window.__savedAD = window.AudioDecoder; window.AudioDecoder = undefined; return true; });
    try {
      assert.ok(saved);
      await page.click('#btnExport');
      await page.click('#exRes .seg-btn[data-v="480"]');
      await page.click('.modal [data-go]');
      await page.waitForSelector('.export-done', { timeout: 60000 });
      const text = await page.textContent('.export-done');
      assert.match(text, /有 1 個素材的聲音讀不到/);
      assert.match(text, /clip\.mp4/);
      await page.keyboard.press('Escape');
    } finally {
      await page.evaluate(() => { window.AudioDecoder = window.__savedAD; });
      await setLimits({ decode: 400 * 1024 * 1024 });
    }
  });


  await setLimits({ copy: 100 * 1024 * 1024 });
  console.log('\n時間軸拖曳');
  /** 新專案：V1 上依序是 red[0,2] blue[2,4] photo[4,9]，緊緊排在一起 */
  async function setupPacked() {
    await newProjectUI();
    await page.setInputFiles('#fileInput', [fx.red, fx.blue, fx.image]);
    await waitFor(async () => (await state()).project.clips.length === 3, 10000, '匯入三個');
    await page.evaluate(() => { window.__oc.store.select([]); window.__oc.timeline.fit(); });
    await page.waitForTimeout(200);
    const p = (await state()).project;
    const by = (n) => p.clips.find(c => p.media[c.mediaId].name === n);
    return { red: by('red.mp4'), blue: by('blue.mp4'), photo: by('photo.png') };
  }
  const v1Order = async () => {
    const p = (await state()).project;
    const v1 = [...p.tracks].reverse().find(t => t.kind === 'video');
    return p.clips.filter(c => c.trackId === v1.id).sort((a, b) => a.start - b.start).map(c => p.media[c.mediaId].name.split('.')[0]);
  };
  const timeX = (t) => page.evaluate((t) => { const tl = window.__oc.timeline; return tl.els.scroll.getBoundingClientRect().left + tl.timeToX(t) - tl.els.scroll.scrollLeft; }, t);

  await test('緊密排列的片段可以拖到更早的位置（插到前面，其他往後推）', async () => {
    const { photo } = await setupPacked();
    const box = await clipBox(photo.id);
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    const dx = (await timeX(0.3)) - (await timeX(photo.start));
    await page.mouse.move(box.x + box.width / 2 + dx / 2, y, { steps: 5 });
    await page.mouse.move(box.x + box.width / 2 + dx, y, { steps: 5 });
    await page.mouse.up();
    assert.deepEqual(await v1Order(), ['photo', 'red', 'blue']);
    const p = (await state()).project;
    assert.equal(p.clips.find(c => c.id === photo.id).start, 0);
    await page.keyboard.press('Control+z');
    assert.deepEqual(await v1Order(), ['red', 'blue', 'photo'], '一次就能復原');
  });

  await test('也可以拖到更晚的位置；波紋模式會把原本的位置補起來', async () => {
    const { red, photo } = await setupPacked();
    await page.click('#btnRipple');
    try {
      const box = await clipBox(red.id);
      const y = box.y + box.height / 2;
      const target = await timeX(photo.start + photo.duration * 0.8); // 圖片的後半段
      await page.mouse.move(box.x + box.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(target, y, { steps: 10 });
      await page.mouse.up();
      assert.deepEqual(await v1Order(), ['blue', 'photo', 'red']);
      assert.equal((await state()).project.clips.find(c => c.id === red.id).start, 7, '補位後接在圖片後面');
    } finally {
      await page.click('#btnRipple');
    }
  });

  await test('拖到時間軸右邊緣會自動捲動，可以拖到畫面外更晚的地方', async () => {
    const { red } = await setupPacked();
    await page.evaluate(() => window.__oc.store.setView({ pxPerSec: 300 }));
    await page.evaluate(() => { window.__oc.timeline.els.scroll.scrollLeft = 0; });
    await page.waitForTimeout(100);
    const sc = await page.locator('#tlScroll').boundingBox();
    const box = await clipBox(red.id);
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 30, y);
    await page.mouse.down();
    await page.mouse.move(sc.x + sc.width - 10, y, { steps: 10 });
    await page.waitForTimeout(1500);
    await page.mouse.up();
    const visibleEnd = (sc.width - 16) / 300;
    const after = (await state()).project.clips.find(c => c.id === red.id);
    assert.ok(after.start > visibleEnd, `拖到 ${after.start}s，一開始畫面只看得到 ${visibleEnd.toFixed(1)}s`);
    assert.ok(await page.evaluate(() => window.__oc.timeline.els.scroll.scrollLeft > 0), '有捲動');
  });

  /** 放大時間軸，讓畫面只看得到一小段 */
  const zoomedIn = async () => {
    await setupPacked();
    await page.evaluate(() => { window.__oc.store.setView({ pxPerSec: 300 }); window.__oc.player.seek(0); });
    await page.waitForTimeout(100);
    await page.evaluate(() => { window.__oc.timeline.els.scroll.scrollLeft = 0; });
    return page.locator('#tlScroll').boundingBox();
  };
  const scrollLeft = () => page.evaluate(() => window.__oc.timeline.els.scroll.scrollLeft);

  await test('拖曳播放頭到右邊緣會自動捲動，可以拖到畫面外更晚的時間；拖回左邊緣也會捲回來', async () => {
    const sc = await zoomedIn();
    const visibleEnd = (sc.width - 16) / 300;
    const cap = await page.locator('.tl-playhead-cap').boundingBox();
    const y = cap.y + cap.height / 2;
    await page.mouse.move(cap.x + cap.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(sc.x + sc.width - 8, y, { steps: 8 });
    await page.waitForTimeout(1200);
    const right = (await state()).time;
    assert.ok(right > visibleEnd + 0.5, `播放頭拖到 ${right.toFixed(2)}s，一開始只看得到 ${visibleEnd.toFixed(2)}s`);
    const sl = await scrollLeft();
    assert.ok(sl > 0, '有往右捲');
    await page.mouse.move(sc.x + 8, y, { steps: 8 });
    await page.waitForTimeout(1200);
    await page.mouse.up();
    assert.ok(await scrollLeft() < sl, '往左也會捲');
    assert.ok((await state()).time < right - 1, `往左拖到 ${(await state()).time.toFixed(2)}s`);
  });

  await test('在軌道空白處按住拖曳也能移動播放頭', async () => {
    const sc = await zoomedIn();
    const rows = await page.locator('.tl-track').all();
    const empty = await rows[0].boundingBox(); // 最上面的影像軌是空的
    await page.mouse.move(sc.x + 100, empty.y + empty.height / 2);
    await page.mouse.down();
    await page.mouse.move(sc.x + sc.width - 8, empty.y + empty.height / 2, { steps: 8 });
    await page.waitForTimeout(800);
    await page.mouse.up();
    assert.ok(await scrollLeft() > 0, '有捲動');
    assert.ok((await state()).time > (sc.width - 16) / 300, '播放頭跟著到畫面外');
  });

  await test('一般滑鼠滾輪可以左右捲動時間軸；Ctrl + 滾輪是縮放', async () => {
    const sc = await zoomedIn();
    await page.mouse.move(sc.x + sc.width / 2, sc.y + sc.height / 2);
    await page.mouse.wheel(0, 600);
    await waitFor(async () => (await scrollLeft()) > 300, 2000, '往右捲');
    const sl = await scrollLeft();
    await page.mouse.wheel(0, -400);
    await waitFor(async () => (await scrollLeft()) < sl - 200, 2000, '往左捲');
    const pps = await page.evaluate(() => window.__oc.store.pxPerSec);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 200);
    await page.keyboard.up('Control');
    assert.ok(await page.evaluate(() => window.__oc.store.pxPerSec) < pps, 'Ctrl + 滾輪縮小');
  });

  await test('用鍵盤移動播放頭到畫面外時，時間軸會跟著捲過去', async () => {
    await zoomedIn();
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('End');
    const visible = () => page.evaluate(() => {
      const tl = window.__oc.timeline, s = tl.els.scroll, x = tl.timeToX(window.__oc.player.time);
      return x >= s.scrollLeft && x <= s.scrollLeft + s.clientWidth;
    });
    assert.ok(await visible(), 'End 之後看得到播放頭');
    await page.keyboard.press('Home');
    assert.ok(await visible(), 'Home 之後看得到播放頭');
    assert.equal(await scrollLeft(), 0);
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
    assert.ok(await visible(), 'Shift + → 一秒一秒往後也看得到');
  });

  await test('很短的片段：中間抓得到可以移動（不會變成修剪）', async () => {
    const { blue } = await setupPacked();
    await page.evaluate(() => window.__oc.store.setView({ pxPerSec: 6 })); // 2 秒只有 12px
    await page.waitForTimeout(100);
    const box = await clipBox(blue.id);
    assert.ok(box.width < 18, `片段寬 ${box.width}`);
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, y, { steps: 8 });
    await page.mouse.up();
    const after = (await state()).project.clips.find(c => c.id === blue.id);
    assert.ok(Math.abs(after.duration - blue.duration) < 1e-6, '長度沒變（不是修剪）');
    assert.ok(after.start > blue.start + 5, `往後移到 ${after.start}`);
  });

  await test('修剪拉不動時會說明原因', async () => {
    const { red } = await setupPacked();
    await page.evaluate(() => window.__oc.store.setView({ pxPerSec: 100 }));
    await page.waitForTimeout(100);
    const box = await clipBox(red.id);
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x - 80, y, { steps: 6 });
    await page.mouse.up();
    await waitFor(async () => (await page.locator('.toast', { hasText: '素材的開頭' }).count()) > 0, 3000, '提示');
    assert.equal((await state()).project.clips.find(c => c.id === red.id).start, 0);
  });

  console.log('\n淡入淡出');
  /** 新專案：一段 4 秒、有 440Hz 聲音的影片，時間軸放大到看得清楚 */
  async function setupFadeClip() {
    await newProjectUI();
    await page.setInputFiles('#fileInput', [fx.video]);
    await waitFor(async () => (await state()).project.clips.length === 1, 10000, '匯入');
    const id = (await state()).project.clips[0].id;
    await page.evaluate((id) => { window.__oc.store.select([id]); window.__oc.timeline.fit(); }, id);
    await page.waitForTimeout(200);
    return id;
  }
  const dragDot = async (sel, dxSec) => {
    const pps = await page.evaluate(() => window.__oc.store.pxPerSec);
    const b = await page.locator(sel).boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dxSec * pps / 2, y, { steps: 4 });
    await page.mouse.move(x + dxSec * pps, y, { steps: 4 });
    await page.mouse.up();
  };

  await test('拖曳片段上方的小圓點調整淡入，聲音跟著畫面一起', async () => {
    const id = await setupFadeClip();
    await dragDot(`.clip[data-clip-id="${id}"] .fade-dot[data-fade="in"]:not(.audio)`, 1);
    const c = (await state()).project.clips[0];
    assert.ok(Math.abs(c.fadeIn - 1) < 0.15, `淡入 ${c.fadeIn}`);
    assert.equal(c.audioFades, null, '聲音跟著畫面');
    assert.equal(c.start, 0, '片段沒有被移動');
    assert.ok(Math.abs(c.duration - 4) < 0.1, '片段沒有被修剪');
    await page.keyboard.press('Control+z');
    assert.equal((await state()).project.clips[0].fadeIn, 0, '一次就能復原');
  });

  await test('拖曳波形上的小圓點只調聲音淡出；勾回「跟著畫面」就恢復', async () => {
    const id = await setupFadeClip();
    await dragDot(`.clip[data-clip-id="${id}"] .fade-dot.audio[data-fade="out"]`, -1.5);
    let c = (await state()).project.clips[0];
    assert.ok(Math.abs(c.audioFades.out - 1.5) < 0.15, `聲音淡出 ${JSON.stringify(c.audioFades)}`);
    assert.equal(c.fadeOut, 0, '畫面不淡出');
    const box = page.locator('label.check', { hasText: '聲音跟著畫面淡入淡出' }).locator('input');
    assert.equal(await box.isChecked(), false);
    await box.check();
    c = (await state()).project.clips[0];
    assert.equal(c.audioFades, null);
    // 在屬性面板輸入聲音淡入，也會改成分開設定
    const num = page.locator('.field', { hasText: '聲音淡入' }).locator('.num');
    await num.fill('0.8');
    await num.press('Enter');
    c = (await state()).project.clips[0];
    assert.deepEqual(c.audioFades, { in: 0.8, out: 0 });
    assert.equal(await box.isChecked(), false);
  });

  await test('匯出：只有聲音淡出，畫面維持原本的亮度', async () => {
    const id = await setupFadeClip();
    await page.evaluate(async (id) => {
      const P = await import('./assets/js/core/project.js');
      const s = window.__oc.store;
      s.commit(P.updateClip(s.project, id, { audioFades: { in: 0, out: 2 } }));
    }, id);
    const bytes = await page.evaluate(async () => {
      const { exportVideo } = await import('./assets/js/engine/exporter.js');
      const r = await exportVideo({ project: window.__oc.store.project, runtime: window.__oc.runtime, settings: { short: 360 } });
      return Array.from(new Uint8Array(await r.blob.arrayBuffer()));
    });
    const out = path.join(tmp, 'audio-fade.mp4');
    await import('node:fs').then(fs => fs.writeFileSync(out, Buffer.from(bytes)));
    const loud = meanVolume(out, 0.3, 0.8), quiet = meanVolume(out, 3.5, 0.4);
    assert.ok(loud - quiet > 10, `開頭 ${loud} dB，結尾 ${quiet} dB（應該小聲很多）`);
    const yavg = (ss) => {
      const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(ss), '-i', out, '-frames:v', '1', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], { encoding: 'utf8' });
      return parseFloat(r.stderr.match(/YAVG=([\d.]+)/)?.[1]);
    };
    const start = yavg(0.5), end = yavg(3.8);
    assert.ok(end > start * 0.85, `畫面亮度：開頭 ${start}，結尾 ${end}（不應該變暗）`);
  });

  console.log('\n雙畫面版型與圖案');
  /** 紅色影片在 V1、藍色影片在上面一條軌，兩段從 0 開始重疊 */
  async function setupTwoCams() {
    await newProjectUI();
    await page.setInputFiles('#fileInput', [fx.red, fx.blue]);
    await waitFor(async () => (await state()).project.clips.length === 2, 10000, '匯入兩支');
    const ids = await page.evaluate(async () => {
      const P = await import('./assets/js/core/project.js');
      const { store, player } = window.__oc;
      const name = (c) => store.project.media[c.mediaId].name;
      const red = store.project.clips.find(c => name(c) === 'red.mp4');
      const blue = store.project.clips.find(c => name(c) === 'blue.mp4');
      let p = P.moveClip(store.project, red.id, { start: 0 });
      const top = p.tracks.find(t => t.kind === 'video' && t.id !== red.trackId);
      p = P.moveClip(p, blue.id, { start: 0, trackId: top.id });
      store.commit(p, { select: [] });
      player.seek(0.5);
      return { red: red.id, blue: blue.id };
    });
    await page.click('.tab[data-tab="layout"]');
    return ids;
  }
  const clipOf = async (id) => (await state()).project.clips.find(c => c.id === id);
  /** 預覽畫面上 (fx, fy) 位置的主要顏色 */
  const previewColor = (fx, fy) => page.evaluate(([fx, fy]) => {
    const c = document.getElementById('previewCanvas');
    const d = c.getContext('2d').getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data;
    return d[0] > d[2] + 80 ? 'red' : d[2] > d[0] + 80 ? 'blue' : `rgb(${d[0]},${d[1]},${d[2]})`;
  }, [fx, fy]);
  /** 匯出 360p，回傳一個函式：查 (fx, fy) 的主要顏色 */
  async function exportedColors(name, t = 0.5) {
    const bytes = await page.evaluate(async () => {
      const { exportVideo } = await import('./assets/js/engine/exporter.js');
      const r = await exportVideo({ project: window.__oc.store.project, runtime: window.__oc.runtime, settings: { short: 360 } });
      return Array.from(new Uint8Array(await r.blob.arrayBuffer()));
    });
    const out = path.join(tmp, `${name}.mp4`);
    await import('node:fs').then(fs => fs.writeFileSync(out, Buffer.from(bytes)));
    const v = probe(out).streams.find(s => s.codec_type === 'video');
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const rgbAt = (fx, fy) => {
      const i = (Math.floor(v.height * fy) * v.width + Math.floor(v.width * fx)) * 3;
      return [raw[i], raw[i + 1], raw[i + 2]];
    };
    const at = (fx, fy) => {
      const [r, g, b] = rgbAt(fx, fy);
      return r > b + 80 ? 'red' : b > r + 80 ? 'blue' : `rgb(${r},${g},${b})`;
    };
    at.rgb = rgbAt;
    return at;
  }

  await test('左右分割：下面的軌是左邊的主畫面，預覽與匯出一致', async () => {
    const ids = await setupTwoCams();
    await page.click('[data-layout="split-h"]');
    await waitFor(async () => !!(await clipOf(ids.blue)).frame, 3000, '套用');
    const red = await clipOf(ids.red), blue = await clipOf(ids.blue);
    assert.equal(red.frame.x, 0);
    assert.ok(blue.frame.x > 0.5 && blue.frame.x < 0.51, `右邊那格 x=${blue.frame.x}`);
    assert.deepEqual((await state()).selection, [ids.blue], '選取上面那段，方便馬上調整');
    await page.waitForTimeout(300);
    assert.deepEqual([await previewColor(0.25, 0.5), await previewColor(0.75, 0.5)], ['red', 'blue']);
    const at = await exportedColors('split');
    assert.deepEqual([at(0.25, 0.5), at(0.75, 0.5), at(0.05, 0.05), at(0.95, 0.95)], ['red', 'blue', 'red', 'blue']);
    assert.equal(await page.isVisible('.layout-opt.on[data-layout="split-h"]'), true, '標示目前的版型');
  });

  await test('圓形小窗：圓裡是子畫面，圓外的角落還是主畫面', async () => {
    const ids = { blue: (await state()).selection[0] };
    await page.click('[data-layout="circle-br"]');
    await waitFor(async () => (await clipOf(ids.blue)).frame?.shape === 'circle', 3000, '圓形');
    const f = (await clipOf(ids.blue)).frame;
    const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
    const at = await exportedColors('circle');
    assert.equal(at(cx, cy), 'blue', '圓心');
    assert.equal(at(f.x + f.w * 0.04, f.y + f.h * 0.04), 'red', '外接方框的角落在圓外');
    assert.equal(at(0.3, 0.3), 'red', '主畫面全螢幕');
  });

  await test('子母畫面：在屬性面板改形狀、邊框，取消版型', async () => {
    const id = (await state()).selection[0];
    await page.click('[data-layout="pip-tl"]');
    await waitFor(async () => (await clipOf(id)).frame?.shape === 'round', 3000, '子母畫面');
    const f0 = (await clipOf(id)).frame;
    assert.ok(f0.x < 0.1 && f0.y < 0.1, '左上角');
    // 改成圓形會變成正圓（以短邊為直徑），中心不動
    await page.click('.insp-section .seg-btn[data-v="circle"]');
    await waitFor(async () => (await clipOf(id)).frame.shape === 'circle', 3000, '圓形');
    const p = (await state()).project, f1 = (await clipOf(id)).frame;
    assert.ok(Math.abs(f1.w * p.width - f1.h * p.height) < 1e-6, '正圓');
    assert.ok(Math.abs((f1.x + f1.w / 2) - (f0.x + f0.w / 2)) < 1e-9, '中心不動');
    // 邊框數值
    const border = page.locator('.field', { hasText: '邊框' }).first().locator('.num');
    await border.fill('20');
    await border.press('Enter');
    await waitFor(async () => (await clipOf(id)).frame.border === 20, 3000, '邊框 20');
    await page.click('[data-unframe]');
    await waitFor(async () => (await clipOf(id)).frame === null, 3000, '取消');
    assert.equal(await page.isVisible('.insp-section h3:has-text("位置與大小")'), true, '回到一般的位置與大小');
    await page.keyboard.press('Control+z');
    await waitFor(async () => (await clipOf(id)).frame?.border === 20, 3000, '復原');
  });

  await test('預覽上拖曳移動畫面框、Alt 拖曳取景、滾輪縮放', async () => {
    const id = (await state()).selection[0];
    await page.click('[data-layout="pip-br"]');
    await waitFor(async () => (await clipOf(id)).frame?.shape === 'round', 3000, '子母畫面');
    await page.waitForTimeout(300);
    const box = await page.locator('#overlay .sel-box').boundingBox();
    const p = (await state()).project, f0 = (await clipOf(id)).frame;
    const s = box.width / (f0.w * p.width); // 螢幕像素 / 專案像素
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    // 往左上拖 200 專案像素（按 Shift 關掉吸附）
    await page.keyboard.down('Shift');
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 100 * s, cy - 100 * s, { steps: 4 });
    await page.mouse.move(cx - 200 * s, cy - 200 * s, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    const f1 = (await clipOf(id)).frame;
    assert.ok(Math.abs((f0.x - f1.x) * p.width - 200) < 3, `水平移動 ${(f0.x - f1.x) * p.width}`);
    assert.ok(Math.abs((f0.y - f1.y) * p.height - 200) < 3, `垂直移動 ${(f0.y - f1.y) * p.height}`);
    assert.equal(f1.w, f0.w, '大小不變');
    // Alt 拖曳：框不動，取景移動
    const b2 = await page.locator('#overlay .sel-box').boundingBox();
    const c2 = [b2.x + b2.width / 2, b2.y + b2.height / 2];
    await page.keyboard.down('Alt');
    await page.mouse.move(...c2);
    await page.mouse.down();
    await page.mouse.move(c2[0] + 50 * s, c2[1], { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    const c = await clipOf(id);
    assert.deepEqual(c.frame, f1, 'Alt 拖曳不會移動畫面框');
    assert.ok(Math.abs(c.transform.x - 50) < 3, `取景平移 ${c.transform.x}`);
    // 滾輪：放大取景
    await page.mouse.move(...c2);
    await page.mouse.wheel(0, -300);
    await waitFor(async () => (await clipOf(id)).transform.scale > 1.2, 3000, '滾輪放大');
    // 拉右下角放大畫面框（左上角固定）
    const b3 = await page.locator('#overlay .sel-box').boundingBox();
    await page.mouse.move(b3.x + b3.width, b3.y + b3.height);
    await page.mouse.down();
    await page.mouse.move(b3.x + b3.width + 60, b3.y + b3.height + 20, { steps: 4 });
    await page.mouse.up();
    const f3 = (await clipOf(id)).frame;
    assert.ok(Math.abs(f3.x - f1.x) < 1e-9 && Math.abs(f3.y - f1.y) < 1e-9, '左上角固定');
    assert.ok(f3.w > f1.w && f3.h > f1.h, '變大');
  });

  await test('版型存檔、重新開啟後還在', async () => {
    const before = (await state()).project;
    await saveAndRestart();
    assertSameProject((await state()).project, before);
  });

  await test('只有一段畫面時套用版型：提示怎麼做，不會改動', async () => {
    await newProjectUI();
    await page.setInputFiles('#fileInput', [fx.red]);
    await waitFor(async () => (await state()).project.clips.length === 1, 10000, '匯入');
    const before = (await state()).project;
    await page.click('.tab[data-tab="layout"]');
    await page.click('[data-layout="split-v"]');
    await waitFor(async () => (await page.locator('.toast', { hasText: '兩段同時出現' }).count()) > 0, 3000, '提示');
    assertSameProject((await state()).project, before);
  });

  await test('圖案：背景放最下面、貼圖放最上面，重複加入同一個圖案不會多一份素材', async () => {
    const tracksBefore = (await state()).project.tracks.filter(t => t.kind === 'video').length;
    await page.evaluate(() => window.__oc.player.seek(0));
    await page.click('.tab[data-tab="graphics"]');
    assert.equal(await page.locator('.graphic-opt').count(), 81, '3 個純色畫面 + 23 個文字貼圖 + 55 個圖案');
    await page.click('[data-graphic="sunset"]');
    await waitFor(async () => (await state()).project.clips.length === 2, 5000, '背景');
    let s = await state();
    const bg = s.project.clips.find(c => c.name === '夕陽漸層');
    const videoTracks = s.project.tracks.filter(t => t.kind === 'video');
    assert.equal(videoTracks.length, tracksBefore + 1, '主軌在這段時間有影片，所以在最下面新增一條');
    assert.equal(bg.trackId, videoTracks[videoTracks.length - 1].id, '在最下面');
    assert.equal(s.project.media[bg.mediaId].mime, 'image/svg+xml');
    assert.ok(Math.abs(bg.duration - 2) < 0.05, `蓋住整段影片 ${bg.duration}`);
    await page.click('[data-graphic="heart"]');
    await waitFor(async () => (await state()).project.clips.length === 3, 5000, '貼圖');
    s = await state();
    const heart = s.project.clips.find(c => c.name === '愛心');
    assert.equal(heart.trackId, s.project.tracks.find(t => t.kind === 'video').id, '在最上面');
    assert.ok(heart.transform.scale < 0.5 && heart.transform.x > 0 && heart.transform.y < 0, '右上角的小貼圖');
    assert.ok(heart.duration <= 2 + 1e-6, `不超過影片結尾 ${heart.duration}`);
    const mediaCount = Object.keys(s.project.media).length;
    await page.click('[data-graphic="heart"]');
    await waitFor(async () => (await state()).project.clips.length === 4, 5000, '第二個貼圖');
    assert.equal(Object.keys((await state()).project.media).length, mediaCount, '重複使用同一個素材');
  });

  await test('圖案匯出：SVG 背景畫得出來', async () => {
    await newProjectUI();
    await page.click('.tab[data-tab="graphics"]');
    await page.click('[data-graphic="cinema"]');
    await page.click('[data-graphic="mint"]');
    await waitFor(async () => (await state()).project.clips.length === 2, 5000, '加入');
    const at = await exportedColors('graphics', 1);
    const rgb = (str) => str.match(/\d+/g).map(Number);
    const [r, g, b] = rgb(at(0.5, 0.5));
    assert.ok(g > 180 && g > r && g > b, `中間是薄荷綠 ${at(0.5, 0.5)}`);
    assert.ok(rgb(at(0.5, 0.02)).every(v => v < 30), `上面是電影黑邊 ${at(0.5, 0.02)}`);
    // 換成直式：背景與邊框的縮圖依新的比例重畫
    await page.selectOption('#aspectSelect', '9:16');
    await waitFor(() => page.evaluate(() => decodeURIComponent(document.querySelector('[data-graphic="mint"] img').src).includes('width="1080" height="1920"')), 3000, '直式縮圖');
  });

  console.log('\n文字貼圖與直接編輯文字');
  /** 文字片段在預覽畫面上的螢幕座標（文字框中心） */
  const textCenter = (id) => page.evaluate((id) => {
    const L = window.__oc.player.layouts.get(id);
    const r = document.getElementById('overlay').getBoundingClientRect();
    const k = r.width / window.__oc.store.project.width;
    return { x: r.left + (L.cx + L.text.ox) * k, y: r.top + (L.cy + L.text.oy) * k };
  }, id);

  await test('文字貼圖：加入後是有外框造型、可以改字的文字片段', async () => {
    await setupFadeClip();
    await page.evaluate(() => window.__oc.player.seek(1));
    await page.click('.tab[data-tab="graphics"]');
    await page.click('[data-graphic="tx-bubble"]');
    await waitFor(async () => (await state()).project.clips.some(c => c.type === 'text'), 3000, '加入');
    const c = (await state()).project.clips.find(c => c.type === 'text');
    assert.equal(c.text.deco, 'bubble');
    assert.equal(c.text.content, 'WOW!');
    assert.deepEqual((await state()).selection, [c.id]);
    assert.equal(await page.inputValue('.insp-section select >> nth=1'), 'bubble', '屬性面板的外框造型');
    // 換造型
    await page.selectOption('.insp-section select >> nth=1', 'note');
    assert.equal((await state()).project.clips.find(x => x.id === c.id).text.deco, 'note');
    await page.selectOption('.insp-section select >> nth=1', 'bubble');
  });

  await test('在預覽上點兩下文字：直接改字、換字型、調字級，Esc 結束', async () => {
    const id = (await state()).project.clips.find(c => c.type === 'text').id;
    await page.waitForFunction((id) => window.__oc.player.layouts?.has(id), id);
    const pt = await textCenter(id);
    await page.mouse.dblclick(pt.x, pt.y);
    await page.waitForSelector('.text-edit-area', { timeout: 3000 });
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('text-edit-area')), true, '輸入框拿到焦點');
    assert.equal(await page.evaluate(() => window.__oc.player.hideTextFor != null), true, '畫面上的字先藏起來，由輸入框顯示');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Hello 你好');
    const text = async () => (await state()).project.clips.find(c => c.id === id).text;
    assert.equal((await text()).content, 'Hello 你好');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('第二行');
    assert.equal((await text()).content, 'Hello 你好\n第二行', 'Enter 換行');
    // 打字時不能觸發快捷鍵（S 分割、Delete 刪除…）
    await page.keyboard.type('s');
    assert.equal((await state()).project.clips.length, 2, '沒有被分割');
    await page.selectOption('.te-font', 'Bebas Neue');
    assert.equal((await text()).fontFamily, 'Bebas Neue');
    const size = (await text()).fontSize;
    await page.click('.text-edit-bar [data-act="bigger"]');
    assert.ok((await text()).fontSize > size, '字變大');
    await page.click('.text-edit-bar [data-act="bold"]');
    assert.equal((await text()).fontWeight, 400, '取消粗體');
    await page.keyboard.press('Escape');
    await waitFor(async () => (await page.locator('.text-edit').count()) === 0, 2000, '結束編輯');
    assert.equal(await page.evaluate(() => window.__oc.player.hideTextFor), null);
    assert.deepEqual((await state()).selection, [id], 'Esc 只結束編輯，不取消選取');
  });

  await test('點在編輯框外面也會結束；在時間軸上點兩下文字片段也能編輯', async () => {
    const id = (await state()).project.clips.find(c => c.type === 'text').id;
    await page.evaluate(() => window.__oc.player.seek(3.9)); // 播放頭在文字片段外面
    const box = await clipBox(id);
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector('.text-edit-area', { timeout: 3000 });
    const t = (await state()).time;
    const c = (await state()).project.clips.find(c => c.id === id);
    assert.ok(t >= c.start && t < c.start + c.duration, `播放頭移到片段上 ${t}`);
    await page.keyboard.type('!');
    await page.mouse.click(5, 5); // 畫面左上角（編輯框外面）
    await waitFor(async () => (await page.locator('.text-edit').count()) === 0, 2000, '結束編輯');
    assert.match((await state()).project.clips.find(c => c.id === id).text.content, /!$/);
  });

  await test('文字樣式：霓虹字會發光、可以關掉；圖案分頁可以直接跳到分類', async () => {
    await newProjectUI();
    await page.click('.tab[data-tab="text"]');
    assert.equal(await page.locator('.text-preset').count(), 16);
    await page.click('[data-preset="neon"]');
    await waitFor(async () => (await state()).project.clips.length === 1, 3000, '加入');
    const t = (await state()).project.clips[0].text;
    assert.equal(t.glow, '#ff4fd8');
    assert.equal(t.fontFamily, 'Bebas Neue');
    // 屬性面板的「發光」打勾，取消後就不發光
    const glow = page.locator('.field', { hasText: '發光' }).locator('input[type=checkbox]');
    assert.equal(await glow.isChecked(), true);
    await glow.uncheck();
    assert.equal((await state()).project.clips[0].text.glow, '');
    // 圖案分頁：點「邊框裝飾」直接捲到那一類
    await page.click('.tab[data-tab="graphics"]');
    await page.click('.graphic-jump [data-jump="frame"]');
    await waitFor(() => page.evaluate(() => {
      const panel = document.getElementById('graphicsPanel');
      const h = panel.querySelector('.panel-sub[data-cat="frame"]');
      const top = h.getBoundingClientRect().top - panel.getBoundingClientRect().top;
      return top > 0 && top < 140;
    }), 3000, '捲到邊框裝飾');
  });

  await test('匯出：外框造型畫得出來', async () => {
    await newProjectUI();
    await page.click('.tab[data-tab="graphics"]');
    await page.click('[data-graphic="tx-burst"]');
    await waitFor(async () => (await state()).project.clips.length === 1, 3000, '加入');
    // 等預覽畫好這一格（比較慢的電腦上，加入之後要過一下才有位置資訊）
    await page.waitForFunction(() => window.__oc.player.layouts?.has(window.__oc.store.project.clips[0].id));
    const L = await page.evaluate(() => {
      const c = window.__oc.store.project.clips[0];
      const L = window.__oc.player.layouts.get(c.id);
      return { cx: L.cx / 1920, cy: L.cy / 1080, r: L.w / 2 / 1920 };
    });
    const at = await exportedColors('text-deco', 1);
    // 星形的身體（文字下方）是黃色，畫面角落是黑色
    const [r, g, b] = at.rgb(L.cx, L.cy + L.r * 0.62 * 1920 / 1080);
    assert.ok(r > 180 && g > 150 && b < 120, `星形是黃色：${[r, g, b]}`);
    assert.ok(at.rgb(0.05, 0.9).every(v => v < 30), '角落是黑色背景');
  });

  console.log('\n純色畫面與數字動畫');
  await test('純色畫面：插在播放頭的位置（片段中間會先分割），後面的片段往後移', async () => {
    const { blue, photo } = await setupPacked();
    await page.evaluate(() => window.__oc.player.seek(1));
    await page.click('.tab[data-tab="graphics"]');
    await page.click('[data-graphic="solid-#000000"]');
    await waitFor(async () => (await v1Order()).length === 5, 5000, '插入');
    assert.deepEqual(await v1Order(), ['red', '純黑畫面 1920×1080', 'red', 'blue', 'photo']);
    const p = (await state()).project;
    const black = p.clips.find(c => c.name === '純黑畫面');
    assert.deepEqual([black.start, black.duration], [1, 3]);
    assert.equal(p.clips.find(c => c.id === blue.id).start, blue.start + 3, '後面的片段往後移 3 秒');
    assert.equal(p.clips.find(c => c.id === photo.id).start, photo.start + 3);
    assert.equal(p.clips.filter(c => p.media[c.mediaId]?.name === 'red.mp4').length, 2, '紅色片段被分成兩段');
    // 匯出：插入的那 3 秒是全黑
    const at = await exportedColors('solid', 2.5);
    assert.ok(at.rgb(0.5, 0.5).every(v => v < 25), `全黑：${at.rgb(0.5, 0.5)}`);
    await page.keyboard.press('Control+z');
    assert.deepEqual(await v1Order(), ['red', 'blue', 'photo'], '一次就能復原');
  });

  await test('純色畫面：白色與自訂顏色；同一個顏色重複加入不會多一份素材', async () => {
    await page.evaluate(() => window.__oc.player.seek(9));
    await page.click('[data-graphic="solid-#ffffff"]');
    await waitFor(async () => (await state()).project.clips.some(c => c.name === '純白畫面'), 3000, '白色');
    await page.locator('.solid-custom input[type=color]').evaluate((el) => { el.value = '#3366ff'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(async () => (await state()).project.clips.some(c => c.name === '純色畫面 #3366ff'), 3000, '自訂顏色');
    const media = Object.keys((await state()).project.media).length;
    await page.click('[data-graphic="solid-#ffffff"]');
    await waitFor(async () => (await state()).project.clips.filter(c => c.name === '純白畫面').length === 2, 3000, '第二個白色');
    assert.equal(Object.keys((await state()).project.media).length, media, '重複使用素材');
  });

  await test('數字倒數：從起始數字滾到文字裡的數字，越接近越慢；可以在屬性面板調整', async () => {
    await newProjectUI();
    await page.evaluate(() => window.__oc.player.seek(0));
    await page.click('.tab[data-tab="text"]');
    await page.click('[data-preset="counter"]');
    await waitFor(async () => (await state()).project.clips.length === 1, 3000, '加入');
    const clip = async () => (await state()).project.clips[0];
    assert.deepEqual((await clip()).text.counter, { from: 2152, duration: 3, ease: 'out' });
    const shown = (t) => page.evaluate(async (t) => {
      const P = await import('./assets/js/core/project.js');
      return P.counterText(window.__oc.store.project.clips[0], t);
    }, t);
    assert.deepEqual([await shown(0), await shown(3), await shown(4)], ['2152', '2132', '2132']);
    // 屬性面板
    const box = page.locator('label.check', { hasText: '數字滾動到文字裡的數字' }).locator('input');
    assert.equal(await box.isChecked(), true);
    const from = page.locator('.field', { hasText: '起始數字' }).locator('input');
    await from.fill('100');
    await from.press('Enter');
    assert.equal((await clip()).text.counter.from, 100);
    assert.match(await page.textContent('.inspector'), /3\.0 秒內從 100 跑到 2132/);
    await page.click('.seg-btn[data-v="linear"]');
    assert.equal((await clip()).text.counter.ease, 'linear');
    assert.equal(await shown(1.5), '1116', '等速：一半');
    await box.uncheck();
    assert.equal((await clip()).text.counter, null);
    assert.equal(await page.locator('.field', { hasText: '起始數字' }).isVisible(), false, '關掉後隱藏設定');
    await box.check();
    assert.deepEqual((await clip()).text.counter, { from: 2152, duration: 3, ease: 'out' }, '重新打開：目標 + 20');
  });

  console.log('\n轉場');
  const clipOf2 = async (id) => (await state()).project.clips.find(c => c.id === id);
  await test('轉場分頁：選取後面那段點「溶解」就加在接點上；時間軸有標記；匯出時接點中間是兩段混合', async () => {
    const { red, blue } = await setupPacked();
    await page.evaluate((id) => window.__oc.store.select([id]), blue.id);
    await page.click('.tab[data-tab="transitions"]');
    assert.equal(await page.locator('.tr-opt').count(), 10);
    await page.click('[data-transition="fade"]');
    assert.deepEqual((await clipOf2(blue.id)).transitionIn, { type: 'fade', duration: 0.8 });
    assert.equal((await clipOf2(red.id)).transitionIn, null);
    assert.equal(await page.locator(`.tl-trans[data-clip-id="${blue.id}"]`).count(), 1, '時間軸標記');
    assert.equal(await page.locator('.tr-opt.on').getAttribute('data-transition'), 'fade');
    assert.equal(await page.evaluate(() => window.__oc.player.time), 2, '播放頭移到接點');
    // 預覽：接點正中間是紅藍混合
    await page.waitForTimeout(600);
    const px = await page.evaluate(() => {
      const c = document.getElementById('previewCanvas');
      return Array.from(c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data);
    });
    assert.ok(px[0] > 60 && px[2] > 60, `預覽混合：${px}`);
    // 匯出：轉場前後是純色、中間混合
    const mid = await exportedColors('fade', 2.0);
    const [r, , b] = mid.rgb(0.5, 0.5);
    assert.ok(r > 70 && b > 70, `接點中間混合：${mid.rgb(0.5, 0.5)}`);
    assert.equal((await exportedColors('fade-before', 1.4))(0.5, 0.5), 'red');
    assert.equal((await exportedColors('fade-after', 2.6))(0.5, 0.5), 'blue');
    await page.keyboard.press('Control+z');
    assert.equal((await clipOf2(blue.id)).transitionIn, null, '一次就能復原');
  });

  await test('屬性面板的轉場：改成擦除、調整長度；匯出時左邊是新畫面、右邊還是舊畫面', async () => {
    const { blue } = await setupPacked();
    await page.evaluate((id) => window.__oc.store.select([id]), blue.id);
    const sec = page.locator('.insp-section').filter({ has: page.locator('select[aria-label="轉場效果"]') });
    assert.match(await sec.textContent(), /跟前一段的接點/);
    await sec.locator('select').selectOption('wipe');
    assert.deepEqual((await clipOf2(blue.id)).transitionIn, { type: 'wipe', duration: 0.8 });
    const num = sec.locator('.field', { hasText: '長度' }).locator('.num');
    await num.fill('2');
    await num.press('Enter');
    assert.equal((await clipOf2(blue.id)).transitionIn.duration, 2);
    const at = await exportedColors('wipe', 2.0);
    assert.equal(at(0.2, 0.5), 'blue', '左邊已經換成新畫面');
    assert.equal(at(0.8, 0.5), 'red', '右邊還是舊畫面');
    await sec.locator('select').selectOption('');
    assert.equal((await clipOf2(blue.id)).transitionIn, null, '選「無」移除');
  });

  await test('套用到全部接點、移除轉場；沒有接點時提示', async () => {
    const { red, blue, photo } = await setupPacked();
    await page.click('.tab[data-tab="transitions"]');
    await page.evaluate(() => window.__oc.player.seek(3.9));
    await page.click('[data-transition="iris"]');
    assert.equal((await clipOf2(photo.id)).transitionIn?.type, 'iris', '沒選取：用離播放頭最近的接點');
    await page.click('[data-dur="1.2"]');
    await page.click('#transitionsPanel [data-act="all"]');
    const p = (await state()).project;
    assert.deepEqual([red, blue, photo].map(c => p.clips.find(x => x.id === c.id).transitionIn), [null, { type: 'iris', duration: 1.2 }, { type: 'iris', duration: 1.2 }]);
    assert.equal(await page.locator('.tl-trans').count(), 2);
    // 點時間軸上的標記會選取那段
    await page.locator(`.tl-trans[data-clip-id="${blue.id}"] .tl-trans-dot`).click();
    assert.deepEqual(await page.evaluate(() => window.__oc.store.selection), [blue.id]);
    await page.click('#transitionsPanel [data-act="remove"]');
    assert.equal((await clipOf2(blue.id)).transitionIn, null);
    assert.equal(await page.locator('.tl-trans').count(), 1);
    // 只有一段：沒有接點
    await newProjectUI();
    await page.setInputFiles('#fileInput', [fx.red]);
    await waitFor(async () => (await state()).project.clips.length === 1, 10000, '匯入');
    await page.click('.tab[data-tab="transitions"]');
    await page.click('[data-transition="fade"]');
    await page.waitForSelector('.toast:has-text("轉場需要接點")', { timeout: 3000 });
    assert.equal((await state()).project.clips[0].transitionIn, null);
  });

  await test('每一種轉場都能預覽與匯出（推移、縮放、模糊…不會出錯）', async () => {
    const { blue } = await setupPacked();
    const errBefore = errors.length;
    for (const type of ['black', 'white', 'blur', 'softwipe', 'push', 'pushup', 'zoom']) {
      await page.evaluate(async ({ id, type }) => {
        const P = await import('./assets/js/core/project.js');
        const { store, player } = window.__oc;
        store.commit(P.updateClip(store.project, id, { transitionIn: { type, duration: 1 } }));
        player.seek(1.8);
      }, { id: blue.id, type });
      await page.waitForTimeout(150);
    }
    // 推移：中間時左半邊是舊畫面往左推出、右半邊是新畫面
    await page.evaluate(async (id) => {
      const P = await import('./assets/js/core/project.js');
      window.__oc.store.commit(P.updateClip(window.__oc.store.project, id, { transitionIn: { type: 'push', duration: 1 } }));
    }, blue.id);
    const at = await exportedColors('push', 2.0);
    assert.equal(at(0.25, 0.5), 'red');
    assert.equal(at(0.75, 0.5), 'blue');
    // 白場：接點正中間是白色
    await page.evaluate(async (id) => {
      const P = await import('./assets/js/core/project.js');
      window.__oc.store.commit(P.updateClip(window.__oc.store.project, id, { transitionIn: { type: 'white', duration: 1 } }));
    }, blue.id);
    const w = (await exportedColors('white', 2.0)).rgb(0.5, 0.5);
    assert.ok(w.every(v => v > 225), `白色：${w}`);
    assert.deepEqual(errors.slice(errBefore), [], '沒有 JS 錯誤');
  });

  console.log('\n英文版');
  /** 畫面上還看得到的中文（語言切換按鈕、使用者自己的內容除外） */
  const leftoverChinese = (pg) => pg.evaluate(() => {
    const CJK = /[　-〿一-鿿＀-￯]/;
    const skip = (el) => el.closest('[lang^="zh"], .media-name, .clip-label, #projectName, textarea, script, style');
    const out = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (CJK.test(n.nodeValue) && !skip(n.parentElement) && n.parentElement.getClientRects().length) out.add(n.nodeValue.trim().slice(0, 60));
    }
    for (const el of document.querySelectorAll('[title],[aria-label],[placeholder]')) {
      if (skip(el)) continue;
      for (const a of ['title', 'aria-label', 'placeholder']) { const v = el.getAttribute(a); if (v && CJK.test(v)) out.add(`${a}=${v.slice(0, 60)}`); }
    }
    if (CJK.test(document.title)) out.add(`title=${document.title}`);
    return [...out];
  });
  const englishContext = async (opts = {}) => {
    const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 }, ...opts });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ body: '', contentType: 'text/css' }));
    return ctx;
  };

  await test('英文首頁：沒有漏翻的中文；可以切換回中文', async () => {
    const ctx = await englishContext();
    const pg = await ctx.newPage();
    const errs = [];
    pg.on('pageerror', e => errs.push(e.message));
    await pg.goto(`${BASE}/index.html`);
    await pg.waitForFunction(() => document.documentElement.lang === 'en');
    assert.deepEqual(await leftoverChinese(pg), []);
    assert.match(await pg.title(), /Free online video editor/);
    assert.equal(await pg.evaluate(() => getComputedStyle(document.body).visibility), 'visible');
    assert.match(await pg.getAttribute('.hero img', 'src'), /editor-preview-en\.jpg/);
    await pg.click('.lang-btn');
    await pg.waitForFunction(() => document.querySelector('.nav-links a')?.textContent === '功能');
    assert.match(pg.url(), /lang=zh-TW/);
    // 語言選擇會記住：直接打開編輯器也是中文
    await pg.goto(`${BASE}/editor.html`);
    await pg.waitForFunction(() => window.__oc);
    assert.equal(await pg.textContent('#btnExport'), '匯出');
    assert.deepEqual(errs, []);
    await ctx.close();
  });

  await test('英文編輯器：各個畫面都沒有漏翻的中文', async () => {
    const ctx = await englishContext();
    const pg = await ctx.newPage();
    const errs = [];
    pg.on('pageerror', e => errs.push(e.message));
    await pg.goto(`${BASE}/editor.html`);
    await pg.waitForFunction(() => window.__oc);
    const found = new Map();
    const check = async (where) => { for (const s of await leftoverChinese(pg)) found.set(s, where); };
    await check('開啟時');
    await pg.click('#welcomeSample');
    await pg.waitForFunction(() => window.__oc.store.project.clips.length >= 7, null, { timeout: 15000 });
    assert.equal(await pg.evaluate(() => window.__oc.store.project.name), 'My first video');
    await check('範例專案');
    for (const tab of ['text', 'graphics', 'layout', 'transitions', 'media']) { await pg.click(`.tab[data-tab="${tab}"]`); await check(`${tab} 分頁`); }
    for (const type of ['image', 'text', 'audio']) {
      await pg.evaluate((type) => window.__oc.store.select([window.__oc.store.project.clips.find(c => c.type === type).id]), type);
      await check(`${type} 屬性`);
    }
    // 套用版型後的畫面框
    await pg.evaluate(async () => {
      const P = await import('./assets/js/core/project.js');
      const { store } = window.__oc;
      const img = store.project.clips.find(c => c.type === 'image');
      store.commit(P.updateClip(store.project, img.id, { frame: { w: 0.5 } }), { select: [img.id] });
    });
    await pg.waitForSelector('[data-unframe]');
    await check('畫面框');
    await pg.evaluate(() => window.__oc.store.select([]));
    await check('專案設定');
    await pg.click('#btnExport');
    await pg.waitForSelector('.modal');
    await pg.waitForTimeout(300);
    await check('匯出對話框');
    await pg.keyboard.press('Escape');
    await pg.click('#btnProjectMenu');
    await check('專案選單');
    await pg.click('#btnSaveProject');
    await pg.waitForSelector('.modal');
    await check('專案檔對話框');
    await pg.keyboard.press('Escape');
    await pg.keyboard.press('?');
    await pg.waitForSelector('.modal');
    await check('快捷鍵');
    await pg.keyboard.press('Escape');
    await pg.keyboard.press('Control+a');
    await check('多選');
    assert.deepEqual([...found].map(([s, w]) => `${w}：${s}`), []);
    assert.deepEqual(errs, []);
    await ctx.close();
  });

  await test('英文版匯入與匯出：通知與完成畫面都是英文', async () => {
    const ctx = await englishContext({ acceptDownloads: true });
    const pg = await ctx.newPage();
    await pg.goto(`${BASE}/editor.html`);
    await pg.waitForFunction(() => window.__oc);
    await pg.setInputFiles('#fileInput', [fx.red]);
    await pg.waitForSelector('.toast:has-text("Imported 1 file and added it to the timeline")');
    await pg.click('#btnExport');
    await pg.click('#exRes .seg-btn[data-v="480"]');
    await pg.click('.modal [data-go]');
    await pg.waitForSelector('.export-done', { timeout: 60000 });
    assert.match(await pg.textContent('.export-done'), /Your video is ready/);
    assert.deepEqual(await leftoverChinese(pg), []);
    await ctx.close();
  });

  console.log('\n首頁與手機版');
  await test('首頁載入、連結到編輯器', async () => {
    const p2 = await context.newPage();
    const errs = [];
    p2.on('pageerror', e => errs.push(e.message));
    await p2.goto(`${BASE}/index.html`);
    const href = await p2.getAttribute('a.cta-primary', 'href');
    assert.match(href, /editor\.html/);
    assert.deepEqual(errs, []);
    await p2.close();
  });

  for (const [name, url] of [['首頁', 'index.html'], ['編輯器', 'editor.html']]) {
    await test(`${name}在手機寬度沒有橫向捲軸`, async () => {
      const p3 = await browser.newPage({ viewport: { width: 375, height: 760 }, locale: 'zh-TW' });
      await p3.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ body: '', contentType: 'text/css' }));
      await p3.goto(`${BASE}/${url}`);
      await p3.waitForTimeout(600);
      const over = await p3.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(over <= 1, `超出 ${over}px`);
      await p3.close();
    });
  }
} finally {
  await browser.close();
  server?.close();
  await rm(tmp, { recursive: true, force: true });
}

console.log(`\n${failures ? '❌' : '✅'} ${passed} 通過，${failures} 失敗`);
process.exit(failures ? 1 : 0);
