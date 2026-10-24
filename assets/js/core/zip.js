import { _t } from '../i18n.js';
// 最小的 ZIP 讀寫（瀏覽器與 Node 都能用）
//
// 寫入：只用「不壓縮」(store)。影片本身已經壓縮過，再壓也省不了多少，而且可以直接用 Blob 串接，
//       不需要把整個檔案讀進記憶體。檔名以 UTF-8 儲存。
// 讀取：支援 store 與 deflate（用 DecompressionStream），所以使用者用一般壓縮軟體重新壓過也能開。
// 不支援 ZIP64（單一 ZIP 上限 4GB）、加密、分割壓縮檔。

export class ZipError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

const MAX32 = 0xffffffff;

// ---------- CRC-32 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** 累加計算 CRC-32；crc 傳入上一段的結果 */
export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** 以串流方式計算整個 Blob 的 CRC-32（不會整個讀進記憶體） */
export async function crc32Blob(blob, onBytes = () => {}) {
  let crc = 0;
  const reader = blob.stream().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    crc = crc32(value, crc);
    onBytes(value.length);
  }
  return crc;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// ---------- 寫入 ----------
/**
 * entries: [{ name, blob }]
 * onProgress(doneBytes, totalBytes)：計算 CRC 時回報
 * 回傳 Blob（application/zip）
 */
export async function createZip(entries, { onProgress = () => {}, date = new Date() } = {}) {
  const enc = new TextEncoder();
  const { time, date: dosDate } = dosDateTime(date);
  const total = entries.reduce((s, e) => s + e.blob.size, 0);
  if (entries.length > 0xffff) throw new ZipError(_t('檔案數量太多'), 'too-many');
  const names = new Set();
  let done = 0;
  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, blob } of entries) {
    if (names.has(name)) throw new ZipError(_t('重複的檔名：{name}', { name }), 'duplicate');
    names.add(name);
    const nameBytes = enc.encode(name);
    if (nameBytes.length > 0xffff) throw new ZipError(_t('檔名太長'), 'name');
    if (blob.size > MAX32 || offset > MAX32) throw new ZipError(_t('專案檔超過 4GB，請改成不包含素材檔'), 'too-large');
    const crc = await crc32Blob(blob, (n) => { done += n; onProgress(done, total); });

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 檔名
    local.setUint16(8, 0, true);      // store
    local.setUint16(10, time, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, blob.size, true);
    local.setUint32(22, blob.size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, nameBytes, blob);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, blob.size, true);
    cd.setUint32(24, blob.size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd.buffer, nameBytes);

    offset += 30 + nameBytes.length + blob.size;
  }

  const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
  if (offset > MAX32 || offset + cdSize > MAX32) throw new ZipError(_t('專案檔超過 4GB，請改成不包含素材檔'), 'too-large');
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// ---------- 讀取 ----------
async function bytesOf(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/** 檔案開頭是不是 ZIP（PK\x03\x04 或空的 ZIP 的 PK\x05\x06） */
export async function looksLikeZip(blob) {
  if (blob.size < 4) return false;
  const b = await bytesOf(blob, 0, 4);
  return b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6));
}

/**
 * 讀取 ZIP 目錄。回傳 Map<name, entry>，entry: { name, size, compressedSize, method, crc, blob(), verify() }
 * 檔案損毀或不是 ZIP 會丟出 ZipError
 */
export async function readZip(blob) {
  const size = blob.size;
  if (size < 22) throw new ZipError(_t('不是有效的 ZIP 檔'), 'not-zip');
  const tailStart = Math.max(0, size - 22 - 0xffff);
  const tail = await bytesOf(blob, tailStart, size);
  const tv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError(_t('不是有效的 ZIP 檔（找不到檔案目錄，可能下載不完整）'), 'not-zip');
  const count = tv.getUint16(eocd + 10, true);
  const cdSize = tv.getUint32(eocd + 12, true);
  const cdOffset = tv.getUint32(eocd + 16, true);
  if (cdOffset === MAX32 || count === 0xffff) throw new ZipError(_t('不支援 ZIP64 格式'), 'zip64');
  if (cdOffset + cdSize > tailStart + eocd) throw new ZipError(_t('ZIP 檔已損毀'), 'corrupt');

  const cd = await bytesOf(blob, cdOffset, cdOffset + cdSize);
  const v = new DataView(cd.buffer);
  const dec = new TextDecoder('utf-8');
  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || v.getUint32(p, true) !== 0x02014b50) throw new ZipError(_t('ZIP 檔已損毀'), 'corrupt');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const compressedSize = v.getUint32(p + 20, true);
    const uncompressed = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const localOffset = v.getUint32(p + 42, true);
    if (p + 46 + nameLen > cd.length) throw new ZipError(_t('ZIP 檔已損毀'), 'corrupt');
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // 資料夾
    if (flags & 1) throw new ZipError(_t('不支援加密的 ZIP 檔'), 'encrypted');
    if (method !== 0 && method !== 8) throw new ZipError(_t('不支援的壓縮方式（{method}）', { method }), 'method');
    entries.set(name, { name, method, crc, compressedSize, size: uncompressed, localOffset });
  }

  // 讀本機檔頭找到資料起點（本機檔頭的 extra 長度可能跟目錄裡不同）
  for (const e of entries.values()) {
    if (e.localOffset + 30 > size) throw new ZipError(_t('ZIP 檔已損毀（資料不完整）'), 'truncated');
    const h = new DataView((await bytesOf(blob, e.localOffset, e.localOffset + 30)).buffer);
    if (h.getUint32(0, true) !== 0x04034b50) throw new ZipError(_t('ZIP 檔已損毀'), 'corrupt');
    const start = e.localOffset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    if (start + e.compressedSize > size) throw new ZipError(_t('ZIP 檔已損毀（資料不完整）'), 'truncated');
    const raw = blob.slice(start, start + e.compressedSize);
    e.blob = async (type = '') => {
      if (e.method === 0) return type ? raw.slice(0, raw.size, type) : raw;
      if (typeof DecompressionStream === 'undefined') throw new ZipError(_t('這個瀏覽器無法解壓縮'), 'method');
      const out = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
      return type ? out.slice(0, out.size, type) : out;
    };
    /** 檢查內容有沒有損毀 */
    e.verify = async (onBytes) => {
      const b = await e.blob();
      if (b.size !== e.size) return false;
      return (await crc32Blob(b, onBytes)) === e.crc;
    };
    delete e.localOffset;
  }
  return entries;
}
