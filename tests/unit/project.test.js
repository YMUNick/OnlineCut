import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../assets/js/core/project.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

/** 一個有 10 秒影片素材、10 秒音訊素材、一張圖片的專案 */
function setup() {
  let p = P.createProject();
  p = P.addMedia(p, { id: 'mv', type: 'video', name: 'a.mp4', duration: 10, width: 1920, height: 1080, hasAudio: true });
  p = P.addMedia(p, { id: 'ma', type: 'audio', name: 'a.mp3', duration: 10 });
  p = P.addMedia(p, { id: 'mi', type: 'image', name: 'a.png', width: 800, height: 600 });
  return p;
}
const v1 = (p) => p.tracks.find(t => t.name === 'V1');
const v2 = (p) => p.tracks.find(t => t.name === 'V2');
const a1 = (p) => p.tracks.find(t => t.name === 'A1');

describe('createProject', () => {
  test('預設 16:9 1080p、三條軌道', () => {
    const p = P.createProject();
    assert.equal(p.width, 1920);
    assert.equal(p.height, 1080);
    assert.deepEqual(p.tracks.map(t => t.name), ['V2', 'V1', 'A1']);
  });
  test('直式比例', () => {
    const p = P.createProject({ aspect: '9:16' });
    assert.equal(p.width, 1080);
    assert.equal(p.height, 1920);
  });
  test('不認得的比例退回 16:9', () => {
    assert.equal(P.createProject({ aspect: '7:3' }).aspect, '16:9');
  });
});

describe('addClip', () => {
  test('影片預設放主軌 V1、長度等於素材長度', () => {
    const { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    assert.equal(clip.trackId, v1(project).id);
    assert.equal(clip.start, 0);
    assert.equal(clip.duration, 10);
  });
  test('接在同軌最後一個片段後面', () => {
    let { project } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    const { clip } = P.addClip(project, 'video', { mediaId: 'mv' });
    assert.equal(clip.start, 10);
  });
  test('音訊放到音訊軌', () => {
    const { project, clip } = P.addClip(setup(), 'audio', { mediaId: 'ma' });
    assert.equal(clip.trackId, a1(project).id);
  });
  test('指定不相容的軌道時改放相容的軌道', () => {
    const p = setup();
    const { project, clip } = P.addClip(p, 'audio', { mediaId: 'ma', trackId: v1(p).id });
    assert.equal(P.getTrack(project, clip.trackId).kind, 'audio');
  });
  test('圖片與文字有預設長度', () => {
    const p = setup();
    assert.equal(P.addClip(p, 'image', { mediaId: 'mi' }).clip.duration, P.DEFAULT_IMAGE_DURATION);
    const t = P.addClip(p, 'text', {}).clip;
    assert.equal(t.duration, P.DEFAULT_TEXT_DURATION);
    assert.equal(t.text.content, '輸入標題文字');
  });
  test('指定位置重疊時放到最近的空位', () => {
    let { project } = P.addClip(setup(), 'video', { mediaId: 'mv' }); // 0–10
    const { clip } = P.addClip(project, 'image', { mediaId: 'mi', start: 3, trackId: v1(project).id });
    assert.equal(clip.start, 10);
  });
  test('影片長度不能超過素材剩餘長度', () => {
    const { clip } = P.addClip(setup(), 'video', { mediaId: 'mv', srcIn: 4, duration: 100 });
    assert.equal(clip.duration, 6);
  });
  test('影片軌都鎖住時自動新增軌道', () => {
    let p = setup();
    for (const t of p.tracks.filter(t => t.kind === 'video')) p = P.updateTrack(p, t.id, { locked: true });
    const { project, clip } = P.addClip(p, 'video', { mediaId: 'mv' });
    assert.equal(project.tracks.filter(t => t.kind === 'video').length, 3);
    assert.equal(P.getTrack(project, clip.trackId).name, 'V3');
  });
  test('不會修改原本的 project', () => {
    const p = setup();
    const before = JSON.stringify(p);
    P.addClip(p, 'video', { mediaId: 'mv' });
    assert.equal(JSON.stringify(p), before);
  });
});

describe('moveClip', () => {
  test('移動到空位', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    project = P.moveClip(project, clip.id, { start: 5 });
    assert.equal(P.getClip(project, clip.id).start, 5);
  });
  test('不能移到負的時間', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    project = P.moveClip(project, clip.id, { start: -3 });
    assert.equal(P.getClip(project, clip.id).start, 0);
  });
  test('撞到其他片段時放到最近的空位', () => {
    let p = setup();
    let a, b;
    ({ project: p, clip: a } = P.addClip(p, 'image', { mediaId: 'mi', start: 0, duration: 5 }));
    ({ project: p, clip: b } = P.addClip(p, 'image', { mediaId: 'mi', start: 10, duration: 5 }));
    p = P.moveClip(p, b.id, { start: 2 }); // 與 a(0–5) 重疊 → 最近的空位是 5
    assert.equal(P.getClip(p, b.id).start, 5);
  });
  test('換到相容的軌道', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    project = P.moveClip(project, clip.id, { start: 0, trackId: v2(project).id });
    assert.equal(P.getClip(project, clip.id).trackId, v2(project).id);
  });
  test('影片不能移到音訊軌', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    const moved = P.moveClip(project, clip.id, { start: 0, trackId: a1(project).id });
    assert.equal(moved, project);
  });
  test('不能移到鎖定的軌道', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    project = P.updateTrack(project, v2(project).id, { locked: true });
    assert.equal(P.moveClip(project, clip.id, { trackId: v2(project).id }), project);
  });
  test('不存在的片段不動', () => {
    const p = setup();
    assert.equal(P.moveClip(p, 'nope', { start: 1 }), p);
  });
});

