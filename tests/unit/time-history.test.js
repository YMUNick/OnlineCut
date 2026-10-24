import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatTimecode, formatDuration, quantize, rulerStep, formatRulerLabel } from '../../assets/js/core/time.js';
import { History } from '../../assets/js/core/history.js';

describe('time', () => {
  test('formatTimecode', () => {
    assert.equal(formatTimecode(0), '00:00:00:00');
    assert.equal(formatTimecode(83.5), '00:01:23:15');
    assert.equal(formatTimecode(3661 + 29 / 30), '01:01:01:29');
    assert.equal(formatTimecode(-5), '00:00:00:00');
    assert.equal(formatTimecode(1, 25), '00:00:01:00');
  });
  test('formatTimecode 進位不會出現第 30 格', () => {
    assert.equal(formatTimecode(0.999), '00:00:01:00');
  });
  test('formatDuration', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(83.4), '1:23');
    assert.equal(formatDuration(3723), '1:02:03');
    assert.equal(formatDuration(NaN), '--:--');
    assert.equal(formatDuration(Infinity), '--:--');
  });
  test('quantize 對齊影格', () => {
    assert.equal(quantize(1.01), 1);
    assert.equal(quantize(1.02), 31 / 30);
  });
  test('rulerStep 讓刻度至少相隔 80px', () => {
    assert.equal(rulerStep(100), 1);
    assert.equal(rulerStep(10), 10);
    assert.equal(rulerStep(1000), 0.1);
    assert.equal(rulerStep(500), 0.25);
    assert.equal(rulerStep(0.01), 600);
  });
  test('formatRulerLabel', () => {
    assert.equal(formatRulerLabel(65, 5), '1:05');
    assert.equal(formatRulerLabel(1.5, 0.5), '0:01.5');
  });
});

describe('History', () => {
  test('undo / redo', () => {
    const h = new History();
    h.record('a', null, 0);
    h.record('b', null, 1);
    assert.equal(h.undo('c'), 'b');
    assert.equal(h.undo('b'), 'a');
    assert.equal(h.undo('a'), null);
    assert.equal(h.redo('a'), 'b');
    assert.equal(h.redo('b'), 'c');
    assert.equal(h.redo('c'), null);
  });
  test('新操作會清掉 redo', () => {
    const h = new History();
    h.record('a', null, 0);
    h.undo('b');
    h.record('a', null, 1);
    assert.equal(h.canRedo, false);
  });
  test('同 key 短時間內合併成一步', () => {
    const h = new History({ coalesceMs: 500 });
    h.record('s0', 'opacity', 0);
    h.record('s1', 'opacity', 100);
    h.record('s2', 'opacity', 200);
    assert.equal(h.past.length, 1);
    assert.equal(h.undo('s3'), 's0');
  });
  test('同 key 間隔太久就分開', () => {
    const h = new History({ coalesceMs: 500 });
    h.record('s0', 'opacity', 0);
    h.record('s1', 'opacity', 1000);
    assert.equal(h.past.length, 2);
  });
  test('undo 之後同 key 不會被合併到舊的一步', () => {
    const h = new History({ coalesceMs: 500 });
    h.record('s0', 'k', 0);
    h.undo('s1');
    h.record('s0', 'k', 100);
    assert.equal(h.past.length, 1);
  });
  test('超過上限丟掉最舊的', () => {
    const h = new History({ limit: 3 });
    for (let i = 0; i < 5; i++) h.record(i, null, i);
    assert.deepEqual(h.past, [2, 3, 4]);
  });
});
