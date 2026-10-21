/* 测量：修复后引擎到底选哪一手（线位分布）
 * 运行： node test/diag-engine-choice.mjs
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/engine.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/ai.js'), 'utf8'));

const { engine: E, ai } = globalThis.GO9;
const { idx, xOf, yOf, BLACK, WHITE, Board } = E;
const lineOf = p => Math.min(xOf(p), 8 - xOf(p), yOf(p), 8 - yOf(p));
const mk = (stones, toPlay) => {
  const b = new Board();
  for (const [x, y, c] of stones) { b.stones[idx(x, y)] = c; b.toggle(idx(x, y), c); }
  if (toPlay !== undefined) b.toPlay = toPlay;
  return b;
};

const COARSE = 60, FINE = 240, REFINE = 14;

function topN(board, n, seed) {
  const ana = E.analyzeBoard(board);
  const legal = E.candidateMoves(board, board.toPlay, ana);
  const st = ai.evalMovesSync(board, 6.5, legal, COARSE, FINE, seed, REFINE, board.toPlay === BLACK);
  const rows = [...st.entries()].sort((a, b) => b[1].margin - a[1].margin);
  const dist = {};
  for (const [mv] of rows.slice(0, n)) { const d = lineOf(mv); dist[d] = (dist[d] || 0) + 1; }
  return { dist, list: rows.slice(0, 8).map(([mv, v]) => `(${xOf(mv)},${yOf(mv)})线${lineOf(mv)}`), rows };
}

console.log('=== 引擎选点：前 10 手的线位分布 ===');
const cases = [
  ['空盘·黑先        ', mk([], BLACK)],
  ['空盘·白先        ', mk([], WHITE)],
  ['黑(4,4)白(8,8)黑先', mk([[4, 4, BLACK], [8, 8, WHITE]], BLACK)],
  ['黑(4,4)白(8,8)白先', mk([[4, 4, BLACK], [8, 8, WHITE]], WHITE)]
];
for (const [name, b] of cases) {
  const r = topN(b, 10, 31337);
  const edge = (r.dist[0] || 0) + (r.dist[1] || 0);
  console.log(`  ${name} 分布 ${JSON.stringify(r.dist)}  一二线 ${edge}/10   ${r.list.join(' ')}`);
}

/* 中盘 20 子 */
{
  const stones = [
    [6, 1, WHITE], [1, 2, WHITE], [2, 2, BLACK], [3, 2, BLACK], [4, 2, WHITE],
    [6, 2, BLACK], [3, 3, WHITE], [6, 3, WHITE], [7, 3, BLACK], [4, 4, BLACK],
    [5, 4, WHITE], [2, 5, BLACK], [6, 5, BLACK], [2, 6, WHITE], [6, 6, WHITE],
    [1, 7, BLACK], [3, 7, BLACK], [4, 7, WHITE], [7, 7, BLACK], [7, 8, WHITE]
  ];
  const b = mk(stones, BLACK);
  b.moveNum = 20;
  const r = topN(b, 10, 777);
  const edge = (r.dist[0] || 0) + (r.dist[1] || 0);
  console.log(`  中盘20子·黑先    分布 ${JSON.stringify(r.dist)}  一二线 ${edge}/10   ${r.list.join(' ')}`);
}

/* ---------- 自对弈 ---------- */
console.log('\n=== 自对弈 2 局 × 30 手（l5 选点）===');
{
  const dist = { 1: {}, 2: {} };
  const seq = { 1: [], 2: [] };
  for (let g = 0; g < 2; g++) {
    const rng = ai.makeRng(9000 + g * 31);
    const board = new Board();
    for (let m = 0; m < 30; m++) {
      const color = board.toPlay;
      const ana = E.analyzeBoard(board);
      const legal = E.candidateMoves(board, color, ana);
      if (!legal.length) break;
      const st = ai.evalMovesSync(board, 6.5, legal, COARSE, FINE, 2000 + g * 1000 + m * 23, REFINE, color === BLACK);
      const mv = ai.chooseAiMove(st, ai.LEVELS[4], rng, legal);
      if (mv < 0) break;
      const d = lineOf(mv);
      const who = color === BLACK ? 1 : 2;
      dist[who][d] = (dist[who][d] || 0) + 1;
      seq[who].push(`(${xOf(mv)},${yOf(mv)})`);
      board.play(mv, color);
      board.toPlay = 3 - color;
    }
  }
  for (const who of [1, 2]) {
    const d = dist[who];
    const total = Object.values(d).reduce((a, b) => a + b, 0);
    const edge = (d[0] || 0) + (d[1] || 0);
    console.log(`  ${who === 1 ? '黑' : '白'}: ${total} 手，一二线 ${edge} (${(edge / total * 100).toFixed(0)}%)  分布 ${JSON.stringify(d)}`);
    console.log(`      ${seq[who].join(' ')}`);
  }
}