describe('trimClip', () => {
  test('修剪右緣', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    project = P.trimClip(project, clip.id, 'end', 4);
    assert.equal(P.getClip(project, clip.id).duration, 4);
  });
  test('右緣不能超過素材長度', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    project = P.trimClip(project, clip.id, 'end', 4);
    project = P.trimClip(project, clip.id, 'end', 50);
    assert.equal(P.getClip(project, clip.id).duration, 10);
  });
  test('修剪左緣會同時移動素材入點', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    project = P.trimClip(project, clip.id, 'start', 3);
    const c = P.getClip(project, clip.id);
    assert.equal(c.start, 3);
    assert.equal(c.srcIn, 3);
    assert.equal(c.duration, 7);
  });
  test('左緣不能超過素材開頭', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv', start: 5 });
    project = P.trimClip(project, clip.id, 'start', 2); // srcIn 已是 0，不能再往左
    const c = P.getClip(project, clip.id);
    assert.equal(c.start, 5);
    assert.equal(c.srcIn, 0);
  });
  test('左緣拉回來可以恢復被修掉的部分', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    project = P.trimClip(project, clip.id, 'start', 3);
    project = P.trimClip(project, clip.id, 'start', 0);
    const c = P.getClip(project, clip.id);
    assert.deepEqual([c.start, c.srcIn, c.duration], [0, 0, 10]);
  });
  test('不能修剪到撞進相鄰片段', () => {
    let p = setup();
    let a;
    ({ project: p, clip: a } = P.addClip(p, 'image', { mediaId: 'mi', start: 0, duration: 3 }));
    ({ project: p } = P.addClip(p, 'image', { mediaId: 'mi', start: 4, duration: 3 }));
    p = P.trimClip(p, a.id, 'end', 10);
    assert.equal(P.clipEnd(P.getClip(p, a.id)), 4);
  });
  test('最短一格', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    project = P.trimClip(project, clip.id, 'end', -5);
    near(P.getClip(project, clip.id).duration, 1 / 30);
    project = P.trimClip(project, clip.id, 'start', 100);
    near(P.getClip(project, clip.id).duration, 1 / 30);
  });
  test('變速 2x 時素材範圍加倍計算', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    project = P.updateClip(project, clip.id, { speed: 2 });
    assert.equal(P.getClip(project, clip.id).duration, 5);
    project = P.trimClip(project, clip.id, 'start', 1); // 時間軸 1 秒 = 素材 2 秒
    const c = P.getClip(project, clip.id);
    assert.equal(c.srcIn, 2);
    assert.equal(c.duration, 4);
  });
  test('修剪後淡入淡出不超過片段長度', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv', fadeIn: 3, fadeOut: 3 });
    project = P.trimClip(project, clip.id, 'end', 2);
    const c = P.getClip(project, clip.id);
    assert.equal(c.fadeIn, 2);
    assert.equal(c.fadeOut, 2);
  });
  test('圖片可以無限延長', () => {
    let { project, clip } = P.addClip(setup(), 'image', { mediaId: 'mi' });
    project = P.trimClip(project, clip.id, 'end', 3600);
    assert.equal(P.getClip(project, clip.id).duration, 3600);
  });
});

