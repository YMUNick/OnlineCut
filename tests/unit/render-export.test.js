import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { clipLayout, hitTest, filterString, fontString } from '../../assets/js/engine/renderer.js';
import { outputSize, estimateBitrate, sanitizeFilename } from '../../assets/js/engine/exporter.js';
import { parseColor, toRgba } from '../../assets/js/ui/inspector.js';
import { makeClip, createProject } from '../../assets/js/core/project.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const measure = (font, line) => line.length * 10; // 假的量字：每個字 10px

describe('clipLayout', () => {
  const p = createProject(); // 1920×1080
  test('16:9 素材剛好塞滿', () => {
    const L = clipLayout(p, makeClip('video'), { width: 1280, height: 720 }, measure);
    assert.deepEqual([L.cx, L.cy, L.w, L.h], [960, 540, 1920, 1080]);
  });
  test('直式素材左右留黑邊（contain）', () => {
    const L = clipLayout(p, makeClip('video'), { width: 1080, height: 1920 }, measure);
    near(L.h, 1080);
    near(L.w, 1080 * 1080 / 1920);
  });
  test('位移、縮放、旋轉', () => {
    const L = clipLayout(p, makeClip('image', { transform: { x: 100, y: -50, scale: 0.5, rotation: 30 } }), { width: 1920, height: 1080 }, measure);
    assert.deepEqual([L.cx, L.cy, L.w, L.h, L.rotation], [1060, 490, 960, 540, 30]);
  });
  test('沒有素材資訊時當成填滿畫面', () => {
    const L = clipLayout(p, makeClip('video'), undefined, measure);
    assert.deepEqual([L.w, L.h], [1920, 1080]);
  });
  test('文字大小依最長的一行與行數', () => {
    const c = makeClip('text', { text: { content: 'ab\nabcd', fontSize: 100, background: '' } });
    const L = clipLayout(p, c, null, measure);
    assert.equal(L.w, 40);
    assert.equal(L.h, 2 * 100 * 1.25);
  });
  test('文字背景框加上內距', () => {
    const c = makeClip('text', { text: { content: 'abcd', fontSize: 100, background: '#000' } });
    const L = clipLayout(p, c, null, measure);
    assert.equal(L.w, 40 + 60);
    assert.equal(L.h, 125 + 60);
  });
  test('空白文字不會變成 0 寬', () => {
    const c = makeClip('text', { text: { content: '' } });
    assert.ok(clipLayout(p, c, null, measure).w > 0);
  });
});

describe('hitTest', () => {
  const L = { cx: 100, cy: 100, w: 200, h: 50, rotation: 0 };
  test('框內 / 框外', () => {
    assert.equal(hitTest(L, 100, 100), true);
    assert.equal(hitTest(L, 199, 124), true);
    assert.equal(hitTest(L, 201, 100), false);
    assert.equal(hitTest(L, 100, 126), false);
  });
  test('旋轉 90° 後寬高對調', () => {
    const R = { ...L, rotation: 90 };
    assert.equal(hitTest(R, 100, 190), true);
    assert.equal(hitTest(R, 190, 100), false);
  });
});

describe('filterString', () => {
  test('預設值不產生濾鏡（效能）', () => {
    assert.equal(filterString({ brightness: 100, contrast: 100, saturation: 100, grayscale: 0, blur: 0 }), 'none');
  });
  test('組合濾鏡、模糊隨畫布縮放', () => {
    assert.equal(filterString({ brightness: 120, contrast: 100, saturation: 50, grayscale: 100, blur: 4 }, 0.5),
      'brightness(120%) saturate(50%) grayscale(100%) blur(2px)');
  });
});

describe('fontString', () => {
  test('包含粗細、斜體、字型與中文備援字型', () => {
    const f = fontString({ fontFamily: 'Noto Serif TC', fontWeight: 900, italic: true, fontSize: 64 });
    assert.match(f, /^italic 900 64px "Noto Serif TC", "Noto Sans TC"/);
  });
});

describe('匯出設定', () => {
  test('依短邊縮小、維持偶數', () => {
    const p = createProject();
    assert.deepEqual(outputSize(p, 720), { width: 1280, height: 720 });
    assert.deepEqual(outputSize(p, 480), { width: 854, height: 480 });
    assert.deepEqual(outputSize(p, null), { width: 1920, height: 1080 });
  });
  test('不會放大超過專案解析度', () => {
    assert.deepEqual(outputSize(createProject(), 4000), { width: 1920, height: 1080 });
  });
  test('直式', () => {
    assert.deepEqual(outputSize(createProject({ aspect: '9:16' }), 720), { width: 720, height: 1280 });
    assert.deepEqual(outputSize(createProject({ aspect: '4:5' }), 480), { width: 480, height: 600 });
  });
  test('位元率範圍', () => {
    assert.equal(estimateBitrate(1920, 1080, 30, 'high'), Math.round(1920 * 1080 * 30 * 0.16));
    assert.equal(estimateBitrate(100, 100, 1), 1e6);       // 下限
    assert.equal(estimateBitrate(3840, 2160, 60), 40e6);   // 上限
    assert.ok(estimateBitrate(1920, 1080, 30, 'low') < estimateBitrate(1920, 1080, 30, 'medium'));
  });
  test('檔名清理', () => {
    assert.equal(sanitizeFilename('我的影片'), '我的影片');
    assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
    assert.equal(sanitizeFilename('   '), 'OnlineCut');
    assert.equal(sanitizeFilename(''), 'OnlineCut');
    assert.equal(sanitizeFilename('x'.repeat(200)).length, 80);
    assert.equal(sanitizeFilename('tab\there'), 'tab here');
  });
});

describe('顏色', () => {
  test('parseColor', () => {
    assert.deepEqual(parseColor('rgba(0, 0, 0, 0.6)'), { hex: '#000000', alpha: 0.6 });
    assert.deepEqual(parseColor('rgb(255,92,57)'), { hex: '#ff5c39', alpha: 1 });
    assert.deepEqual(parseColor('#FF5C39'), { hex: '#ff5c39', alpha: 1 });
    assert.deepEqual(parseColor('#fff'), { hex: '#ffffff', alpha: 1 });
    assert.deepEqual(parseColor(''), { hex: '#000000', alpha: 0 });
    assert.deepEqual(parseColor('rgba(300, 10, 0, 5)'), { hex: '#ff0a00', alpha: 1 }); // 超出範圍夾住
    assert.deepEqual(parseColor('rgba(-1, 0, 0)'), { hex: '#000000', alpha: 1 });      // 格式錯誤用預設值
    assert.deepEqual(parseColor('red'), { hex: '#000000', alpha: 1 });
  });
  test('toRgba 與 parseColor 互轉', () => {
    assert.equal(toRgba('#ff5c39', 0.5), 'rgba(255, 92, 57, 0.5)');
    assert.deepEqual(parseColor(toRgba('#123456', 0.25)), { hex: '#123456', alpha: 0.25 });
  });
});
