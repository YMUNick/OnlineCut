// 英文版的完整性：程式裡每一句中文都要用 _t() 包起來，而且英文字典裡都有翻譯
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EN from '../../assets/js/i18n-en.js';
import { _t } from '../../assets/js/i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CJK = /[　-〿一-鿿＀-￯]/;
// 不需要翻譯的檔案：字典本身、語言切換（「中文」按鈕）
const SKIP = new Set(['assets/js/i18n-en.js', 'assets/js/i18n.js']);

function jsFiles(dir) {
  return readdirSync(dir).flatMap(f => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return f === 'vendor' ? [] : jsFiles(p);
    return p.endsWith('.js') ? [p] : [];
  });
}

/**
 * 簡易的 JS 掃描：找出所有字串 / 模板字面值（略過註解與正規表示式）。
 * 回傳 [{ kind: 'str' | 'tpl', text, wrapped, line, interp }]
 */
export function scanLiterals(src) {
  const out = [];
  let i = 0, prev = '';
  const lineAt = (pos) => src.slice(0, pos).split('\n').length;
  const wrappedAt = (pos) => /_t\(\s*$/.test(src.slice(Math.max(0, pos - 6), pos));
  const skipString = (j, q) => { j++; while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; } return j; };
  // 模板字串：回傳結尾位置；${} 裡的內容遞迴掃描
  const scanTemplate = (j) => {
    const start = j; j++;
    const parts = [];
    let text = '', interp = false;
    while (j < src.length && src[j] !== '`') {
      if (src[j] === '\\') { text += src[j] + src[j + 1]; j += 2; continue; }
      if (src[j] === '$' && src[j + 1] === '{') {
        interp = true; j += 2;
        let depth = 1; const exprStart = j;
        while (j < src.length && depth) {
          const c = src[j];
          if (c === '{') depth++;
          else if (c === '}') { depth--; if (!depth) break; }
          else if (c === "'" || c === '"') j = skipString(j, c);
          else if (c === '`') j = scanTemplate(j);
          j++;
        }
        parts.push([exprStart, j]);
        text += '${}';
        j++;
        continue;
      }
      text += src[j]; j++;
    }
    out.push({ kind: 'tpl', text, interp, wrapped: wrappedAt(start), line: lineAt(start), pos: start, raw: src.slice(start, j + 1) });
    for (const [a, b] of parts) for (const lit of scanLiterals(src.slice(a, b))) out.push({ ...lit, line: lit.line + lineAt(a) - 1, pos: lit.pos + a });
    return j;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
    if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]/.test(prev || ';')) {
      // 正規表示式
      let j = i + 1, cls = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) break;
        j++;
      }
      i = j + 1; prev = 'x'; continue;
    }
    if (c === "'" || c === '"') {
      const j = skipString(i, c);
      out.push({ kind: 'str', text: src.slice(i + 1, j), wrapped: wrappedAt(i), line: lineAt(i), pos: i, raw: src.slice(i, j + 1) });
      i = j + 1; prev = 'x'; continue;
    }
    if (c === '`') { i = scanTemplate(i) + 1; prev = 'x'; continue; }
    if (!/\s/.test(c)) prev = /[\w$)\].]/.test(c) ? 'x' : c;
    i++;
  }
  return out;
}

/** 把 JS 字面值的內容轉成實際的字串（處理跳脫字元） */
const unescape = (lit) => Function(`"use strict"; return ${lit};`)();

const files = jsFiles(path.join(ROOT, 'assets/js')).filter(f => !SKIP.has(path.relative(ROOT, f)));

describe('英文版', () => {
  test('畫面上的中文都有用 _t() 包起來', () => {
    const missing = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const lines = src.split('\n');
      for (const lit of scanLiterals(src)) {
        if (!CJK.test(lit.text)) continue;
        // 刻意不翻譯的（例如語言的原文名稱、送給 AI 的提示）在同一行標註 i18n-ignore
        if (lines[lit.line - 1]?.includes('i18n-ignore')) continue;
        if (lit.kind === 'str' && lit.wrapped) continue;
        if (lit.kind === 'tpl' && !lit.interp && lit.wrapped) continue;
        missing.push(`${path.relative(ROOT, f)}:${lit.line}  ${lit.raw.slice(0, 80).replace(/\s+/g, ' ')}`);
      }
    }
    assert.deepEqual(missing, [], `沒有翻譯的文字：\n${missing.join('\n')}`);
  });

  test('每一句 _t() 都有英文翻譯，而且佔位符一致', () => {
    const problems = [];
    for (const f of files) {
      for (const lit of scanLiterals(readFileSync(f, 'utf8'))) {
        if (!lit.wrapped || (lit.kind === 'tpl' && lit.interp)) continue;
        const key = unescape(lit.raw);
        const en = EN[key];
        const where = `${path.relative(ROOT, f)}:${lit.line}`;
        if (en == null) { problems.push(`${where} 缺少翻譯：${JSON.stringify(key)}`); continue; }
        const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
        for (const [form, v] of typeof en === 'object' ? [['one', en.one], ['other', en.other]] : [['other', en]]) {
          // 單數可以不寫 {n}（例如 "1 clip"）
          const expected = form === 'one' ? vars(key.replace('{n}', '')) : vars(key);
          if (typeof v !== 'string') problems.push(`${where} 翻譯格式不對：${JSON.stringify(key)}`);
          else if (vars(v.replace('{n}', form === 'one' ? '' : '{n}')) !== expected) problems.push(`${where} 佔位符不一致：${JSON.stringify(key)} → ${JSON.stringify(v)}`);
          else if (CJK.test(v)) problems.push(`${where} 英文翻譯裡有中文：${JSON.stringify(v)}`);
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  test('字典裡沒有用不到的翻譯（避免改了中文忘了改英文）', () => {
    const used = new Set();
    for (const f of files) {
      for (const lit of scanLiterals(readFileSync(f, 'utf8'))) if (lit.wrapped && !(lit.kind === 'tpl' && lit.interp)) used.add(unescape(lit.raw));
    }
    // HTML 頁面裡的文字由 translateDom 翻譯，在端到端測試裡檢查
    const html = ['index.html', 'editor.html'].map(f => readFileSync(path.join(ROOT, f), 'utf8').replace(/\s+/g, ' ')).join(' ');
    const unused = Object.keys(EN).filter(k => !used.has(k) && !html.includes(k));
    assert.deepEqual(unused, [], `用不到的翻譯：\n${unused.join('\n')}`);
  });

  test('預設是中文；_t 會代入變數', () => {
    assert.equal(_t('已匯入 {n} 個素材', { n: 3 }), '已匯入 3 個素材');
    assert.equal(_t('不在字典裡的字'), '不在字典裡的字');
  });
});
