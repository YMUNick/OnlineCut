import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../assets/js/core/captions.js';

describe('AI 字幕：切字幕', () => {
  test('寬度：中文 1、英文 0.55', () => {
    assert.equal(C.textUnits('你好'), 2);
    assert.ok(Math.abs(C.textUnits('hello') - 2.75) < 1e-9);
    assert.equal(C.lineUnitsFor(1920, 56), 18);
    assert.equal(C.lineUnitsFor(1080, 56), 16);
  });

  test('長句優先在標點切，不超過上限', () => {
    const parts = C.splitText('今天天氣很好，我們一起去公園散步吧！然後再去吃晚餐，好不好？', 16);
    assert.ok(parts.length >= 2);
    for (const p of parts) assert.ok(C.textUnits(p) <= 16, p);
    assert.equal(parts[0], '今天天氣很好，');
    assert.equal(parts.join(''), '今天天氣很好，我們一起去公園散步吧！然後再去吃晚餐，好不好？');
  });

  test('英文不會從單字中間切', () => {
    const parts = C.splitText('The quick brown fox jumps over the lazy dog and keeps running far away', 12);
    for (const p of parts) assert.ok(C.textUnits(p) <= 12, p);
    assert.equal(parts.join(' '), 'The quick brown fox jumps over the lazy dog and keeps running far away');
  });

  test('換行：剛好兩行多一點也不會超過一行的上限', () => {
    const text = '這是一段很長很長很長很長很長很長很長很長很長很長很長很長的字幕會自動切開';
    const lines = C.wrapLines(text, 18).split('\n');
    assert.equal(lines.join(''), text);
    for (const l of lines) assert.ok(C.textUnits(l) <= 18, l);
  });

  test('沒有標點的中文直接切', () => {
    const parts = C.splitText('一二三四五六七八九十一二三四五六七八九十', 8);
    assert.deepEqual(parts.map(p => p.length), [8, 8, 4]);
  });

  test('buildCaptions：依字數分配時間、換行、去掉句尾逗號句號、不重疊', () => {
    const caps = C.buildCaptions([
      { start: 1, end: 5, text: ' 你好，歡迎來到這裡。今天我們要介紹一個免費、不用安裝的線上影片剪輯器，' },
      { start: 4.9, end: 6, text: '準備好了嗎？' },
      { start: 7, end: 7.1, text: '好。' },
    ], { lineUnits: 10, maxLines: 2 });
    assert.ok(caps.length >= 4);
    assert.equal(caps[0].start, 1);
    for (const c of caps) {
      assert.ok(c.text.split('\n').length <= 2, c.text);
      for (const line of c.text.split('\n')) assert.ok(C.textUnits(line) <= 11, line);
      assert.ok(!/[，。]$/.test(c.text), c.text);
    }
    for (let i = 1; i < caps.length; i++) assert.ok(caps[i].start >= caps[i - 1].end - 1e-9, '不重疊');
    assert.equal(caps.find(c => c.text === '準備好了嗎？').end, 6, '問號保留');
    const last = caps[caps.length - 1];
    assert.equal(last.text, '好');
    assert.ok(Math.abs(last.end - last.start - 0.6) < 1e-9, '太短的延長到 0.6 秒');
  });

  test('去掉安靜時的幻聽與空白段落', () => {
    const out = C.cleanSegments([
      { text: '真的有說話', no_speech_prob: 0.1, avg_logprob: -0.3 },
      { text: '謝謝觀看', no_speech_prob: 0.9, avg_logprob: -1.4 },
      { text: '   ' },
      { text: '啊啊啊啊啊啊啊啊', compression_ratio: 3.1 },
    ]);
    assert.deepEqual(out.map(s => s.text), ['真的有說話']);
  });

  test('只有文字時依句子平均分配時間', () => {
    const segs = C.segmentsFromText('第一句。第二句比較長一點！Third.', 10, 20);
    assert.equal(segs.length, 3);
    assert.equal(segs[0].start, 10);
    assert.ok(Math.abs(segs[2].end - 20) < 1e-9);
    assert.ok(segs[1].end - segs[1].start > segs[0].end - segs[0].start);
  });
});

describe('AI 字幕：檔案', () => {
  test('SRT', () => {
    assert.equal(C.formatSrtTime(3725.5), '01:02:05,500');
    assert.equal(C.toSRT([{ start: 0, end: 1.25, text: '你好' }, { start: 2, end: 3, text: 'a\nb' }]),
      '1\n00:00:00,000 --> 00:00:01,250\n你好\n\n2\n00:00:02,000 --> 00:00:03,000\na\nb\n');
  });

  test('WAV：16-bit 單聲道標頭與樣本', () => {
    const buf = C.encodeWav(new Float32Array([0, 1, -1, 2]), 16000);
    const v = new DataView(buf);
    assert.equal(buf.byteLength, 44 + 8);
    assert.equal(String.fromCharCode(...new Uint8Array(buf, 0, 4)), 'RIFF');
    assert.equal(v.getUint32(24, true), 16000);
    assert.equal(v.getUint16(22, true), 1);
    assert.deepEqual([0, 1, 2, 3].map(i => v.getInt16(44 + i * 2, true)), [0, 32767, -32768, 32767]);
  });

  test('在最安靜的地方切段', () => {
    const rate = 100;
    const s = new Float32Array(1000).map((_, i) => (i >= 600 && i < 640 ? 0 : Math.sin(i)));
    const cut = C.findQuietCut(s, rate, 500, 900);
    assert.ok(cut >= 600 && cut <= 640, `cut=${cut}`);
    assert.ok(C.rms(new Float32Array(100)) === 0);
  });
});
