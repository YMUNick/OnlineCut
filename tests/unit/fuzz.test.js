// 隨機壓力測試：亂做幾千次編輯、亂餵壞掉的存檔，檢查專案永遠保持合法
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../assets/js/core/project.js';
import { applyLayout, layoutCandidates, LAYOUTS } from '../../assets/js/core/layouts.js';

/** 可重現的亂數（mulberry32） */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EPS = 1e-6;

function diffPaths(a, b, p = '') {
  if (Object.is(a, b)) return [];
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return [`${p || '(root)'}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => diffPaths(a[k], b[k], p ? `${p}.${k}` : k));
}

/** 合法專案一定要滿足的條件；回傳違反的項目 */
export function violations(p) {
  const out = [];
  const minDur = 1 / p.fps;
  const ids = new Set();
  for (const c of p.clips) {
    const tag = `${c.type}#${c.id}`;
    if (ids.has(c.id)) out.push(`${tag} id 重複`);
    ids.add(c.id);
    const tr = P.getTrack(p, c.trackId);
    if (!tr) out.push(`${tag} 軌道不存在`);
    else if (!P.canHost(tr, c.type)) out.push(`${tag} 放在 ${tr.kind} 軌`);
    if (!(c.start >= -EPS)) out.push(`${tag} start=${c.start}`);
    if (!(c.duration >= minDur - EPS)) out.push(`${tag} duration=${c.duration}`);
    if (!(c.srcIn >= -EPS)) out.push(`${tag} srcIn=${c.srcIn}`);
    if (!(c.speed >= P.MIN_SPEED && c.speed <= P.MAX_SPEED)) out.push(`${tag} speed=${c.speed}`);
    if (!(c.fadeIn >= 0 && c.fadeIn <= c.duration + EPS)) out.push(`${tag} fadeIn=${c.fadeIn}`);
    if (!(c.fadeOut >= 0 && c.fadeOut <= c.duration + EPS)) out.push(`${tag} fadeOut=${c.fadeOut}`);
    if (c.audioFades !== null) {
      const a = c.audioFades;
      if (c.type !== 'video') out.push(`${tag} 不能有獨立的聲音淡入淡出`);
      else if (!(a.in >= 0 && a.in <= c.duration + EPS && a.out >= 0 && a.out <= c.duration + EPS)) out.push(`${tag} audioFades=${JSON.stringify(a)}`);
    }
    if (c.transitionIn !== null) {
      const tr = c.transitionIn;
      if (!P.canTransition(c)) out.push(`${tag} 不能有轉場`);
      else if (!tr || !P.TRANSITION_TYPES.includes(tr.type) || !(tr.duration >= P.MIN_TRANSITION && tr.duration <= P.MAX_TRANSITION)) out.push(`${tag} 轉場不合法 ${JSON.stringify(tr)}`);
    }
    if (!(c.opacity >= 0 && c.opacity <= 1)) out.push(`${tag} opacity=${c.opacity}`);
    if (!(c.volume >= 0 && c.volume <= 2)) out.push(`${tag} volume=${c.volume}`);
    for (const v of [c.start, c.duration, c.srcIn, c.transform.x, c.transform.y, c.transform.scale, c.transform.rotation]) {
      if (!Number.isFinite(v)) out.push(`${tag} 有非數字的值`);
    }
    if (typeof c.transform.flipX !== 'boolean' || typeof c.transform.flipY !== 'boolean') out.push(`${tag} 翻轉不是 true / false`);
    else if ((c.transform.flipX || c.transform.flipY) && !P.canFlip(c)) out.push(`${tag} 不能翻轉`);
    if (c.frame !== null) {
      const f = c.frame;
      if (!P.canFrame(c)) out.push(`${tag} 不能有畫面框`);
      else if (!f || ![f.x, f.y, f.w, f.h, f.border].every(Number.isFinite) || !(f.w >= P.MIN_FRAME && f.h >= P.MIN_FRAME) || !P.FRAME_SHAPES.includes(f.shape)) out.push(`${tag} 畫面框不合法 ${JSON.stringify(f)}`);
    }
    if (c.type !== 'text') {
      const m = p.media[c.mediaId];
      if (!m) out.push(`${tag} 素材不存在`);
      else if (Number.isFinite(m.duration) && c.srcIn + c.duration * c.speed > m.duration + 1e-4) {
        out.push(`${tag} 超出素材長度 ${c.srcIn}+${c.duration}×${c.speed} > ${m.duration}`);
      }
    }
  }
  for (const t of p.tracks) {
    const list = P.clipsOnTrack(p, t.id);
    for (let i = 1; i < list.length; i++) {
      if (list[i].start < P.clipEnd(list[i - 1]) - 1e-4) out.push(`軌道 ${t.name} 片段重疊 ${list[i - 1].id} / ${list[i].id}`);
    }
  }
  if (!p.tracks.some(t => t.kind === 'video') || !p.tracks.some(t => t.kind === 'audio')) out.push('缺少影像軌或音訊軌');
  return out;
}

