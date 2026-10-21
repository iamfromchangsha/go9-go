/* 只统计「悔棋 bug 污染之前」的那一段：AI 的真实棋力表现 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/engine.js'), 'utf8'));
const { engine: E } = globalThis.GO9;
const { idx, Board, BLACK, WHITE } = E;

const SGF = `(;GM[1]FF[4]SZ[9]KM[6.5]PB[人类]PW[AI][G6][C2][C6][C3][G2][G5][F5][D2][G4][E3][E4][D3][C5][F4][F3][G3][H3][E2][F2][D4][D5][D6][E6][F6][F7][undefined0][H1][B7][B6][A8][D7][B8][A6][H5][H6][undefined8][H4][undefined7][undefined5][A5][C7][A7][C8][H2][undefined2][undefined6][H7][H8][G8][B7][A7][A8][B8][B5][B4][A4][B3][A3][A2][C4][B2][undefined1][H0][G0][E1][F0][D1][G1][C1][F1][E0][E2][E3][C2][D2][C4][C3][D4][D3][D0][C0][undefined1][undefined0][undefined4][undefined3][C4][D4][G5][H5][A0][B0][B1][A1][F8][E8][G1][G0][F0][F1][A5][A4][undefined8][B5][H8][undefined7][H8][undefined8][])`;
const COLS = 'ABCDEFGHJ';
const lineOf = (x, y) => Math.min(x, y, 8 - x, 8 - y);

const headEnd = SGF.indexOf('PW[AI]') + 6;
const body = SGF.slice(headEnd);
const toks = [...body.matchAll(/\[([^\]]*)\]/g)].map(m => m[1]);

const b = new Board();
const aiLines = {}, huLines = {};
let aiN = 0, huN = 0, broken = false, brokenAt = 0;
let lastHuman = null, localResp = 0, aiAfterHuman = 0;
const boardBefore = new Map();
const aiSeq = [];

toks.forEach((t, i) => {
  if (broken) return;
  const color = i % 2 === 0 ? BLACK : WHITE;
  let x, y;
  if (/undefined/.test(t)) { x = 8; y = Number(t.replace(/\D/g, '')) || 0; }
  else { x = COLS.indexOf(t[0]); y = 9 - Number(t[1]); }
  const p = idx(x, y);
  if (b.stones[p] !== 0 || !b.play(p, color)) { broken = true; brokenAt = i + 1; return; }
  b.toPlay = 3 - color;
  const line = lineOf(x, y) + 1;
  if (color === WHITE) {
    aiN++; aiLines[line] = (aiLines[line] || 0) + 1;
    aiSeq.push((i + 1) + ':' + COLS[x] + (9 - y) + '/L' + line);
    aiAfterHuman++;
    if (lastHuman !== null) {
      const d = Math.max(Math.abs(x - (lastHuman % 11)), Math.abs(y - ((lastHuman / 11) | 0)));
      if (d <= 2) localResp++;
    }
  } else {
    huN++; huLines[line] = (huLines[line] || 0) + 1;
    lastHuman = p;
  }
});

console.log('AI 逐手（手序 / 着点 / 线位）：');
console.log('  ' + aiSeq.join('  '));
const fmt = o => Object.entries(o).sort((a, c) => a[0] - c[0])
  .map(([k, v]) => `第${k}线 ${v}`).join('  ');
console.log(`有效着法到第 ${brokenAt - 1} 手（第 ${brokenAt} 手起是被悔棋 bug 污染的非法着法）`);
console.log('AI 逐手：' + aiSeq.join('  '));
console.log(`AI  共 ${aiN} 手：${fmt(aiLines)}`);
console.log(`人类共 ${huN} 手：${fmt(huLines)}`);
const low = (aiLines[1] || 0) + (aiLines[2] || 0);
console.log(`\nAI 下一二线的比例：${low}/${aiN} = ${(low / aiN * 100).toFixed(0)}%`);
console.log(`AI 距人类上一手 ≤2 格（局部应对）的比例：${localResp}/${aiAfterHuman} = ${(localResp / aiAfterHuman * 100).toFixed(0)}%`);
