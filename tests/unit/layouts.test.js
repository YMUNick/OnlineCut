import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../assets/js/core/project.js';
import { LAYOUTS, layoutFrames, applyLayout, layoutCandidates, matchLayout, PIP_SIZE } from '../../assets/js/core/layouts.js';
import { clipLayout, framedContent } from '../../assets/js/engine/renderer.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

/** 兩支影片疊在不同軌（V2 在上、V1 在下），加一段文字 */
function twoCams(aspect = '16:9') {
  let p = P.createProject({ aspect });
  p = P.addMedia(p, { id: 'a', type: 'video', name: 'a.mp4', duration: 10, width: 1920, height: 1080 });
  p = P.addMedia(p, { id: 'b', type: 'video', name: 'b.mp4', duration: 10, width: 1080, height: 1920 });
  p = P.addTrack(p, 'video');
  const [v2, v1] = p.tracks.filter(t => t.kind === 'video');
  const r1 = P.addClip(p, 'video', { mediaId: 'a', trackId: v1.id, start: 0 });
  const r2 = P.addClip(r1.project, 'video', { mediaId: 'b', trackId: v2.id, start: 0 });
  const r3 = P.addClip(r2.project, 'text', { start: 0 });
  return { p: r3.project, main: r1.clip, cam: r2.clip, text: r3.clip };
}

describe('版型的格子', () => {
  test('每個版型都有格子，而且都在畫面裡', () => {
    for (const aspect of Object.keys(P.ASPECT_PRESETS)) {
      const { width: W, height: H } = P.ASPECT_PRESETS[aspect];
      for (const l of LAYOUTS) {
        const frames = layoutFrames(l.id, W, H);
        assert.ok(frames?.length >= 2, l.id);
        for (const f of frames) {
          assert.ok(f.x >= -1e-9 && f.y >= -1e-9 && f.x + f.w <= 1 + 1e-9 && f.y + f.h <= 1 + 1e-9, `${aspect} ${l.id} ${JSON.stringify(f)}`);
          assert.deepEqual(P.cleanFrame(f), f, '格子本身就是合法的畫面框');
        }
      }
    }
  });
  test('分割畫面的格子不重疊', () => {
    for (const id of ['split-h', 'split-v', 'three', 'grid4']) {
      for (const [W, H] of [[1920, 1080], [1080, 1920], [1080, 1080]]) {
        const fs = layoutFrames(id, W, H);
        for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) {
          const a = fs[i], b = fs[j];
          const overlap = a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;
          assert.ok(!overlap, `${id} ${W}×${H} 第 ${i} 和 ${j} 格重疊`);
        }
      }
    }
  });
  test('子母畫面：主畫面全螢幕，小窗跟畫面同比例、在右下角', () => {
    const [main, pip] = layoutFrames('pip-br', 1920, 1080);
    assert.deepEqual([main.x, main.y, main.w, main.h], [0, 0, 1, 1]);
    near(pip.w, PIP_SIZE);
    near(pip.w * 1920 / (pip.h * 1080), 1920 / 1080);
    assert.ok(pip.x + pip.w < 1 && pip.x > 0.5 && pip.y > 0.5);
    assert.equal(pip.shape, 'round');
  });
  test('圓形小窗在任何比例都是正圓', () => {
    for (const [W, H] of [[1920, 1080], [1080, 1920], [1080, 1350]]) {
      const [, c] = layoutFrames('circle-bl', W, H);
      near(c.w * W, c.h * H);
      assert.equal(c.shape, 'circle');
      assert.ok(c.x < 0.5);
    }
  });
  test('三分割：橫式切欄、直式切列', () => {
    assert.ok(layoutFrames('three', 1920, 1080).every(f => f.h === 1));
    assert.ok(layoutFrames('three', 1080, 1920).every(f => f.w === 1));
  });
  test('不認識的版型', () => {
    assert.equal(layoutFrames('nope', 1920, 1080), null);
  });
});