function baseProject() {
  let p = P.createProject();
  p = P.addMedia(p, { id: 'v1', type: 'video', name: 'a.mp4', duration: 7.3, width: 1280, height: 720 });
  p = P.addMedia(p, { id: 'v2', type: 'video', name: 'b.mp4', duration: 2.05, width: 720, height: 1280 });
  p = P.addMedia(p, { id: 'a1', type: 'audio', name: 'c.mp3', duration: 11.7 });
  p = P.addMedia(p, { id: 'i1', type: 'image', name: 'd.png', width: 800, height: 600, duration: null });
  return p;
}

function randomStep(p, r) {
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const clip = p.clips.length ? pick(p.clips) : null;
  const t = r() * 30 - 2;
  const op = Math.floor(r() * 17);
  switch (op) {
    case 0: case 1: {
      const m = pick(Object.values(p.media));
      return P.addClip(p, m.type, { mediaId: m.id, start: r() < 0.5 ? t : undefined, srcIn: r() < 0.3 ? r() * 3 : 0, trackId: r() < 0.3 ? pick(p.tracks).id : undefined }).project;
    }
    case 2: return P.addClip(p, 'text', { start: t, duration: r() * 6, trackId: pick(p.tracks).id }).project;
    case 3: return clip ? P.moveClip(p, clip.id, { start: t, trackId: r() < 0.5 ? pick(p.tracks).id : undefined }) : p;
    case 4: return clip ? P.trimClip(p, clip.id, r() < 0.5 ? 'start' : 'end', t) : p;
    case 5: return clip ? P.splitClip(p, clip.id, clip.start + r() * clip.duration * 1.2).project : p;
    case 6: return P.splitAtPlayhead(p, t, r() < 0.5 && clip ? [clip.id] : []).project;
    case 7: return clip ? P.deleteClips(p, [clip.id], { ripple: r() < 0.5 }) : p;
    case 8: return clip ? P.updateClip(p, clip.id, { speed: pick([0.25, 0.5, 1, 1.3, 2, 4, 9, -1, NaN]), fadeIn: r() * 5, fadeOut: r() * 5 }) : p;
    case 9: return clip ? P.duplicateClip(p, clip.id).project : p;
    case 11: {
      const id = pick([...LAYOUTS.map(l => l.id), 'none', 'bogus']);
      return applyLayout(p, layoutCandidates(p, clip ? [clip.id] : [], t, 4).map(c => c.id), id).project;
    }
    case 12: return clip ? P.updateClip(p, clip.id, { frame: pick([null, { x: r() * 3 - 1, w: r() * 3 - 0.5, shape: pick(['circle', 'x', 1]) }, { border: pick([NaN, -5, 1e9, 4]) }, 'junk']) }) : p;
    case 14: return clip ? P.updateClip(p, clip.id, { audioFades: pick([null, { in: r() * 12 }, { out: r() * 12 - 2 }, { in: NaN, out: 'x' }]) }) : p;
    case 15: return clip ? P.updateClip(p, clip.id, { transitionIn: pick([null, { type: pick(P.TRANSITION_TYPES) }, { duration: r() * 8 - 1 }, { type: 'bogus', duration: NaN }, 'junk']) }) : p;
    case 13: return clip ? P.placeClip(p, clip.id, { start: t, trackId: r() < 0.3 ? pick(p.tracks).id : undefined, closeGap: r() < 0.5 }) : p;
    case 10: return r() < 0.5 ? P.addTrack(p, pick(['video', 'audio'])) : P.removeTrack(p, pick(p.tracks).id);
    default: return P.updateTrack(p, pick(p.tracks).id, { locked: r() < 0.2, hidden: r() < 0.2, muted: r() < 0.2 });
  }
}

