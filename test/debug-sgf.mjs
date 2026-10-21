/* 解析用户给的 SGF，检查：
 * 1) 有没有下在已有棋子上的非法着法（重复点）
 * 2) AI 各手的线位分布
 * 3) AI 有没有做局部应对
 * 4) 坐标导出是否正确（有没有 undefined）
 */
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

// 头部属性在 PW 之后结束，只取其后的着法
const headEnd = SGF.indexOf('PW[AI]') + 'PW[AI]'.length;
const body = SGF.slice(headEnd);
const moves = [...body.matchAll(/\[([^\]]*)\]/g)].map(m => m[1]);

const COLS = 'ABCDEFGHJ';
const lineOf = (x, y) => Math.min(x, y, 8 - x, 8 - y) + 1;

const b = new Board();
let bad = [];
const aiLines = {}, huLines = {};
let aiMoves = 0, huMoves = 0;
let lastAi = -1, broken = false;

console.log('手序  颜色  着点     线位    说明');
moves.forEach((t, i) => {
  const color = i % 2 === 0 ? BLACK : WHITE;   // PB=人类(黑) 先手
  const who = color === BLACK ? '人' : 'AI';
  if (/undefined/.test(t)) {
    const x = 8, y = Number(t.replace(/\D/g, '')) || 0;   // undefinedN = J 列
    bad.push({ i: i + 1, t, why: '坐标导出错误(undefined)' });
    console.log(`${String(i + 1).padStart(3)}  ${who}   ${t.padEnd(8)}  ?     ← 坐标导出错误，实际应为 ${COLS[x]}${9 - y}`);
    return;
  }
  const x = COLS.indexOf(t[0]);
  const y = 9 - Number(t[1]);
  const p = idx(x, y);
  const line = lineOf(x, y);
  let note = '';
  if (b.stones[p] !== 0) { note = '★ 下在已有棋子上（非法）'; bad.push({ i: i + 1, t, why: '重复落点' }); broken = true; }
  else if (!b.play(p, color)) { note = '★ 非法着法'; bad.push({ i: i + 1, t, why: '非法' }); broken = true; }
  else b.toPlay = 3 - color;
  if (color === WHITE) { aiLines[line] = (aiLines[line] || 0) + 1; aiMoves++; lastAi = p; }
  else { huLines[line] = (huLines[line] || 0) + 1; huMoves++; }
  console.log(`${String(i + 1).padStart(3)}  ${who}   ${t.padEnd(8)}  第${line}线  ${note}`);
});

console.log('\n非法着法 / 导出错误：', bad.length ? JSON.stringify(bad) : '无');
console.log('AI 着法线位分布:', JSON.stringify(aiLines), `（共 ${aiMoves} 手）`);
console.log('人类着法线位分布:', JSON.stringify(huLines), `（共 ${huMoves} 手）`);
