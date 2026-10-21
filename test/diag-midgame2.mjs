/* 拆开一个真实中盘局面的选点分解：静态项 / 模拟项 / 线位先验 / 战术豁免
 * 运行： node test/diag-midgame2.mjs [手数]
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
const AT = parseInt(process.argv[2] || '40', 10);

// 先自对弈到第 AT 手
const rng = ai.makeRng(424242);
const b = new Board();
const level = ai.LEVELS.find(l => l.key === 'l4');
for (let m = 0; m < AT; m++) {
  const color = b.toPlay;
  const cands = E.candidateMoves(b, color, E.analyzeBoard(b));
  if (!cands.length) break;
  const st = ai.evalMovesSync(b, 6.5, cands, 60, 220, 500 + m * 41, 14, color === BLACK);
  const mv = ai.chooseAiMove(st, level, rng, cands);
  if (mv < 0) break;
  b.play(mv, color);
  b.toPlay = 3 - color;
}

let empty = 0, stones = 0;
for (let p = 0; p < 121; p++) {
  if (b.stones[p] === 0) empty++;
  else if (b.stones[p] === 1 || b.stones[p] === 2) stones++;
}
console.log(`局面：第 ${AT} 手之后，棋子 ${stones}，空点 ${empty}，行棋方 ${b.toPlay === BLACK ? '黑' : '白'}`);

const ana = E.analyzeBoard(b);
const legal = E.candidateMoves(b, b.toPlay, ana);
console.log(`合法点 ${legal.length}`);

// 有多少块棋在打吃（会被「战术豁免」免掉线位先验）
let atariGroups = 0;
for (let p = 0; p < 121; p++) {
  const s = b.stones[p];
  if (s !== BLACK && s !== WHITE) continue;
  if (ana.libs[p] !== 1) continue;
  const g = E.groupStats(b, p);
  if (g.size > 0) { atariGroups++; p = 999; }   // 每块只算一次（粗略）
}
console.log(`打吃中的棋块（会被战术豁免）：约 ${atariGroups} 块`);

const stats = ai.evalMovesSync(b, 6.5, legal, 60, 220, 777, 999, b.toPlay === BLACK);
const rows = [...stats.entries()].sort((a, c) => c[1].margin - a[1].margin);
console.log(`\n返回候选 ${rows.length} / 合法点 ${legal.length}`);
console.log('\n  坐标   线  静态项  0.35×模拟   先验     调整   margin   黑方WR');
rows.slice(0, 12).forEach(([mv, s]) => {
  console.log(`  (${xOf(mv)},${yOf(mv)})  ${lineOf(mv)}  ${s.stat.toFixed(1).padStart(7)} ${(s.mcMargin * 0.35).toFixed(2).padStart(8)}` +
    ` ${s.prior.toFixed(2).padStart(7)} ${(s.adj || 0).toFixed(2).padStart(7)} ${s.margin.toFixed(2).padStart(8)}` +
    `  ${(s.wr * 100).toFixed(1).padStart(6)}%`);
});
console.log('\n  每个线位里 margin 最好的那个：');
const bestByLine = {};
for (const [mv, s] of rows) {
  const d = lineOf(mv);
  if (!bestByLine[d] || s.margin > bestByLine[d][1].margin) bestByLine[d] = [mv, s];
}
Object.keys(bestByLine).sort((a, b) => a - b).forEach(d => {
  const [mv, s] = bestByLine[d];
  console.log(`  线${d} 最佳 (${xOf(mv)},${yOf(mv)})  静态 ${s.stat.toFixed(1).padStart(7)}  0.35×模拟 ${(s.mcMargin * 0.35).toFixed(2).padStart(7)}` +
    `  先验 ${s.prior.toFixed(2).padStart(6)}  margin ${s.margin.toFixed(2).padStart(7)}`);
});

const byLine = {};
for (const [, s] of rows) { /* noop */ }
for (const [mv, s] of rows) {
  const d = lineOf(mv);
  (byLine[d] = byLine[d] || []).push(s);
}
console.log('\n  线位  候选数  平均静态  平均0.35×模拟  平均先验  平均调整  平均margin');
Object.keys(byLine).sort((a, b) => a - b).forEach(d => {
  const arr = byLine[d];
  const avg = f => arr.reduce((a, s) => a + f(s), 0) / arr.length;
  console.log(`  线${d}   ${String(arr.length).padStart(4)} ${avg(s => s.stat).toFixed(2).padStart(8)}` +
    ` ${avg(s => s.mcMargin * 0.35).toFixed(2).padStart(11)} ${avg(s => s.prior).toFixed(2).padStart(8)}` +
    ` ${avg(s => s.adj || 0).toFixed(2).padStart(8)} ${avg(s => s.margin).toFixed(2).padStart(10)}`);
});
