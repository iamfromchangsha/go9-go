/* A/B 对照实验：静态势力项「按棋子数渐入」开关前后，引擎选点有什么变化
 * 运行： node test/exp-static-ramp.mjs
 *
 * 1) 用「旧行为」下一盘参考棋，截取第 2/8/20/40 手局面
 * 2) 同一批局面分别用 ramp=OFF / ramp=ON 评估，看前 5 手与线位分布
 * 3) 各跑 2 局自对弈，统计双方线位分布
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

const COARSE = 60, FINE = 240, REFINE = 14;
const lineOf = p => Math.min(xOf(p), 8 - xOf(p), yOf(p), 8 - yOf(p));
const xy = p => `(${xOf(p)},${yOf(p)})`;

function evalAll(board, seed) {
  const ana = E.analyzeBoard(board);
  const legal = E.candidateMoves(board, board.toPlay, ana);
  return ai.evalMovesSync(board, 6.5, legal, COARSE, FINE, seed, REFINE, board.toPlay === BLACK);
}

/* ---------- 1) 参考棋（旧行为） ---------- */
const snaps = [];
{
  ai.setStaticRamp(false);
  const rng = ai.makeRng(4242);
  const board = new Board();
  const level = ai.LEVELS.find(l => l.key === 'l4');
  for (let m = 1; m <= 40; m++) {
    const color = board.toPlay;
    const stats = evalAll(board, 5000 + m * 17);
    const ana = E.analyzeBoard(board);
    const legal = E.candidateMoves(board, color, ana);
    const mv = ai.chooseAiMove(stats, level, rng, legal);
    if (mv < 0) break;
    board.play(mv, color);
    board.toPlay = 3 - color;
    if (m === 2 || m === 8 || m === 20 || m === 40) snaps.push({ n: m, b: board.clone() });
  }
  ai.setStaticRamp(true);
}

/* ---------- 2) 逐局面 A/B ---------- */
console.log('=== 同一局面，ramp OFF（旧） vs ramp ON（新）的前 5 手 ===');
for (const s of snaps) {
  const stones = [];
  for (let p = 0; p < 121; p++) {
    const c = s.b.stones[p];
    if (c === BLACK || c === WHITE) stones.push(`${xy(p)}${c === BLACK ? '黑' : '白'}`);
  }
  console.log(`\n--- 第 ${s.n} 手局面（行棋方 ${s.b.toPlay === BLACK ? '黑' : '白'}，${stones.length} 子）---`);
  console.log('    盘面:', stones.join(' '));
  for (const ramp of [false, true]) {
    ai.setStaticRamp(ramp);
    const stats = evalAll(s.b, 777);
    const rows = [...stats.entries()].sort((a, b) => b[1].margin - a[1].margin);
    const top = rows.slice(0, 5).map(([mv, v]) =>
      `${xy(mv)}(线${lineOf(mv)})${v.margin.toFixed(1)}`).join('  ');
    const lines = rows.slice(0, 5).map(([mv]) => lineOf(mv));
    const edge = lines.filter(d => d <= 1).length;
    const sw = rows[0][1].sw;
    console.log(`  ramp=${ramp ? 'ON ' : 'OFF'} 静态权重=${sw.toFixed(2)}  前5: ${top}   前5中一二线 ${edge}/5`);
  }
  ai.setStaticRamp(true);
}

/* ---------- 3) 自对弈线位分布 ---------- */
console.log('\n=== 自对弈（2 局 × 30 手）线位分布 ===');
for (const ramp of [false, true]) {
  ai.setStaticRamp(ramp);
  const dist = { 1: {}, 2: {} };
  let games = 0;
  for (let g = 0; g < 2; g++) {
    const rng = ai.makeRng(9000 + g * 31);
    const board = new Board();
    const level = ai.LEVELS.find(l => l.key === 'l4');
    for (let m = 0; m < 30; m++) {
      const color = board.toPlay;
      const stats = evalAll(board, 2000 + g * 1000 + m * 23);
      const ana = E.analyzeBoard(board);
      const legal = E.candidateMoves(board, color, ana);
      const mv = ai.chooseAiMove(stats, level, rng, legal);
      if (mv < 0) break;
      const d = lineOf(mv);
      const who = color === BLACK ? 1 : 2;
      dist[who][d] = (dist[who][d] || 0) + 1;
      board.play(mv, color);
      board.toPlay = 3 - color;
    }
    games++;
  }
  const line = [];
  for (const who of [1, 2]) {
    const d = dist[who];
    const total = Object.values(d).reduce((a, b) => a + b, 0);
    const edge = (d[0] || 0) + (d[1] || 0);
    line.push(`${who === 1 ? '黑' : '白'} ${total}手 一二线 ${edge} (${(edge / total * 100).toFixed(0)}%) 分布 ${JSON.stringify(d)}`);
  }
  console.log(`  ramp=${ramp ? 'ON ' : 'OFF'}  ${line.join('   |   ')}`);
}
ai.setStaticRamp(true);
