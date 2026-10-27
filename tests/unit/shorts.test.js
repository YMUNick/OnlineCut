import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../assets/js/core/project.js';
import * as S from '../../assets/js/core/shorts.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const segs = [
  { start: 0, end: 4, text: '大家好' },
  { start: 5, end: 12, text: '今天要講三個重點' },
  { start: 12.2, end: 20, text: '第一個重點是速度' },
  { start: 30, end: 38, text: '最驚人的是完全免費' },
  { start: 50, end: 56, text: '謝謝收看' },
];

describe('AI 短影音', () => {
  test('提示裡有編號、時間、目標長度與重點', () => {
    const [sys, user] = S.buildShortPrompt(segs, { target: 30, hint: '價格' });
    assert.match(sys.content, /about 30 seconds/);
    assert.match(sys.content, /Traditional Chinese/);
    assert.match(user.content, /\[3\] 30\.0-38\.0s 最驚人的是完全免費/);
    assert.match(user.content, /What to focus on: 價格/);
  });

  test('解析回覆：容許多餘文字、去掉不合法與重複的編號', () => {
    const r = S.parseShortReply('好的！```json\n{"segments":[3,"1",1,99,-1,2],"title":"免費又快","reason":"開頭有爆點"}\n```', 5);
    assert.deepEqual(r, { ids: [3, 1, 2], title: '免費又快', reason: '開頭有爆點' });
    assert.equal(S.parseShortReply('不是 JSON', 5), null);
    assert.equal(S.parseShortReply('{"segments":[42]}', 5), null);
  });

  test('範圍：前後留白、順序相連的段落合併、可以把精華移到開頭、總長上限', () => {
    const r = S.pickRanges(segs, [3, 1, 2], { pad: 0.2, mergeGap: 0.6 });
    assert.equal(r.length, 2);
    near(r[0][0], 29.8); near(r[0][1], 38.2);
    near(r[1][0], 4.8); near(r[1][1], 20.2);
    near(S.rangesDuration(r), 8.4 + 15.4);
    const capped = S.pickRanges(segs, [3, 1, 2], { pad: 0.2, maxTotal: 12 });
    near(S.rangesDuration(capped), 12);
  });

  test('時間換算與字幕段落', () => {
    const r = [[30, 38], [5, 20]];
    assert.equal(S.mapTime(r, 31), 1);
    assert.equal(S.mapTime(r, 6), 9);
    assert.equal(S.mapTime(r, 25), null);
    const m = S.remapSegments(segs, r);
    assert.deepEqual(m.map(x => [x.start, x.end, x.text]), [[0, 8, '最驚人的是完全免費'], [8, 15, '今天要講三個重點'], [15.2, 23, '第一個重點是速度']]);
  });

  test('extractRanges：影片切開接起來、素材時間正確；音樂連續播放；換成直式填滿', () => {
    let p = P.createProject();
    p = P.addMedia(p, { id: 'mv', type: 'video', name: 'talk.mp4', duration: 60, width: 1920, height: 1080 });
    p = P.addMedia(p, { id: 'ma', type: 'audio', name: 'bgm.mp3', duration: 120 });
    p = P.addClip(p, 'video', { mediaId: 'mv', start: 0, srcIn: 0 }).project;
    p = P.addClip(p, 'audio', { mediaId: 'ma', start: 0 }).project;
    p = P.addClip(p, 'text', { start: 29, duration: 4, text: { content: '標題' }, trackId: p.tracks.find(t => t.name === 'V2').id }).project;
    const out = S.extractRanges(p, [[30, 38], [5, 20]], { keepMusic: true, aspect: '9:16', fill: true });
    const vids = out.clips.filter(c => c.type === 'video').sort((a, b) => a.start - b.start);
    assert.deepEqual(vids.map(c => [c.start, c.duration, c.srcIn]), [[0, 8, 30], [8, 15, 5]]);
    const music = out.clips.filter(c => c.type === 'audio');
    assert.equal(music.length, 1);
    assert.deepEqual([music[0].start, music[0].duration, music[0].srcIn], [0, 23, 30]);
    assert.ok(music[0].fadeOut > 0, '音樂結尾淡出');
    const text = out.clips.find(c => c.type === 'text');
    assert.deepEqual([text.start, text.duration], [0, 3], '文字也跟著剪');
    assert.equal(out.aspect, '9:16');
    near(vids[0].transform.scale, (1920 / 1080) / (1080 / 1920), 1e-9); // 橫式影片放大填滿直式畫面
    assert.equal(new Set(out.clips.map(c => c.id)).size, out.clips.length, 'id 不重複');
    assert.deepEqual(P.normalizeProject(JSON.parse(JSON.stringify(out))).clips.length, out.clips.length, '結果是合法的專案');
    // 不保留音樂連續：音樂也跟著剪
    const cut = S.extractRanges(p, [[30, 38], [5, 20]], { keepMusic: false });
    assert.equal(cut.clips.filter(c => c.type === 'audio').length, 2);
    assert.equal(cut.aspect, '16:9');
  });
});
