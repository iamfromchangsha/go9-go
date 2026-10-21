/* 调试：角上死活局面里，提子着法的实际评估值 */
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

const b = new Board();
for (const [x, y] of [[0, 0], [1, 0], [0, 1]]) { b.stones[idx(x, y)] = WHITE; b.toggle(idx(x, y), WHITE); }
for (const [x, y] of [[2, 0], [0, 2]]) { b.stones[idx(x, y)] = BLACK; b.toggle(idx(x, y), BLACK); }
b.toPlay = BLACK;

const rng = ai.makeRng(99);
const cfg = { playouts: 4000, c: 0.95, noise: 0, komi: 6.5, sim: ai.SIM_OPTS };
const s = ai.createSearch(b, cfg, rng);
let done = false;
while (!done) done = s.step(500);
const sum = ai.summarize(s.root, 6.5);

console.log('根胜率（黑）:', (sum.winRate * 100).toFixed(1) + '%');
const cap = idx(1, 1);
const rows = [...sum.stats.entries()]
  .sort((a, c) => c[1].wr - a[1].wr)
  .slice(0, 12);
console.log('\n按胜率排序前 12：');
for (const [mv, inf] of rows) {
  console.log(`  (${E.xOf(mv)},${E.yOf(mv)})  wr=${(inf.wr * 100).toFixed(1)}%  visits=${inf.visits}${mv === cap ? '   ← 提子着法' : ''}`);
}
const capInfo = sum.stats.get(cap);
console.log(`\n提子着法 (1,1): wr=${(capInfo.wr * 100).toFixed(1)}% visits=${capInfo.visits}`);

/* 直接对比：提子后 vs 不提，随机模拟 800 次看平均终局差 */
function avgMargin(board) {
  let sum = 0, n = 400;
  for (let i = 0; i < n; i++) {
    const bb = board.clone();
    const sc = ai.simulate(bb, rng, ai.SIM_OPTS);
    sum += sc.black - sc.white - 6.5;
  }
  return sum / n;
}
const afterCap = b.clone(); afterCap.play(idx(1, 1), BLACK);
const afterOther = b.clone(); afterOther.play(idx(4, 2), BLACK);
console.log('\n提子后局面  随机模拟平均终局差:', avgMargin(afterCap).toFixed(2), '点');
console.log('不提琴面    随机模拟平均终局差:', avgMargin(afterOther).toFixed(2), '点');

/* 当前盘面直接面积差 */
console.log('\n提子后当前盘面面积差:', (E.areaScore(afterCap).black - E.areaScore(afterCap).white - 6.5).toFixed(2));
console.log('不提琴面当前盘面面积差:', (E.areaScore(afterOther).black - E.areaScore(afterOther).white - 6.5).toFixed(2));
