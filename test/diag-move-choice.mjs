/* 诊断：引擎选点为什么总是「往边上走」
 * 运行： node test/diag-move-choice.mjs
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
const { idx, xOf, yOf, BLACK, WHITE, EMPTY, Board } = E;

const COARSE = 80, FINE = 320, REFINE = 16;

function mkBoard(stones, toPlay = BLACK) {
  const b = new Board();
  b.toPlay = toPlay;
  for (const [x, y, c] of stones) { b.stones[idx(x, y)] = c; b.toggle(idx(x, y), c); }
  return b;
}
const lineOf = p => Math.min(xOf(p), 8 - xOf(p), yOf(p), 8 - yOf(p));
const xy = p => `(${xOf(p)},${yOf(p)})`;

function dump(title, board, moverIsBlack) {
  const ana = E.analyzeBoard(board);
  const legal = E.candidateMoves(board, board.toPlay, ana);
  const stats = ai.evalMovesSync(board, 6.5, legal, COARSE, FINE, 12345, REFINE, moverIsBlack);
  const rows = [...stats.entries()].sort((a, b) => b[1].margin - a[1].margin);
  console.log('\n### ' + title + '  (行棋方: ' + (moverIsBlack ? '黑' : '白') + ', 合法点 ' + legal.length + ')');
  console.log('  坐标    线  静态项   模拟项  0.35×模拟   先验   混合margin  黑方WR');
  rows.slice(0, 12).forEach(([mv, s]) => {
    console.log(
      `  ${xy(mv).padEnd(8)} ${lineOf(mv)}  ${s.stat.toFixed(1).padStart(7)} ${s.mcMargin.toFixed(1).padStart(8)}` +
      ` ${(s.mcMargin * 0.35).toFixed(2).padStart(9)} ${s.prior.toFixed(2).padStart(7)} ${s.margin.toFixed(2).padStart(10)}` +
      `  ${(s.wr * 100).toFixed(1).padStart(6)}%`);
  });
  const byLine = {};
  for (const [mv, s] of rows) { const d = lineOf(mv); (byLine[d] = byLine[d] || []).push(s.margin); }
  console.log('  各线位平均混合值 →', Object.keys(byLine).sort((a, b) => a - b)
    .map(d => `线${d}:${(byLine[d].reduce((a, b) => a + b, 0) / byLine[d].length).toFixed(1)}`).join(' '));
  // 排名到底由谁决定：静态项的极差 vs 模拟项的极差
  const st = rows.map(r => r[1].stat), mc = rows.map(r => r[1].mcMargin * 0.35);
  const rngOf = a => (Math.max(...a) - Math.min(...a)).toFixed(2);
  console.log(`  极差: 静态项 ${rngOf(st)}  0.35×模拟项 ${rngOf(mc)}  先验 ${rngOf(rows.map(r => r[1].prior))}`);
  return rows;
}

/* ---------- 1. 空盘黑先 ---------- */
dump('场景A：空盘，黑先', mkBoard([], BLACK), true);

/* ---------- 2. 黑下天元，白先 ---------- */
dump('场景B：黑(4,4)，白先', mkBoard([[4, 4, BLACK]], WHITE), false);

/* ---------- 3. 黑(4,4) 白(8,8)，黑先 ---------- */
dump('场景C：黑(4,4) 白(8,8)，黑先', mkBoard([[4, 4, BLACK], [8, 8, WHITE]], BLACK), true);

/* ---------- 4. 静态项在场景B到底算了什么 ---------- */
console.log('\n### 场景B 静态项细看（黑(4,4)，白落子后静态分变化）');
{
  const board = mkBoard([[4, 4, BLACK]], WHITE);
  const base = ai.staticScore(board);
  console.log('  落子前 staticScore =', base);
  const ana = E.analyzeBoard(board);
  const legal = E.candidateMoves(board, WHITE, ana);
  const sample = legal.filter(p => lineOf(p) >= 1).slice(0, 6);
  for (const mv of [...sample, idx(4, 4), idx(0, 0)]) {
    const c = board.clone();
    c.play(mv, WHITE); c.toPlay = BLACK;
    const s = ai.staticScore(c);
    console.log(`  白下 ${xy(mv).padEnd(8)} → static ${s}  (增量 ${s - base})`);
  }
}

/* ---------- 5. 自对弈线位分布 ---------- */
console.log('\n### 引擎自对弈（l4 难度）40 手，按颜色统计线位');
{
  const level = ai.LEVELS.find(l => l.key === 'l4') || ai.LEVELS[ai.LEVELS.length - 1];
  const rng = ai.makeRng(777);
  const board = new Board();
  const dist = { 1: {}, 2: {} };
  const seq = { 1: [], 2: [] };
  for (let m = 0; m < 40; m++) {
    const color = board.toPlay;
    const moverIsBlack = color === BLACK;
    const ana = E.analyzeBoard(board);
    const legal = E.candidateMoves(board, color, ana);
    if (!legal.length) break;
    const stats = ai.evalMovesSync(board, 6.5, legal, COARSE, FINE, 1000 + m * 37, REFINE, moverIsBlack);
    const mv = ai.chooseAiMove(stats, level, rng, legal);
    if (mv < 0) break;
    const d = lineOf(mv);
    const who = moverIsBlack ? 1 : 2;
    dist[who][d] = (dist[who][d] || 0) + 1;
    seq[who].push(`${xy(mv)}(线${d})`);
    board.play(mv, color);
    board.toPlay = 3 - color;
  }
  for (const who of [1, 2]) {
    const d = dist[who];
    const total = Object.values(d).reduce((a, b) => a + b, 0);
    const edge = (d[0] || 0) + (d[1] || 0);
    console.log(`  ${who === 1 ? '黑' : '白'}: 共 ${total} 手，一二线 ${edge} 手 (${(edge / total * 100).toFixed(0)}%)  分布 ${JSON.stringify(d)}`);
    console.log(`      ${seq[who].join(' ')}`);
  }
}
