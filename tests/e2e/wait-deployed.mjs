#!/usr/bin/env node
// 等到已部署的網站完全換成目前這個 commit 的檔案（GitHub Pages 的 CDN 快取可能要幾分鐘才更新）
//
// 用法：BASE_URL=https://ymunick.github.io/OnlineCut node tests/e2e/wait-deployed.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const BASE = (process.env.BASE_URL || '').replace(/\/+$/, '');
if (!BASE) { console.error('需要 BASE_URL'); process.exit(2); }
const TIMEOUT_MS = +(process.env.WAIT_TIMEOUT_MS || 20 * 60 * 1000);

// 網站會用到的檔案（不含測試與設定）
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n')
  .filter(f => f && /^(index\.html|editor\.html|assets\/)/.test(f));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const expected = new Map(files.map(f => [f, sha(readFileSync(f))]));

const started = Date.now();
for (let round = 1; ; round++) {
  const stale = [];
  await Promise.all(files.map(async (f) => {
    try {
      const res = await fetch(`${BASE}/${f}`, { cache: 'no-store' });
      if (!res.ok) { stale.push(`${f}（HTTP ${res.status}）`); return; }
      if (sha(Buffer.from(await res.arrayBuffer())) !== expected.get(f)) stale.push(f);
    } catch (e) {
      stale.push(`${f}（${e.message}）`);
    }
  }));
  const secs = Math.round((Date.now() - started) / 1000);
  if (!stale.length) {
    console.log(`✅ ${files.length} 個檔案都已經是最新版本（等了 ${secs} 秒）`);
    process.exit(0);
  }
  console.log(`第 ${round} 次檢查（${secs} 秒）：還有 ${stale.length} 個檔案是舊的，例如 ${stale.slice(0, 3).join('、')}`);
  if (Date.now() - started > TIMEOUT_MS) {
    console.error('❌ 等太久了，網站還沒更新');
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 20000));
}
