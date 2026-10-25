import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../assets/js/core/project.js';
import * as T from '../../assets/js/core/transitions.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

/** V1 上緊接著的三段：影片 [0,4)、圖片 [4,7)、影片 [7,10)；V2 上一段文字 */
function setup() {
  let p = P.createProject();
  p = P.addMedia(p, { id: 'mv', type: 'video', name: 'a.mp4', duration: 10, width: 1920, height: 1080 });
  p = P.addMedia(p, { id: 'mi', type: 'image', name: 'a.png', width: 800, height: 600 });
  const v1 = p.tracks.find(t => t.name === 'V1').id;
  let r = P.addClip(p, 'video', { mediaId: 'mv', start: 0, duration: 4, srcIn: 2, trackId: v1 });
  const a = r.clip;
  r = P.addClip(r.project, 'image', { mediaId: 'mi', start: 4, duration: 3, trackId: v1 });
  const b = r.clip;
  r = P.addClip(r.project, 'video', { mediaId: 'mv', start: 7, duration: 3, srcIn: 0, trackId: v1 });
  const c = r.clip;
  r = P.addClip(r.project, 'text', { start: 3, duration: 2 });
  return { p: r.project, a: a.id, b: b.id, c: c.id, text: r.clip.id };
}
const get = (p, id) => P.getClip(p, id);

describe('轉場', () => {
  test('相鄰片段', () => {
    const { p, a, b, c, text } = setup();
    assert.equal(T.prevAdjacent(p, get(p, b)).id, a);
    assert.equal(T.nextAdjacent(p, get(p, b)).id, c);
    assert.equal(T.prevAdjacent(p, get(p, a)), null);
    assert.equal(T.prevAdjacent(p, get(p, text)), null, '文字不能轉場');
  });

  test('updateClip 設定、合併、清除與修正', () => {
    let { p, b, text } = setup();
    p = P.updateClip(p, b, { transitionIn: { type: 'wipe' } });
    assert.deepEqual(get(p, b).transitionIn, { type: 'wipe', duration: T.DEFAULT_TRANSITION });
    p = P.updateClip(p, b, { transitionIn: { duration: 99 } });
    assert.deepEqual(get(p, b).transitionIn, { type: 'wipe', duration: T.MAX_TRANSITION });
    p = P.updateClip(p, b, { transitionIn: { type: 'bogus' } });
    assert.equal(get(p, b).transitionIn.type, 'fade', '不認識的類型改成溶解');
    p = P.updateClip(p, b, { transitionIn: null });
    assert.equal(get(p, b).transitionIn, null);
    p = P.updateClip(p, text, { transitionIn: { type: 'fade' } });
    assert.equal(get(p, text).transitionIn, null, '文字片段不能有轉場');
  });

  test('實際長度不超過兩段的長度；接點在中間', () => {
    let { p, b, c } = setup();
    p = P.updateClip(p, c, { transitionIn: { type: 'fade', duration: 5 } });
    const tr = T.effectiveTransition(p, get(p, c));
    near(tr.duration, 3);
    near(tr.start, 5.5);
    near(tr.end, 8.5);
    assert.equal(tr.from.id, b);
  });

  test('沒有緊接著前一段就沒有效果（例如中間有空隙）', () => {
    let { p, b } = setup();
    p = P.updateClip(p, b, { transitionIn: { type: 'fade', duration: 1 } });
    assert.ok(T.effectiveTransition(p, get(p, b)));
    p = P.trimClip(p, b, 'start', 4.5);
    near(get(p, b).start, 4.5);
    assert.equal(T.effectiveTransition(p, get(p, b)), null);
  });

  test('畫面範圍與 visualClipsAt：轉場中兩段都在、前一段先畫', () => {
    let { p, a, b, c } = setup();
    p = P.updateClip(p, b, { transitionIn: { type: 'fade', duration: 1 } });
    assert.deepEqual(T.visualRange(p, get(p, a)), [0, 4.5]);
    assert.deepEqual(T.visualRange(p, get(p, b)), [3.5, 7]);
    assert.deepEqual(T.visualRange(p, get(p, c)), [7, 10]);
    const ids = (t) => T.visualClipsAt(p, t).filter(x => x.type !== 'text').map(x => x.id);
    assert.deepEqual(ids(3.4), [a]);
    assert.deepEqual(ids(3.6), [a, b]);
    assert.deepEqual(ids(4.4), [a, b]);
    assert.deepEqual(ids(4.6), [b]);
    near(T.transitionProgress(T.effectiveTransition(p, get(p, b)), 4), 0.5);
    assert.equal(T.transitionProgress(T.effectiveTransition(p, get(p, b)), 5), null);
  });

  test('多出來的部分：有素材就繼續播，沒有就停在第一格 / 最後一格', () => {
    let { p, a, c } = setup();
    // a：素材 2–6 秒，後面還有素材
    near(T.visualSourceTime(p, get(p, a), 4.5), 6.5);
    near(T.visualSourceTime(p, get(p, a), 2), 4);
    // c：從素材 0 開始，前面沒有素材 → 停在 0
    assert.equal(T.visualSourceTime(p, get(p, c), 6.5), 0);
    // 素材結尾之後停在最後一格前
    const end = T.visualSourceTime(p, { ...get(p, a), srcIn: 6 }, 4.9);
    assert.ok(end < 10 && end > 9.9);
    near(T.visualTime(get(p, c), 6), 7);
  });

  test('分割後右半段沒有轉場、左半段保留', () => {
    let { p, b } = setup();
    p = P.updateClip(p, b, { transitionIn: { type: 'iris', duration: 1 } });
    const r = P.splitClip(p, b, 5.5);
    assert.equal(get(r.project, b).transitionIn.type, 'iris');
    assert.equal(r.project.clips.find(x => x.id !== b && x.start === 5.5).transitionIn, null);
  });

  test('存檔讀回：轉場保留，壞掉的值會修正', () => {
    let { p, b, text } = setup();
    p = P.updateClip(p, b, { transitionIn: { type: 'push', duration: 1.2 } });
    const raw = JSON.parse(JSON.stringify(p));
    assert.deepEqual(get(P.normalizeProject(raw), b).transitionIn, { type: 'push', duration: 1.2 });
    raw.clips.find(x => x.id === b).transitionIn = { type: 'push', duration: 'x' };
    raw.clips.find(x => x.id === text).transitionIn = { type: 'fade', duration: 1 };
    const n = P.normalizeProject(raw);
    assert.equal(get(n, b).transitionIn.type, 'push');
    assert.ok(get(n, b).transitionIn.duration >= T.MIN_TRANSITION);
    assert.equal(get(n, text).transitionIn, null);
  });
});