describe('splitClip', () => {
  test('分割成兩段，右段的入點正確', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv', srcIn: 1, fadeIn: 1, fadeOut: 1 });
    const r = P.splitClip(project, clip.id, 4);
    const left = P.getClip(r.project, clip.id);
    const right = P.getClip(r.project, r.rightId);
    assert.deepEqual([left.start, left.duration, left.srcIn, left.fadeOut], [0, 4, 1, 0]);
    assert.deepEqual([right.start, right.duration, right.srcIn, right.fadeIn, right.fadeOut], [4, 5, 5, 0, 1]);
    assert.equal(left.fadeIn, 1);
  });
  test('變速片段分割', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    project = P.updateClip(project, clip.id, { speed: 2 }); // 0–5
    const r = P.splitClip(project, clip.id, 2);
    assert.equal(P.getClip(r.project, r.rightId).srcIn, 4);
  });
  test('分割點在片段外或貼著邊緣時不動', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    for (const t of [-1, 0, 0.001, 10, 9.999, 20]) {
      const r = P.splitClip(project, clip.id, t);
      assert.equal(r.project, project, `t=${t}`);
      assert.equal(r.rightId, null);
    }
  });
  test('splitAtPlayhead：沒有選取時分割所有經過播放頭的片段，略過鎖定軌', () => {
    let p = setup();
    ({ project: p } = P.addClip(p, 'video', { mediaId: 'mv' }));
    ({ project: p } = P.addClip(p, 'audio', { mediaId: 'ma' }));
    ({ project: p } = P.addClip(p, 'text', { trackId: v2(p).id, start: 3 }));
    p = P.updateTrack(p, v2(p).id, { locked: true });
    const r = P.splitAtPlayhead(p, 5);
    assert.equal(r.created.length, 2);
    assert.equal(r.project.clips.length, 5);
  });
  test('splitAtPlayhead：有選取時只分割選取的', () => {
    let p = setup(), a;
    ({ project: p, clip: a } = P.addClip(p, 'video', { mediaId: 'mv' }));
    ({ project: p } = P.addClip(p, 'audio', { mediaId: 'ma' }));
    const r = P.splitAtPlayhead(p, 5, [a.id]);
    assert.equal(r.created.length, 1);
  });
});

describe('deleteClips', () => {
  function three() {
    let p = setup(), a, b, c;
    ({ project: p, clip: a } = P.addClip(p, 'image', { mediaId: 'mi', duration: 2 }));
    ({ project: p, clip: b } = P.addClip(p, 'image', { mediaId: 'mi', duration: 3 }));
    ({ project: p, clip: c } = P.addClip(p, 'image', { mediaId: 'mi', duration: 4 }));
    return { p, a, b, c };
  }
  test('一般刪除留下空隙', () => {
    const { p, b, c } = three();
    const n = P.deleteClips(p, [b.id]);
    assert.equal(n.clips.length, 2);
    assert.equal(P.getClip(n, c.id).start, 5);
  });
  test('波紋刪除會補位', () => {
    const { p, b, c } = three();
    const n = P.deleteClips(p, [b.id], { ripple: true });
    assert.equal(P.getClip(n, c.id).start, 2);
  });
  test('波紋刪除多個片段', () => {
    const { p, a, b, c } = three();
    const n = P.deleteClips(p, [a.id, b.id], { ripple: true });
    assert.equal(P.getClip(n, c.id).start, 0);
  });
  test('波紋刪除不影響其他軌道', () => {
    let { p, b } = three();
    let au;
    ({ project: p, clip: au } = P.addClip(p, 'audio', { mediaId: 'ma', start: 6 }));
    const n = P.deleteClips(p, [b.id], { ripple: true });
    assert.equal(P.getClip(n, au.id).start, 6);
  });
  test('鎖定軌道上的片段不能刪', () => {
    let { p, b } = three();
    p = P.updateTrack(p, b.trackId, { locked: true });
    assert.equal(P.deleteClips(p, [b.id]), p);
  });
  test('刪除不存在的片段不動', () => {
    const { p } = three();
    assert.equal(P.deleteClips(p, ['x']), p);
  });
});

