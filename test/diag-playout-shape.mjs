/* 诊断：3×3 局部形状策略有没有让「模拟出来的棋」更像真棋
 * 运行： node test/diag-playout-shape.mjs [每种模拟次数]
 *
 * 直接看模拟终局的棋子线位分布：
 *   真实棋局大致是 线0 10% / 线1 20% / 线2 30% / 线3 25% / 线4 15%
 * 形状策略若有效，模拟终局应该更接近这个分布。
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

const N = parseInt(process.argv[2] || '150', 10);
const lineOf = p => Math.min(xOf(p), 8 - xOf(p), yOf(p), 8 - yOf(p));

/* 三种起始局面：空盘 / 开局几手 / 中盘 */
function mkStart(kind) {
  const b = new Board();
  b.toPlay = BLACK;
  if (kind === 'opening') {
    for (const [x, y, c] of [[2, 2, BLACK], [6, 6, WHITE], [6, 2, BLACK], [2, 6, WHITE]]) {
      b.stones[idx(x, y)] = c; b.toggle(idx(x, y), c);
    }
  } else if (kind === 'mid') {
    const bl = [[1, 1], [1, 2], [2, 1], [6, 6], [6, 7], [7, 6], [5, 5], [4, 4], [2, 5]];
    const wh = [[7, 1], [7, 2], [6, 1], [1, 7], [2, 7], [1, 6], [4, 5], [5, 4], [6, 3]];
    for (const [x, y] of bl) { b.stones[idx(x, y)] = BLACK; b.toggle(idx(x, y), BLACK); }
    for (const [x, y] of wh) { b.stones[idx(x, y)] = WHITE; b.toggle(idx(x, y), WHITE); }
  }
  return b;
}

function measure(pattern, kind) {
  ai.SIM_OPTS.pattern = pattern;
  const hist = {};
  let total = 0, moves = 0;
  const rng = ai.makeRng(4242);
  const start = mkStart(kind);
  for (let i = 0; i < N; i++) {
    const c = start.clone();
    // 记录模拟过程中下了多少手（步数多说明棋局更开阔、没被早早填满）
    const before = c.moveNum;
    ai.simulate(c, rng, ai.SIM_OPTS);
    moves += c.moveNum - before;
    for (let p = 0; p < 121; p++) {
      const s = c.stones[p];
      if (s !== BLACK && s !== WHITE) continue;
      const d = lineOf(p);
      hist[d] = (hist[d] || 0) + 1;
      total++;
    }
  }
  const pct = d => (((hist[d] || 0) / total) * 100).toFixed(1);
  return { dist: [0, 1, 2, 3, 4].map(pct), total, moves: (moves / N).toFixed(0) };
}

console.log(`模拟 ${N} 次/种，比较「3×3 形状策略 关 vs 开」的模拟终局棋子分布`);
console.log('参考：真实棋局大致 线0 10% / 线1 20% / 线2 30% / 线3 25% / 线4 15%\n');
for (const kind of ['empty', 'opening', 'mid']) {
  const off = measure(false, kind);
  const on = measure(true, kind);
  console.log(`--- ${kind} ---`);
  console.log(`  关：线0 ${off.dist[0]}%  线1 ${off.dist[1]}%  线2 ${off.dist[2]}%  线3 ${off.dist[3]}%  线4 ${off.dist[4]}%   平均 ${off.moves} 手`);
  console.log(`  开：线0 ${on.dist[0]}%  线1 ${on.dist[1]}%  线2 ${on.dist[2]}%  线3 ${on.dist[3]}%  线4 ${on.dist[4]}%   平均 ${on.moves} 手`);
  const d = [];
  for (let i = 0; i < 5; i++) d.push((parseFloat(on.dist[i]) - parseFloat(off.dist[i])).toFixed(1));
  console.log(`  差：线0 ${d[0]}  线1 ${d[1]}  线2 ${d[2]}  线3 ${d[3]}  线4 ${d[4]}（百分点）\n`);
}
ai.SIM_OPTS.pattern = true;
