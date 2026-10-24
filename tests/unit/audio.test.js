import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gainPoints, audioPlan, audibleClips } from '../../assets/js/engine/audio.js';
import * as P from '../../assets/js/core/project.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

function project() {
  let p = P.createProject();
  p = P.addMedia(p, { id: 'v', type: 'video', name: 'v.mp4', duration: 600, width: 1920, height: 1080 });
  p = P.addMedia(p, { id: 'a', type: 'audio', name: 'a.mp3', duration: 120 });
  return p;
}

/** 依 gainPoints 線性內插出 t 的音量 */
function gainAt(points, t) {
  for (let i = 1; i < points.length; i++) {
    const [t0, g0] = points[i - 1], [t1, g1] = points[i];
    if (t >= t0 - 1e-12 && t <= t1 + 1e-12) return t1 === t0 ? g1 : g0 + (g1 - g0) * (t - t0) / (t1 - t0);
  }
  return points[0][1];
}

describe('gainPoints：音量包絡', () => {
  test('沒有淡入淡出：整段固定音量', () => {
    const c = P.makeClip('audio', { start: 10, duration: 5, volume: 0.8 });
    assert.deepEqual(gainPoints(c, 10, 15), [[10, 0.8], [15, 0.8]]);
  });
  test('跟逐點計算的 fadeFactor 完全一致（含淡入淡出重疊的交點）', () => {
    for (const [fi, fo] of [[1, 2], [3, 3], [4, 0], [0, 4], [0.5, 0.5]]) {
      const c = P.makeClip('audio', { start: 2, duration: 5, volume: 1.5, fadeIn: fi, fadeOut: fo });
      const pts = gainPoints(c, 2, 7);
      for (let t = 2; t <= 7; t += 0.01) {
        near(gainAt(pts, t), 1.5 * P.fadeFactor(c, t), 1e-9);
      }
    }
  });
  test('只取 [a, b] 這一段', () => {
    const c = P.makeClip('audio', { start: 0, duration: 10, fadeIn: 2, fadeOut: 2 });
    const pts = gainPoints(c, 1, 5);
    assert.equal(pts[0][0], 1);
    assert.equal(pts.at(-1)[0], 5);
    near(pts[0][1], 0.5);
  });
  test('音量上限 200%', () => {
    const c = P.makeClip('audio', { duration: 1, volume: 5 });
    assert.equal(gainPoints(c, 0, 1)[0][1], 2);
  });
});

describe('audioPlan：每一段要播哪些聲音', () => {
  test('只包含跟這段時間重疊的片段，時間換算正確', () => {
    let p = project();
    p = P.addClip(p, 'audio', { mediaId: 'a', start: 5, srcIn: 10, duration: 20 }).project;
    const [piece] = audioPlan(p, 0, 10);
    near(piece.at, 5);
    near(piece.length, 5);
    near(piece.srcStart, 10);
    near(piece.srcEnd, 15);
    assert.deepEqual(audioPlan(p, 30, 40), []);
  });
  test('跨過段落邊界的片段：兩段接起來剛好是完整的素材範圍', () => {
    let p = project();
    p = P.addClip(p, 'audio', { mediaId: 'a', start: 7, srcIn: 3, duration: 10 }).project;
    const a = audioPlan(p, 0, 10)[0], b = audioPlan(p, 10, 20)[0];
    near(a.srcStart, 3); near(a.srcEnd, 6);
    near(b.srcStart, 6); near(b.srcEnd, 13);
    near(b.at, 0);
  });
  test('變速：素材範圍依速度換算', () => {
    let p = project();
    const r = P.addClip(p, 'video', { mediaId: 'v', start: 0, srcIn: 100, duration: 40 });
    p = P.updateClip(r.project, r.clip.id, { speed: 2 }); // 時間軸 0–20，素材 100–140
    const pieces = [0, 10].map(w => audioPlan(p, w, w + 10)[0]);
    near(pieces[0].srcStart, 100); near(pieces[0].srcEnd, 120);
    near(pieces[1].srcStart, 120); near(pieces[1].srcEnd, 140);
  });
  test('段內的音量包絡以段落開頭為 0', () => {
    let p = project();
    p = P.addClip(p, 'audio', { mediaId: 'a', start: 8, duration: 10, fadeIn: 4 }).project;
    const piece = audioPlan(p, 10, 20)[0];
    assert.equal(piece.gains[0][0], 0);
    near(piece.gains[0][1], 0.5); // 淡入 4 秒，第 2 秒時 50%
  });
  test('靜音片段、靜音軌道、音量 0、圖片和文字都不會出現', () => {
    let p = project();
    let r = P.addClip(p, 'audio', { mediaId: 'a', start: 0, duration: 5, muted: true });
    p = P.addClip(r.project, 'audio', { mediaId: 'a', start: 0, duration: 5, volume: 0, trackId: P.addTrack(r.project, 'audio').tracks.at(-1).id }).project;
    p = P.addClip(p, 'text', { start: 0 }).project;
    assert.deepEqual(audioPlan(p, 0, 10), []);
    let q = project();
    r = P.addClip(q, 'video', { mediaId: 'v', duration: 5 });
    q = P.updateTrack(r.project, r.clip.trackId, { muted: true });
    assert.equal(audibleClips(q).length, 0);
  });
  test('記憶體跟檔案大小無關：一小時的素材只取用到的 3 秒', () => {
    let p = P.createProject();
    p = P.addMedia(p, { id: 'big', type: 'video', name: '10GB.mp4', size: 10 * 1024 ** 3, duration: 3600, width: 3840, height: 2160 });
    p = P.addClip(p, 'video', { mediaId: 'big', srcIn: 1800, duration: 3 }).project;
    const [piece] = audioPlan(p, 0, 30);
    near(piece.srcStart, 1800);
    near(piece.srcEnd, 1803);
  });
});

describe('影片的聲音另外淡入淡出', () => {
  test('匯出混音用的是聲音的淡入淡出，不是畫面的', () => {
    let p = project();
    const r = P.addClip(p, 'video', { mediaId: 'v', duration: 10, fadeIn: 3 });
    p = P.updateClip(r.project, r.clip.id, { audioFades: { in: 0, out: 2 } });
    const c = P.getClip(p, r.clip.id);
    const pts = gainPoints(c, 0, 10);
    near(gainAt(pts, 1), 1);       // 畫面在淡入，聲音沒有
    near(gainAt(pts, 9), 0.5);     // 聲音在淡出
    near(gainAt(pts, 10), 0);
    for (let t = 0; t <= 10; t += 0.25) near(gainAt(pts, t), P.clipGainAt(p, c, Math.min(t, 9.999999)), 1e-5);
  });
});