describe('updateClip', () => {
  test('數值範圍限制', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    project = P.updateClip(project, clip.id, {
      opacity: 5, volume: -1, transform: { scale: 0, rotation: 450 },
      filters: { brightness: 999, blur: -3 }, fadeIn: 99,
    });
    const c = P.getClip(project, clip.id);
    assert.equal(c.opacity, 1);
    assert.equal(c.volume, 0);
    assert.equal(c.transform.scale, 0.01);
    assert.equal(c.transform.rotation, 90);
    assert.equal(c.filters.brightness, 200);
    assert.equal(c.filters.blur, 0);
    assert.equal(c.fadeIn, 10);
  });
  test('NaN 不會寫進去', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    project = P.updateClip(project, clip.id, { opacity: 'abc', volume: NaN });
    const c = P.getClip(project, clip.id);
    assert.equal(c.opacity, 0);
    assert.equal(c.volume, 0);
  });
  test('不能透過 update 改位置與型別', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    project = P.updateClip(project, clip.id, { start: 99, type: 'text', id: 'hack', duration: 1 });
    const c = P.getClip(project, clip.id);
    assert.deepEqual([c.start, c.type, c.duration], [0, 'video', 10]);
  });
  test('變速範圍 0.25–4', () => {
    let { project, clip } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    project = P.updateClip(project, clip.id, { speed: 100 });
    assert.equal(P.getClip(project, clip.id).speed, 4);
    assert.equal(P.getClip(project, clip.id).duration, 2.5);
    project = P.updateClip(project, clip.id, { speed: 0 });
    assert.equal(P.getClip(project, clip.id).speed, 1); // 0 視為無效，回到 1
  });
  test('放慢時撞到後面的片段會截短', () => {
    let p = setup(), a;
    ({ project: p, clip: a } = P.addClip(p, 'video', { mediaId: 'mv' }));
    ({ project: p } = P.addClip(p, 'video', { mediaId: 'mv' })); // 10–20
    p = P.updateClip(p, a.id, { speed: 0.5 });
    assert.equal(P.getClip(p, a.id).duration, 10);
  });
  test('圖片不支援變速', () => {
    let { project, clip } = P.addClip(setup(), 'image', { mediaId: 'mi' });
    project = P.updateClip(project, clip.id, { speed: 2 });
    assert.equal(P.getClip(project, clip.id).speed, 1);
  });
  test('文字字級範圍', () => {
    let { project, clip } = P.addClip(setup(), 'text', {});
    project = P.updateClip(project, clip.id, { text: { fontSize: 99999, content: '你好' } });
    const c = P.getClip(project, clip.id);
    assert.equal(c.text.fontSize, 600);
    assert.equal(c.text.content, '你好');
  });
});

describe('duplicateClip', () => {
  test('複製到後面', () => {
    let { project, clip } = P.addClip(setup(), 'image', { mediaId: 'mi' });
    const r = P.duplicateClip(project, clip.id);
    assert.equal(r.clip.start, 5);
    assert.notEqual(r.clip.id, clip.id);
    assert.equal(r.project.clips.length, 2);
  });
});

describe('播放相關計算', () => {
  test('activeClipsAt：上層軌道在後面（後畫）、略過隱藏軌', () => {
    let p = setup(), bottom, top;
    ({ project: p, clip: bottom } = P.addClip(p, 'video', { mediaId: 'mv' }));
    ({ project: p, clip: top } = P.addClip(p, 'text', { trackId: v2(p).id }));
    assert.deepEqual(P.activeClipsAt(p, 1).map(c => c.id), [bottom.id, top.id]);
    p = P.updateTrack(p, v2(p).id, { hidden: true });
    assert.deepEqual(P.activeClipsAt(p, 1).map(c => c.id), [bottom.id]);
  });
  test('activeClipsAt：結尾那一刻不算在片段內', () => {
    const { project } = P.addClip(setup(), 'image', { mediaId: 'mi' });
    assert.equal(P.activeClipsAt(project, 5).length, 0);
    assert.equal(P.activeClipsAt(project, 4.999).length, 1);
  });
  test('sourceTime 考慮入點與變速', () => {
    const c = P.makeClip('video', { start: 10, srcIn: 2, speed: 2 });
    assert.equal(P.sourceTime(c, 13), 8);
  });
  test('淡入淡出', () => {
    const c = P.makeClip('video', { start: 0, duration: 10, fadeIn: 2, fadeOut: 4 });
    assert.equal(P.fadeFactor(c, 0), 0);
    assert.equal(P.fadeFactor(c, 1), 0.5);
    assert.equal(P.fadeFactor(c, 5), 1);
    assert.equal(P.fadeFactor(c, 8), 0.5);
    assert.equal(P.fadeFactor(c, 10), 0);
  });
  test('淡入淡出重疊時取較小值', () => {
    const c = P.makeClip('video', { start: 0, duration: 2, fadeIn: 2, fadeOut: 2 });
    assert.equal(P.fadeFactor(c, 1), 0.5);
  });
  test('音量：靜音片段、靜音軌道為 0', () => {
    let { project, clip } = P.addClip(setup(), 'audio', { mediaId: 'ma', volume: 1.5 });
    assert.equal(P.clipGainAt(project, P.getClip(project, clip.id), 5), 1.5);
    const muted = P.updateTrack(project, clip.trackId, { muted: true });
    assert.equal(P.clipGainAt(muted, P.getClip(muted, clip.id), 5), 0);
  });
  test('getDuration', () => {
    let p = setup();
    assert.equal(P.getDuration(p), 0);
    ({ project: p } = P.addClip(p, 'audio', { mediaId: 'ma', start: 7 }));
    assert.equal(P.getDuration(p), 17);
  });
});

