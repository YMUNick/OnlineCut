// 專案檔（.onlinecut）：一個 ZIP，裡面有
//   project.json          { format, version, app, exportedAt, includesMedia, project }
//   media/<素材 id>.<副檔名>  素材原始檔（可選）
// 也接受只有 project.json 內容的純 JSON 檔。

import { normalizeProject } from './project.js';
import { createZip, readZip, looksLikeZip, ZipError } from './zip.js';

export const FORMAT = 'onlinecut-project';
export const FILE_VERSION = 1;
export const EXTENSION = '.onlinecut';
const MANIFEST = 'project.json';

export class ProjectFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

/** 看檔名判斷是不是專案檔 */
export function isProjectFileName(name) {
  return /\.onlinecut$/i.test(name || '');
}

function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
  return m ? '.' + m[1].toLowerCase() : '';
}

export function mediaEntryName(info) {
  return `media/${String(info.id).replace(/[^a-zA-Z0-9_-]/g, '_')}${extOf(info.name)}`;
}

export function buildManifest(project, { includesMedia = true, now = new Date() } = {}) {
  return { format: FORMAT, version: FILE_VERSION, app: 'OnlineCut', exportedAt: now.toISOString(), includesMedia, project };
}

/** 解析並檢查 project.json 的內容 */
export function parseManifest(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProjectFileError('專案檔內容損毀（不是有效的 JSON）');
  }
  if (!data || typeof data !== 'object' || data.format !== FORMAT) {
    throw new ProjectFileError('這不是 OnlineCut 的專案檔');
  }
  if (typeof data.version !== 'number' || data.version > FILE_VERSION) {
    throw new ProjectFileError('這個專案檔是用較新版本的 OnlineCut 建立的，請重新整理頁面取得最新版本後再開啟');
  }
  const project = normalizeProject(data.project);
  if (!project) throw new ProjectFileError('專案檔內容損毀（找不到專案資料）');
  return { project, includesMedia: data.includesMedia !== false, exportedAt: data.exportedAt ?? null };
}

/**
 * 打包專案。getFile(mediaId) 回傳素材的 Blob（拿不到就回傳 null）。
 * 回傳 { blob, missing: [沒有打包進去的素材 id] }
 */
export async function packProject(project, getFile, { includeMedia = true, onProgress = () => {}, now = new Date() } = {}) {
  const entries = [];
  const missing = [];
  if (includeMedia) {
    for (const info of Object.values(project.media)) {
      const file = await getFile(info.id);
      if (file) entries.push({ name: mediaEntryName(info), blob: file });
      else missing.push(info.id);
    }
  }
  const manifest = buildManifest(project, { includesMedia: includeMedia, now });
  entries.unshift({ name: MANIFEST, blob: new Blob([JSON.stringify(manifest)], { type: 'application/json' }) });
  const blob = await createZip(entries, { onProgress, date: now });
  return { blob, missing };
}

/**
 * 讀取專案檔（ZIP 或純 JSON）。
 * 回傳 { project, files: Map<mediaId, File>, missing: [專案用到但檔案裡沒有的素材 id], includesMedia, corrupted: [內容損毀的素材 id] }
 */
export async function unpackProject(file, { verify = true, onProgress = () => {} } = {}) {
  if (!file || file.size === 0) throw new ProjectFileError('檔案是空的');
  if (!(await looksLikeZip(file))) {
    // 純 JSON（只有專案設定，沒有素材）
    const head = new Uint8Array(await file.slice(0, 1).arrayBuffer())[0];
    if (head !== 0x7b /* { */ && head !== 0xef /* BOM */) throw new ProjectFileError('這不是 OnlineCut 的專案檔');
    const text = (await file.text()).replace(/^﻿/, '');
    const { project, exportedAt } = parseManifest(text);
    return { project, files: new Map(), missing: Object.keys(project.media), includesMedia: false, corrupted: [], exportedAt };
  }

  let entries;
  try {
    entries = await readZip(file);
  } catch (e) {
    throw new ProjectFileError(e instanceof ZipError ? `無法讀取專案檔：${e.message}` : '無法讀取專案檔');
  }
  const manifestEntry = entries.get(MANIFEST);
  if (!manifestEntry) throw new ProjectFileError('這不是 OnlineCut 的專案檔（缺少 project.json）');
  if (verify && !(await manifestEntry.verify())) throw new ProjectFileError('專案檔已損毀（project.json 內容不完整）');
  const { project, includesMedia, exportedAt } = parseManifest(await (await manifestEntry.blob()).text());

  const files = new Map();
  const missing = [];
  const corrupted = [];
  const infos = Object.values(project.media);
  const total = infos.reduce((s, m) => s + (entries.get(mediaEntryName(m))?.size || 0), 0);
  let done = 0;
  for (const info of infos) {
    const entry = entries.get(mediaEntryName(info));
    if (!entry) { missing.push(info.id); continue; }
    if (verify && !(await entry.verify((n) => { done += n; onProgress(done, total); }))) {
      corrupted.push(info.id);
      continue;
    }
    const blob = await entry.blob(info.mime || '');
    files.set(info.id, new File([blob], info.name, { type: info.mime || blob.type || '', lastModified: info.addedAt || Date.now() }));
  }
  return { project, files, missing, includesMedia, corrupted, exportedAt };
}

/** 找出可以用這個檔案重新連結的遺失素材（檔名與大小都相同） */
export function findRelinkTarget(project, file, isMissing) {
  return Object.values(project.media).find(m => isMissing(m.id) && m.name === file.name && m.size === file.size) ?? null;
}
