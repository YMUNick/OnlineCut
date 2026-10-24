import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, createZip, readZip, looksLikeZip, ZipError } from '../../assets/js/core/zip.js';
import {
  packProject, unpackProject, parseManifest, buildManifest, mediaEntryName, isProjectFileName,
  findRelinkTarget, ProjectFileError, FORMAT, FILE_VERSION,
} from '../../assets/js/core/project-file.js';
import * as P from '../../assets/js/core/project.js';

const text = (s) => new Blob([s]);
const bytes = (n, seed = 1) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (i * 31 + seed) & 255; return new Blob([a]); };
const sameBlob = async (a, b) => Buffer.from(await a.arrayBuffer()).equals(Buffer.from(await b.arrayBuffer()));

/** 用 DecompressionStream 的反向，做一個 deflate 壓縮的 ZIP（模擬一般壓縮軟體） */
async function deflateZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const raw = new Uint8Array(await data.arrayBuffer());
    const comp = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const n = enc.encode(name), crc = crc32(raw);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 8, true);
    h.setUint32(14, crc, true); h.setUint32(18, comp.length, true); h.setUint32(22, raw.length, true); h.setUint16(26, n.length, true);
    parts.push(h.buffer, n, comp);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 8, true);
    c.setUint32(16, crc, true); c.setUint32(20, comp.length, true); c.setUint32(24, raw.length, true); c.setUint16(28, n.length, true); c.setUint32(42, offset, true);
    central.push(c.buffer, n);
    offset += 30 + n.length + comp.length;
  }
  const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, e.buffer]);
}

describe('CRC-32', () => {
  test('標準測試值', () => {
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
    assert.equal(crc32(new Uint8Array(0)), 0);
  });
  test('可以分段累加', () => {
    const all = new TextEncoder().encode('hello world');
    assert.equal(crc32(all.subarray(5), crc32(all.subarray(0, 5))), crc32(all));
  });
});