describe('吸附', () => {
  test('snapTime 取最近的點', () => {
    assert.deepEqual(P.snapTime(4.9, [0, 5, 10], 0.2), { time: 5, snapped: true, point: 5 });
    assert.equal(P.snapTime(4.5, [0, 5, 10], 0.2).snapped, false);
  });
  test('snapClipStart：結尾吸附', () => {
    // 片段長 3，開頭在 6.9 → 結尾 9.9 吸到 10
    assert.equal(P.snapClipStart(6.9, 3, [0, 10], 0.2).start, 7);
  });
  test('snapClipStart：開頭結尾都能吸時取距離近的', () => {
    const r = P.snapClipStart(5.05, 3, [5, 8.2], 0.2);
    assert.equal(r.start, 5);
  });
  test('snapPoints 排除自己、包含播放頭', () => {
    let { project, clip } = P.addClip(setup(), 'image', { mediaId: 'mi', start: 2 });
    assert.deepEqual(P.snapPoints(project, { excludeIds: [clip.id], playhead: 3 }).sort(), [0, 3]);
  });
  test('findFreeStart 在中間的空隙放得下時放進去', () => {
    let p = setup(), tr;
    ({ project: p } = P.addClip(p, 'image', { mediaId: 'mi', start: 0, duration: 2 }));
    ({ project: p } = P.addClip(p, 'image', { mediaId: 'mi', start: 5, duration: 2 }));
    tr = v1(p).id;
    assert.equal(P.findFreeStart(p, tr, 1, 2), 2);
    assert.equal(P.findFreeStart(p, tr, 1, 4), 7); // 空隙太小 → 放最後
  });
});

describe('軌道', () => {
  test('新增影像軌放最上面、音訊軌放最下面', () => {
    let p = P.addTrack(P.createProject(), 'video');
    p = P.addTrack(p, 'audio');
    assert.deepEqual(p.tracks.map(t => t.name), ['V3', 'V2', 'V1', 'A1', 'A2']);
  });
  test('刪除軌道連同片段；最後一條同類軌道不能刪', () => {
    let { project } = P.addClip(setup(), 'audio', { mediaId: 'ma' });
    assert.equal(P.removeTrack(project, a1(project).id), project);
    let p = P.removeTrack(project, v2(project).id);
    assert.equal(p.tracks.length, 2);
  });
  test('removeMedia 連同片段刪除', () => {
    let { project } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    project = P.removeMedia(project, 'mv');
    assert.equal(project.clips.length, 0);
    assert.equal(project.media.mv, undefined);
  });
  test('setAspect', () => {
    const p = P.setAspect(P.createProject(), '9:16');
    assert.deepEqual([p.width, p.height, p.aspect], [1080, 1920, '9:16']);
    assert.equal(P.setAspect(p, 'bogus'), p);
  });
});

describe('normalizeProject', () => {
  test('來回存讀不變', () => {
    let { project } = P.addClip(setup(), 'video', { mediaId: 'mv' });
    ({ project } = P.addClip(project, 'text', {}));
    const back = P.normalizeProject(JSON.parse(JSON.stringify(project)));
    assert.deepEqual(back, project);
  });
  test('格式錯誤回傳 null', () => {
    for (const bad of [null, 1, 'x', {}, { tracks: 1, clips: [] }]) assert.equal(P.normalizeProject(bad), null);
  });
  test('移除壞掉的片段、補上缺少的軌道', () => {
    const p = setup();
    const raw = {
      ...p,
      tracks: [p.tracks[1]], // 只有 V1
      clips: [
        P.makeClip('video', { mediaId: 'mv', trackId: p.tracks[1].id }),
        P.makeClip('video', { mediaId: 'missing', trackId: p.tracks[1].id }),
        P.makeClip('audio', { mediaId: 'ma', trackId: p.tracks[1].id }), // 音訊在影像軌
        P.makeClip('text', { trackId: p.tracks[1].id, duration: -1 }),
        { id: 'x', type: 'bogus' },
        null,
      ],
    };
    const n = P.normalizeProject(raw);
    assert.equal(n.clips.length, 1);
    assert.ok(n.tracks.some(t => t.kind === 'audio'));
  });
});