describe('隨機編輯', () => {
  for (const seed of [1, 2, 3, 42, 2026]) {
    test(`種子 ${seed}：2000 次隨機操作後專案一直合法`, () => {
      const r = rng(seed);
      let p = baseProject();
      for (let i = 0; i < 2000; i++) {
        const prev = p;
        p = randomStep(p, r);
        const v = violations(p);
        if (v.length) assert.fail(`第 ${i} 步之後：\n${v.slice(0, 5).join('\n')}\n上一步的片段：${JSON.stringify(prev.clips.map(c => [c.type, c.trackId, c.start, c.duration]))}`);
      }
    });
  }

  test('隨機操作後存檔再讀回來不變', () => {
    const r = rng(7);
    let p = baseProject();
    for (let i = 0; i < 300; i++) {
      p = randomStep(p, r);
      const back = P.normalizeProject(JSON.parse(JSON.stringify(p)));
      assert.deepEqual(diffPaths(back, p), [], `第 ${i} 步`);
    }
  });
});

describe('壞掉 / 惡意的存檔', () => {
  test('亂七八糟的資料不會讓程式出錯，結果一定合法，而且再處理一次不變', () => {
    const r = rng(99);
    const junk = () => [null, undefined, NaN, Infinity, -1, 0, 1e300, 'x', '', true, [], {}, { a: 1 }, '__proto__'][Math.floor(r() * 14)];
    const valid = baseProject();
    for (let i = 0; i < 3000; i++) {
      const raw = JSON.parse(JSON.stringify(valid));
      raw.clips = P.addClip(P.addClip(valid, 'video', { mediaId: 'v1', frame: { x: 0.1, y: 0.2, w: 0.3, h: 0.3, shape: 'circle', border: 6, shadow: true }, transitionIn: { type: 'wipe', duration: 1 } }).project, 'text', {}).project.clips;
      // 隨機把一些欄位換成垃圾
      for (let k = 0; k < 4; k++) {
        const target = [raw, raw.clips?.[0], raw.clips?.[1], raw.clips?.[0]?.transform, raw.clips?.[1]?.text, raw.tracks?.[0], raw.media?.v1, raw.clips?.[0]?.frame, raw.clips?.[0]?.transitionIn][Math.floor(r() * 9)];
        if (target && typeof target !== 'object') continue;
        if (!target) continue;
        const keys = Object.keys(target);
        target[keys[Math.floor(r() * keys.length)]] = junk();
      }
      let n;
      try { n = P.normalizeProject(raw); } catch (e) { assert.fail(`第 ${i} 次丟出錯誤：${e.stack.split('\n').slice(0, 3).join(' | ')}\n${JSON.stringify(raw).slice(0, 400)}`); }
      if (n === null) continue;
      assert.deepEqual(violations(n), [], `第 ${i} 次：${JSON.stringify(raw).slice(0, 300)}`);
      assert.deepEqual(diffPaths(P.normalizeProject(JSON.parse(JSON.stringify(n))), n), [], `第 ${i} 次：處理兩次結果要一樣`);
    }
  });

  test('解析度一律依畫面比例，不信任檔案裡的數字', () => {
    const raw = { ...P.createProject({ aspect: '9:16' }), width: 1e6, height: 3 };
    const n = P.normalizeProject(raw);
    assert.deepEqual([n.width, n.height], [1080, 1920]);
  });

  test('不合法的 fps、背景色、名稱', () => {
    const n = P.normalizeProject({ ...P.createProject(), fps: 1000, background: 'url(javascript:alert(1))', name: 'x'.repeat(10000) });
    assert.equal(n.fps, 30);
    assert.equal(n.background, '#000000');
    assert.equal(n.name.length, 120);
  });

  test('重疊的片段往後挪', () => {
    const p = baseProject();
    const tr = p.tracks.find(t => t.name === 'V1').id;
    const raw = { ...p, clips: [
      P.makeClip('image', { id: 'a', mediaId: 'i1', trackId: tr, start: 0, duration: 5 }),
      P.makeClip('image', { id: 'b', mediaId: 'i1', trackId: tr, start: 2, duration: 5 }),
      P.makeClip('image', { id: 'c', mediaId: 'i1', trackId: tr, start: 3, duration: 1 }),
    ] };
    raw.clips.forEach((c, i) => { c.id = 'abc'[i]; });
    const n = P.normalizeProject(raw);
    assert.deepEqual(n.clips.map(c => [c.id, c.start]), [['a', 0], ['b', 5], ['c', 10]]);
  });

  test('片段比素材還長時截短', () => {
    const p = baseProject();
    const tr = [...p.tracks].reverse().find(t => t.kind === 'video').id;
    const c = P.makeClip('video', { mediaId: 'v2', trackId: tr, srcIn: 1, duration: 100, speed: 2 });
    const n = P.normalizeProject({ ...p, clips: [c] });
    assert.ok(Math.abs(n.clips[0].duration - (2.05 - 1) / 2) < 1e-9);
    const c2 = P.makeClip('video', { mediaId: 'v2', trackId: tr, srcIn: 50, duration: 1 });
    const n2 = P.normalizeProject({ ...p, clips: [c2] });
    assert.deepEqual(violations(n2), []);
  });

  test('片段類型跟素材不符（影片片段指向音訊素材）會被移除', () => {
    const p = baseProject();
    const tr = [...p.tracks].reverse().find(t => t.kind === 'video').id;
    const n = P.normalizeProject({ ...p, clips: [P.makeClip('video', { mediaId: 'a1', trackId: tr })] });
    assert.equal(n.clips.length, 0);
  });

  test('重複的 id 只保留第一個', () => {
    const p = baseProject();
    const tr = p.tracks[0].id;
    const a = P.makeClip('text', { trackId: tr, start: 0, duration: 1 });
    const b = { ...P.makeClip('text', { trackId: tr, start: 5, duration: 1 }), id: a.id };
    const n = P.normalizeProject({ ...p, clips: [a, b], tracks: [...p.tracks, { ...p.tracks[0] }] });
    assert.equal(n.clips.length, 1);
    assert.equal(n.tracks.length, p.tracks.length);
  });

  test('__proto__ 之類的鍵不會污染物件', () => {
    const raw = JSON.parse(`{"tracks":[],"clips":[],"media":{"__proto__":{"id":"__proto__","type":"video","polluted":true}}}`);
    const n = P.normalizeProject(raw);
    assert.equal(Object.getPrototypeOf(n.media), Object.prototype);
    assert.equal(n.media.polluted, undefined);
    assert.equal(({}).polluted, undefined);
  });

  test('不認識的欄位會被丟掉', () => {
    const p = P.addClip(baseProject(), 'text', {}).project;
    const raw = JSON.parse(JSON.stringify(p));
    raw.evil = '<script>';
    raw.clips[0].onclick = 'alert(1)';
    raw.clips[0].text.html = '<img onerror=alert(1)>';
    raw.media.v1.extra = 1;
    const n = P.normalizeProject(raw);
    assert.equal(n.evil, undefined);
    assert.equal(n.clips[0].onclick, undefined);
    assert.equal(n.clips[0].text.html, undefined);
    assert.equal(n.media.v1.extra, undefined);
  });
});
