/* 引擎自对弈：看看 AI 实际下出来的棋像不像围棋 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/engine.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/ai.js'), 'utf8'));
const { engine: E, ai } = globalThis.GO9;
const { idx, Board, BLACK, WHITE } = E;

const COLS = 'ABCDEFGHJ';
function lineOf(x, y) { return Math.min(x, y, 8 - x, 8 - y) + 1; }   // 1=一线 … 4=四线
function zoneOf(x, y) {
  const l = lineOf(x, y);
  if (l <= 2) return '一二线';
  if (l === 3) return '三线';
  return '中腹';
}

const GAME = Number(process.argv[2] || 1);
const rng = ai.makeRng(20261021 + GAME * 7919);
const b = new Board();
b.hist = new Map(); b.trackSuperko = true; b.hist.set(b.hash(), true);

const level = ai.LEVELS[2];
const moves = [];
for (let i = 0; i < 40; i++) {
  const ana = E.analyzeBoard(b);
  const legal = E.candidateMoves(b, b.toPlay, ana);
  if (!legal.length) break;
  const stats = ai.evalMovesSync(b, 6.5, legal, 60, 220, (i * 7919 + 13 + GAME * 104729) >>> 0, 14);
  const mv = ai.chooseAiMove(stats, level, rng, legal);
  if (mv < 0) break;
  b.play(mv, b.toPlay);
  b.toPlay = 3 - b.toPlay;
  const x = E.xOf(mv), y = E.yOf(mv);
  moves.push({ n: i + 1, c: b.toPlay === BLACK ? 'B' : 'W', x, y, line: lineOf(x, y), zone: zoneOf(x, y) });
}

console.log('引擎自对弈（前 20 手）：');
for (const m of moves.slice(0, 20)) {
  console.log(`  ${String(m.n).padStart(2)}. ${m.c} ${COLS[m.x]}${9 - m.y}   [${m.zone} · 第${m.line}线]`);
}

// 统计前 12 手与全盘的线位分布
function summarize(list, label) {
  const cnt = {};
  for (const m of list) cnt[m.zone] = (cnt[m.zone] || 0) + 1;
  console.log(`  ${label}: ` + Object.entries(cnt).map(([k, v]) => `${k} ${v}`).join('  '));
}
console.log('\n线位分布：');
summarize(moves.slice(0, 12), '开局前 12 手');
summarize(moves, '全盘 40 手');
const early = moves.slice(0, 12).filter(m => m.line <= 2).length;
console.log(`\n开局前 12 手里有 ${early} 手下在一二线（围棋常识：应当很少甚至没有）`);
