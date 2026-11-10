import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../assets/js/core/project.js';
import { textAnimState, visibleCount } from '../../assets/js/core/text-anim.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

describe('文字動畫', () => {
  test('整理：不認識的效果拿掉、長度夾在範圍內、什麼都沒有就是 null', () => {
    assert.equal(P.cleanTextAnim(null), null);
    assert.equal(P.cleanTextAnim('pop'), null);
    assert.equal(P.cleanTextAnim({ in: 'bogus', loop: 42 }), null);
    assert.deepEqual(P.cleanTextAnim({ in: 'pop', out: 'nope', duration: 99 }), { in: 'pop', out: '', loop: '', duration: 5 });
    assert.deepEqual(P.cleanTextAnim({ loop: 'rainbow', duration: 'x' }), { in: '', out: '', loop: 'rainbow', duration: P.DEFAULT_TEXT_ANIM_DURATION });
  });

  test('沒有動畫：完全不變', () => {
    assert.deepEqual(textAnimState(null, 1, 3), { alpha: 1, dx: 0, dy: 0, scale: 1, rot: 0, blur: 0, chars: 1, hue: 0 });
  });

  test('淡入、淡出：出場是進場倒著播', () => {
    const a = { in: 'fade', out: 'fade', loop: '', duration: 1 };
    near(textAnimState(a, 0, 4).alpha, 0);
    near(textAnimState(a, 0.5, 4).alpha, 0.5);
    near(textAnimState(a, 2, 4).alpha, 1);
    near(textAnimState(a, 3.5, 4).alpha, 0.5);
    near(textAnimState(a, 4, 4).alpha, 0);
  });

  test('片段太短：進場出場各佔一半，不會重疊', () => {
    const a = { in: 'fade', out: 'fade', loop: '', duration: 2 };
    near(textAnimState(a, 0.5, 1).alpha, 1);
    near(textAnimState(a, 0.25, 1).alpha, 0.5);
  });

  test('各種效果的方向', () => {
    const at = (kind, q) => textAnimState({ in: kind, out: '', loop: '', duration: 1 }, q, 10);
    assert.ok(at('slideUp', 0).dy > 1, '從下面上來');
    assert.ok(at('slideLeft', 0).dx > 2, '從右邊進來');
    assert.ok(at('drop', 0).dy < -3, '從上面掉下來');
    assert.ok(at('zoom', 0).scale > 2, '從大縮回來');
    assert.ok(at('pop', 0.5).scale > 1, '彈出時會超過一點');
    near(at('pop', 1).scale, 1);
    assert.ok(at('blur', 0.2).blur > 0.3);
    near(at('typewriter', 0.25).chars, 0.25);
    for (const k of P.TEXT_ANIMS) {
      const end = at(k, 1);
      assert.deepEqual([end.alpha, end.dx, end.dy, end.blur, end.chars], [1, 0, 0, 0, 1], `${k} 結束時回到原位`);
      near(end.scale, 1);
    }
  });

  test('持續動態：有在動、透明度不會小於 0', () => {
    const at = (loop, t) => textAnimState({ in: '', out: '', loop, duration: 0.5 }, t, 10);
    assert.notEqual(at('float', 0.5).dy, at('float', 1.5).dy);
    assert.notEqual(at('swing', 0.4).rot, 0);
    assert.ok(at('blink', 0.45).alpha < 0.2 && at('blink', 0.45).alpha >= 0);
    near(at('rainbow', 1.5).hue, 180);
    assert.ok(at('pulse', 0.3).scale > 1);
  });

  test('打字機要顯示的字數（換行不算）', () => {
    assert.equal(visibleCount(['你好', 'abc'], 0), 0);
    assert.equal(visibleCount(['你好', 'abc'], 0.5), 2);
    assert.equal(visibleCount(['你好', 'abc'], 1), 5);
    assert.equal(visibleCount(['😀😀'], 0.5), 1, '表情符號算一個字');
  });

  test('片段：建立、更新、存檔讀回都保留動畫；壞值會被修正', () => {
    let { project, clip } = P.addClip(P.createProject(), 'text', { text: { content: 'Hi', anim: { in: 'pop', duration: 0.5 } } });
    assert.deepEqual(P.getClip(project, clip.id).text.anim, { in: 'pop', out: '', loop: '', duration: 0.5 });
    project = P.updateClip(project, clip.id, { text: { anim: { in: 'pop', loop: 'shake', duration: 0.5 } } });
    assert.equal(P.getClip(project, clip.id).text.anim.loop, 'shake');
    const raw = JSON.parse(JSON.stringify(project));
    assert.deepEqual(P.getClip(P.normalizeProject(raw), clip.id).text.anim, P.getClip(project, clip.id).text.anim);
    raw.clips[0].text.anim = { in: '<script>', duration: -1 };
    assert.equal(P.normalizeProject(raw).clips[0].text.anim, null);
    project = P.updateClip(project, clip.id, { text: { anim: null } });
    assert.equal(P.getClip(project, clip.id).text.anim, null);
  });

  test('轉場種類：19 種、都有對應', () => {
    assert.equal(P.TRANSITION_TYPES.length, 19);
    assert.equal(new Set(P.TRANSITION_TYPES).size, 19);
  });
});