describe('ZIP 讀寫', () => {
  test('來回：內容、中文檔名、空檔案', async () => {
    const files = [['a.txt', text('hello')], ['資料夾/影片 1.mp4', bytes(100000)], ['empty.bin', new Blob([])]];
    const zip = await createZip(files.map(([name, blob]) => ({ name, blob })));
    assert.equal(await looksLikeZip(zip), true);
    const entries = await readZip(zip);
    assert.deepEqual([...entries.keys()], files.map(f => f[0]));
    for (const [name, blob] of files) {
      const e = entries.get(name);
      assert.equal(e.size, blob.size);
      assert.ok(await sameBlob(await e.blob(), blob), name);
      assert.equal(await e.verify(), true, name);
    }
  });

  test('空的 ZIP', async () => {
    const zip = await createZip([]);
    assert.equal(zip.size, 22);
    assert.equal(await looksLikeZip(zip), true);
    assert.equal((await readZip(zip)).size, 0);
  });

  test('標準 ZIP 工具（Python zipfile）讀得出來', async () => {
    const zip = await createZip([{ name: '中文.txt', blob: text('你好') }, { name: 'b/c.bin', blob: bytes(5000) }]);
    const dir = mkdtempSync(path.join(tmpdir(), 'oc-zip-'));
    try {
      const f = path.join(dir, 'x.zip');
      writeFileSync(f, Buffer.from(await zip.arrayBuffer()));
      const out = execFileSync('python3', ['-c', `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print('|'.join(z.namelist())); print(z.read('中文.txt').decode())`, f]).toString().trim().split('\n');
      assert.deepEqual(out, ['中文.txt|b/c.bin', '你好']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('讀得懂一般壓縮軟體的 deflate 壓縮', async () => {
    const original = text('壓縮內容'.repeat(500));
    const zip = await deflateZip([['project.txt', original]]);
    const e = (await readZip(zip)).get('project.txt');
    assert.equal(e.method, 8);
    assert.ok(e.compressedSize < original.size);
    assert.ok(await sameBlob(await e.blob(), original));
    assert.equal(await e.verify(), true);
  });

  test('重複檔名不允許', async () => {
    await assert.rejects(createZip([{ name: 'a', blob: text('1') }, { name: 'a', blob: text('2') }]), { code: 'duplicate' });
  });

  test('不是 ZIP / 太短 / 空檔', async () => {
    for (const b of [new Blob([]), text('PK'), text('hello world, this is not a zip file at all!!')]) {
      await assert.rejects(readZip(b), ZipError);
    }
    assert.equal(await looksLikeZip(text('hello')), false);
  });

  test('下載不完整（截斷）會被發現', async () => {
    const zip = await createZip([{ name: 'a.bin', blob: bytes(50000) }, { name: 'b.bin', blob: bytes(50000, 7) }]);
    for (const cut of [zip.size - 1, zip.size - 30, Math.floor(zip.size / 2), 100]) {
      await assert.rejects(readZip(zip.slice(0, cut)), ZipError, `截到 ${cut}`);
    }
  });

  test('內容被改壞時 CRC 檢查會失敗', async () => {
    const zip = await createZip([{ name: 'a.bin', blob: bytes(1000) }]);
    const buf = new Uint8Array(await zip.arrayBuffer());
    buf[30 + 5 + 500] ^= 0xff; // 改掉資料中間的一個位元組
    const e = (await readZip(new Blob([buf]))).get('a.bin');
    assert.equal(await e.verify(), false);
  });

  test('加密的 ZIP 會被拒絕', async () => {
    const zip = await createZip([{ name: 'a', blob: text('x') }]);
    const buf = new Uint8Array(await zip.arrayBuffer());
    const cd = buf.length - 22 - (46 + 1);
    buf[cd + 8] |= 1; // 目錄裡的加密旗標
    await assert.rejects(readZip(new Blob([buf])), { code: 'encrypted' });
  });

  test('ZIP 後面接了註解 / 前面多了資料也能找到目錄', async () => {
    const zip = await createZip([{ name: 'a', blob: text('x') }]);
    const buf = new Uint8Array(await zip.arrayBuffer());
    const withComment = new Uint8Array(buf.length + 5);
    withComment.set(buf);
    new DataView(withComment.buffer).setUint16(buf.length - 2, 5, true); // 註解長度
    withComment.set(new TextEncoder().encode('hello'), buf.length);
    const e = (await readZip(new Blob([withComment]))).get('a');
    assert.equal(await (await e.blob()).text(), 'x');
  });
});

// ------------------------------------------------------------
function sampleProject() {
  let p = P.createProject({ name: '旅行 Vlog' });
  p = P.addMedia(p, { id: 'med_v', type: 'video', name: '海邊.mp4', mime: 'video/mp4', size: 3000, duration: 10, width: 1920, height: 1080 });
  p = P.addMedia(p, { id: 'med_a', type: 'audio', name: 'music.mp3', mime: 'audio/mpeg', size: 2000, duration: 30 });
  p = P.addClip(p, 'video', { mediaId: 'med_v' }).project;
  p = P.addClip(p, 'audio', { mediaId: 'med_a', duration: 10 }).project;
  p = P.addClip(p, 'text', { text: { content: '第一天' } }).project;
  return p;
}
const FILES = { med_v: bytes(3000, 3), med_a: bytes(2000, 9) };

describe('專案檔', () => {
  test('副檔名判斷', () => {
    assert.equal(isProjectFileName('我的影片.onlinecut'), true);
    assert.equal(isProjectFileName('A.ONLINECUT'), true);
    assert.equal(isProjectFileName('a.zip'), false);
    assert.equal(isProjectFileName(''), false);
  });

  test('素材在檔案裡的路徑安全、保留副檔名', () => {
    assert.equal(mediaEntryName({ id: 'med_abc', name: '影片.MP4' }), 'media/med_abc.mp4');
    assert.equal(mediaEntryName({ id: '../../x', name: 'noext' }), 'media/______x');
  });

  test('來回：專案與素材完全一樣', async () => {
    const p = sampleProject();
    const { blob, missing } = await packProject(p, async (id) => FILES[id]);
    assert.deepEqual(missing, []);
    const r = await unpackProject(new File([blob], 'x.onlinecut'));
    assert.deepEqual(r.project, p);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.corrupted, []);
    assert.equal(r.includesMedia, true);
    for (const id of Object.keys(FILES)) {
      const f = r.files.get(id);
      assert.ok(f instanceof File);
      assert.equal(f.name, p.media[id].name);
      assert.equal(f.type, p.media[id].mime);
      assert.ok(await sameBlob(f, FILES[id]));
    }
  });

  test('不含素材：檔案很小，開啟後全部標記為遺失', async () => {
    const p = sampleProject();
    const { blob } = await packProject(p, async (id) => FILES[id], { includeMedia: false });
    assert.ok(blob.size < 3000);
    const r = await unpackProject(new File([blob], 'x.onlinecut'));
    assert.equal(r.includesMedia, false);
    assert.deepEqual(r.missing.sort(), ['med_a', 'med_v']);
    assert.equal(r.files.size, 0);
  });

  test('打包時拿不到的素材會回報', async () => {
    const { missing } = await packProject(sampleProject(), async (id) => (id === 'med_a' ? null : FILES[id]));
    assert.deepEqual(missing, ['med_a']);
  });

  test('只有文字的專案（沒有素材）', async () => {
    let p = P.createProject();
    p = P.addClip(p, 'text', {}).project;
    const r = await unpackProject(new File([(await packProject(p, async () => null)).blob], 'x.onlinecut'));
    assert.equal(r.project.clips.length, 1);
    assert.deepEqual(r.missing, []);
  });

  test('純 JSON 的專案檔（含 BOM）也能開', async () => {
    const p = sampleProject();
    const json = '﻿' + JSON.stringify(buildManifest(p));
    const r = await unpackProject(new File([json], 'x.onlinecut'));
    assert.deepEqual(r.project, p);
    assert.equal(r.files.size, 0);
  });

  test('壓縮軟體重新壓過（deflate）的專案檔也能開', async () => {
    const p = sampleProject();
    const zip = await deflateZip([
      ['project.json', new Blob([JSON.stringify(buildManifest(p))])],
      [mediaEntryName(p.media.med_v), FILES.med_v],
      [mediaEntryName(p.media.med_a), FILES.med_a],
    ]);
    const r = await unpackProject(new File([zip], 'x.onlinecut'));
    assert.deepEqual(r.missing, []);
    assert.ok(await sameBlob(r.files.get('med_v'), FILES.med_v));
  });

  test('素材內容損毀：專案照樣開啟，損毀的素材另外列出', async () => {
    const p = sampleProject();
    const { blob } = await packProject(p, async (id) => FILES[id]);
    // 找到 med_v 的資料並改壞一個位元組
    const v = await (await readZip(blob)).get(mediaEntryName(p.media.med_v)).blob();
    const raw = Buffer.from(await blob.arrayBuffer());
    const needle = Buffer.from(await v.slice(0, 64).arrayBuffer());
    const at = raw.indexOf(needle);
    assert.ok(at > 0);
    raw[at + 100] ^= 0xff;
    const r = await unpackProject(new File([raw], 'x.onlinecut'));
    assert.deepEqual(r.corrupted, ['med_v']);
    assert.ok(r.files.has('med_a'));
    assert.ok(!r.files.has('med_v'));
  });

  test('各種壞掉的檔案都會丟出看得懂的錯誤', async () => {
    const p = sampleProject();
    const good = (await packProject(p, async (id) => FILES[id])).blob;
    const cases = {
      空檔案: new Blob([]),
      圖片: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])]),
      一般文字: text('hello'),
      壞掉的JSON: text('{ "format": '),
      別的JSON: text('{"hello": 1}'),
      未來版本: text(JSON.stringify({ ...buildManifest(p), version: FILE_VERSION + 1 })),
      缺少專案資料: text(JSON.stringify({ format: FORMAT, version: 1 })),
      專案資料格式錯: text(JSON.stringify({ format: FORMAT, version: 1, project: { tracks: 'x' } })),
      不是專案的ZIP: await createZip([{ name: 'readme.txt', blob: text('hi') }]),
      截斷的專案檔: good.slice(0, good.size - 40),
    };
    for (const [label, blob] of Object.entries(cases)) {
      await assert.rejects(unpackProject(new File([blob], 'x.onlinecut')), (e) => {
        assert.ok(e instanceof ProjectFileError, `${label}：${e}`);
        assert.ok(/[一-鿿]/.test(e.message), `${label} 的錯誤訊息要是中文：${e.message}`);
        return true;
      }, label);
    }
  });

  test('未來版本的錯誤訊息提示更新', () => {
    assert.throws(() => parseManifest(JSON.stringify({ format: FORMAT, version: 99, project: sampleProject() })), /較新版本/);
  });

  test('project.json 被改壞會被發現', async () => {
    const p = sampleProject();
    const { blob } = await packProject(p, async () => null, { includeMedia: false });
    const raw = Buffer.from(await blob.arrayBuffer());
    const at = raw.indexOf(Buffer.from('旅行'));
    raw[at] ^= 0x01;
    await assert.rejects(unpackProject(new File([raw], 'x.onlinecut')), /損毀/);
  });

  test('專案裡壞掉的片段會被清掉，不會讓整個專案打不開', async () => {
    const p = sampleProject();
    const broken = { ...p, clips: [...p.clips, { id: 'x', type: 'video', mediaId: 'nope', trackId: p.tracks[1].id, start: 0, duration: 1 }, null] };
    const r = await unpackProject(new File([JSON.stringify(buildManifest(broken))], 'x.onlinecut'));
    assert.equal(r.project.clips.length, p.clips.length);
  });

  test('重新連結：檔名與大小都相同才算', () => {
    const p = sampleProject();
    const missing = () => true;
    assert.equal(findRelinkTarget(p, { name: '海邊.mp4', size: 3000 }, missing)?.id, 'med_v');
    assert.equal(findRelinkTarget(p, { name: '海邊.mp4', size: 3001 }, missing), null);
    assert.equal(findRelinkTarget(p, { name: '其他.mp4', size: 3000 }, missing), null);
    assert.equal(findRelinkTarget(p, { name: '海邊.mp4', size: 3000 }, () => false), null, '沒有遺失就不用重新連結');
  });
});