describe('套用版型', () => {
  test('下面的軌道是主畫面，不管選取順序', () => {
    const { p, main, cam } = twoCams();
    const { project, applied } = applyLayout(p, [cam.id, main.id], 'pip-br');
    assert.equal(applied, 2);
    assert.deepEqual(P.getClip(project, main.id).frame, P.cleanFrame(layoutFrames('pip-br', 1920, 1080)[0]));
    assert.equal(P.getClip(project, cam.id).frame.shape, 'round');
    assert.equal(matchLayout(project, P.getClip(project, cam.id)), 'pip-br');
  });
  test('套用時重設取景；文字片段不受影響', () => {
    let { p, main, cam, text } = twoCams();
    p = P.updateClip(p, cam.id, { transform: { x: 50, scale: 2, rotation: 30 } });
    const { project } = applyLayout(p, [main.id, cam.id, text.id], 'split-h');
    assert.deepEqual(P.getClip(project, cam.id).transform, { x: 0, y: 0, scale: 1, rotation: 0, flipX: false, flipY: false });
    assert.equal(P.getClip(project, text.id).frame, null);
  });
  test('套用與取消版型都保留翻轉（版型只管位置與大小）', () => {
    let { p, main, cam } = twoCams();
    p = P.updateClip(p, cam.id, { transform: { flipX: true, x: 50, scale: 2 } });
    p = P.updateClip(p, main.id, { transform: { flipY: true } });
    const on = applyLayout(p, [main.id, cam.id], 'split-h').project;
    assert.deepEqual(P.getClip(on, cam.id).transform, { x: 0, y: 0, scale: 1, rotation: 0, flipX: true, flipY: false });
    assert.equal(P.getClip(on, main.id).transform.flipY, true, '沒選到、被自動加入的那段也保留');
    const off = applyLayout(on, [main.id, cam.id], 'none').project;
    assert.deepEqual([P.getClip(off, cam.id).transform.flipX, P.getClip(off, main.id).transform.flipY], [true, true]);
  });
  test('格子比片段多：只套用有的', () => {
    const { p, main, cam } = twoCams();
    const { applied } = applyLayout(p, [main.id, cam.id], 'grid4');
    assert.equal(applied, 2);
  });
  test('取消版型', () => {
    const { p, main, cam } = twoCams();
    const on = applyLayout(p, [main.id, cam.id], 'circle-br').project;
    const off = applyLayout(on, [main.id, cam.id], 'none').project;
    assert.equal(P.getClip(off, main.id).frame, null);
    assert.equal(P.getClip(off, cam.id).frame, null);
  });
  test('只選一段時自動加入播放頭位置的其他畫面', () => {
    const { p, main, cam } = twoCams();
    const list = layoutCandidates(p, [cam.id], 1, 2);
    assert.deepEqual(list.map(c => c.id), [main.id, cam.id]);
    assert.deepEqual(layoutCandidates(p, [], 1, 2).map(c => c.id), [main.id, cam.id]);
    // 播放頭之後沒有東西
    assert.deepEqual(layoutCandidates(p, [], 50, 2), []);
  });
  test('鎖定的軌道不會被自動加入', () => {
    let { p, main, cam } = twoCams();
    p = P.updateTrack(p, cam.trackId, { locked: true });
    assert.deepEqual(layoutCandidates(p, [main.id], 1, 2).map(c => c.id), [main.id]);
  });
});

