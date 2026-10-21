/* 诊断：中盘局面里，静态项到底在推什么
 * 运行： node test/diag-midgame.mjs
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

// A/B 实验里截到的第 20 手局面：黑先
const stones = [
  [6, 1, WHITE], [1, 2, WHITE], [2, 2, BLACK], [3, 2, BLACK], [4, 2, WHITE],
  [6, 2, BLACK], [3, 3, WHITE], [6, 3, WHITE], [7, 3, BLACK], [4, 4, BLACK],
  [5, 4, WHITE], [2, 5, BLACK], [6, 5, BLACK], [2, 6, WHITE], [6, 6, WHITE],
  [1, 7, BLACK], [3, 7, BLACK], [4, 7, WHITE], [7, 7, BLACK], [7, 8, WHITE]
];
const b = new Board();
for (const [x, y, c] of stones) { b.stones[idx(x, y)] = c; b.toggle(idx(x, y), c); }
b.toPlay = BLACK;
b.moveNum = 20;

const ana = E.analyzeBoard(b);
const legal = E.candidateMoves(b, BLACK, ana);
const stats = ai.evalMovesSync(b, 6.5, legal, 60, 240, 777, 14, true);
const rows = [...stats.entries()].sort((a, c) => c[1].margin - a[1].margin);

console.log('=== 中盘（20 子，黑先）前 12 手的分解 ===');
console.log('  坐标    线  静态项   模拟项  0.35×模拟   先验   混合margin');
rows.slice(0, 12).forEach(([mv, s]) => {
  console.log(`  (${xOf(mv)},${yOf(mv)})  ${lineOf(mv)}  ${s.stat.toFixed(1).padStart(7)} ${s.mcMargin.toFixed(1).padStart(8)}` +
    ` ${(s.mcMargin * 0.35).toFixed(2).padStart(9)} ${s.prior.toFixed(2).padStart(7)} ${s.margin.toFixed(2).padStart(10)}`);
});
const st = rows.map(r => r[1].stat), mc = rows.map(r => r[1].mcMargin * 0.35), pr = rows.map(r => r[1].prior);
const rngOf = a => (Math.max(...a) - Math.min(...a)).toFixed(2);
console.log(`  极差: 静态项 ${rngOf(st)}  0.35×模拟 ${rngOf(mc)}  先验 ${rngOf(pr)}`);

/* 各线位的平均三项 */
const byLine = {};
for (const [mv, s] of rows) {
  const d = lineOf(mv);
  (byLine[d] = byLine[d] || []).push(s);
}
console.log('\n  线位  候选数  平均静态项  平均0.35×模拟  平均先验  平均margin');
Object.keys(byLine).sort((a, b) => a - b).forEach(d => {
  const arr = byLine[d];
  const avg = f => (arr.reduce((a, b) => a + f(b), 0) / arr.length);
  console.log(`  线${d}   ${String(arr.length).padStart(4)}  ${avg(s => s.stat).toFixed(2).padStart(9)}` +
    ` ${avg(s => s.mcMargin * 0.35).toFixed(2).padStart(11)} ${avg(s => s.prior).toFixed(2).padStart(8)}` +
    ` ${avg(s => s.margin).toFixed(2).padStart(10)}`);
});