describe('畫面框資料', () => {
  test('新片段沒有畫面框；文字和音訊不能有', () => {
    assert.equal(P.makeClip('video').frame, null);
    assert.equal(P.makeClip('text', { frame: { w: 0.5 } }).frame, null);
    assert.equal(P.makeClip('audio', { frame: { w: 0.5 } }).frame, null);
    assert.equal(P.makeClip('image', { frame: { w: 0.5 } }).frame.w, 0.5);
  });
  test('updateClip 合併、夾住數值、null 取消', () => {
    const { p, cam } = twoCams();
    let q = P.updateClip(p, cam.id, { frame: { x: 0.5, w: -3, shape: 'hexagon', border: 1e9, borderColor: 'red' } });
    const f = P.getClip(q, cam.id).frame;
    assert.deepEqual(f, { x: 0.5, y: 0, w: P.MIN_FRAME, h: 1, shape: 'rect', border: 60, borderColor: '#ffffff', shadow: false });
    q = P.updateClip(q, cam.id, { frame: { y: 0.25 } });
    assert.equal(P.getClip(q, cam.id).frame.x, 0.5);
    assert.equal(P.getClip(q, cam.id).frame.y, 0.25);
    q = P.updateClip(q, cam.id, { frame: null });
    assert.equal(P.getClip(q, cam.id).frame, null);
  });
  test('分割、複製會保留畫面框；存檔讀回不變', () => {
    const { p, main, cam } = twoCams();
    let q = applyLayout(p, [main.id, cam.id], 'circle-bl').project;
    const split = P.splitClip(q, cam.id, 3);
    q = split.project;
    for (const c of q.clips.filter(c => c.mediaId === 'b')) assert.equal(c.frame.shape, 'circle');
    q = P.duplicateClip(q, main.id).project;
    assert.equal(q.clips.filter(c => c.mediaId === 'a' && c.frame).length, 2);
    assert.deepEqual(P.normalizeProject(JSON.parse(JSON.stringify(q))), q);
  });
  test('舊的存檔（沒有 frame 欄位）讀進來是 null', () => {
    const { p } = twoCams();
    const raw = JSON.parse(JSON.stringify(p));
    for (const c of raw.clips) delete c.frame;
    assert.ok(P.normalizeProject(raw).clips.every(c => c.frame === null));
  });
  test('存檔裡的壞畫面框會被修正，文字片段的畫面框會被丟掉', () => {
    const { p, text, cam } = twoCams();
    const raw = JSON.parse(JSON.stringify(p));
    raw.clips.find(c => c.id === text.id).frame = { x: 0 };
    raw.clips.find(c => c.id === cam.id).frame = { x: 'a', y: 1e9, w: null, shape: '<script>', shadow: 'yes' };
    const n = P.normalizeProject(raw);
    assert.equal(P.getClip(n, text.id).frame, null);
    assert.deepEqual(P.getClip(n, cam.id).frame, { x: 0, y: 2, w: 1, h: 1, shape: 'rect', border: 0, borderColor: '#ffffff', shadow: false });
  });
});

describe('畫面框的位置', () => {
  const p = P.createProject();
  test('layout 就是框的範圍，不旋轉', () => {
    const c = P.makeClip('video', { frame: { x: 0.5, y: 0.25, w: 0.25, h: 0.5 }, transform: { rotation: 45 } });
    const L = clipLayout(p, c, { width: 640, height: 480 }, () => 0);
    assert.deepEqual([L.cx, L.cy, L.w, L.h, L.rotation, L.framed], [1200, 540, 480, 540, 0, true]);
  });
  test('影像裁切填滿框（cover），縮放與平移是取景', () => {
    const c = P.makeClip('video', { frame: { x: 0, y: 0, w: 0.5, h: 1 } });
    const L = clipLayout(p, c, { width: 1920, height: 1080 }, () => 0);
    let r = framedContent(c, L, { width: 1920, height: 1080 });
    // 960×1080 的框放 16:9：高度填滿，寬度超出
    assert.deepEqual([r.w, r.h, r.x, r.y], [1920, 1080, -960, -540]);
    c.transform = { x: 100, y: -20, scale: 2, rotation: 0 };
    r = framedContent(c, L, { width: 1920, height: 1080 });
    assert.deepEqual([r.w, r.h, r.x, r.y], [3840, 2160, 100 - 1920, -20 - 1080]);
  });
});
