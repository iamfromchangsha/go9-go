/* 诊断：随机模拟（playout）自身的线位偏好
 * 运行： node test/diag-playout-lines.mjs
 *
 * 如果模拟里双方都爱往边上下，那么「蒙特卡洛评估」天然偏向边，
 * 外面加什么先验都纠不回来。必须先量出模拟本身的偏好。
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
const mk = stones => {
  const b = new Board();
  for (const [x, y, c] of stones) { b.stones[idx(x, y)] = c; b.toggle(idx(x, y), c); }
  return b;
};

/* ---------- 1. 模拟终局：一线、二线上有多少子 ---------- */
console.log('=== 随机模拟终局：落在一线、二线的子数（每局平均，200 局）===');
{
  const rng = ai.makeRng(1234);
  const b = new Board();
  b.toPlay = BLACK;
  let l1 = 0, l2 = 0;
  const N = 200;
  for (let s = 0; s < N; s++) {
    const c = b.clone();
    ai.simulate(c, rng, ai.SIM_OPTS);
    for (let p = 0; p < 121; p++) {
      const st = c.stones[p];
      if (st !== BLACK && st !== WHITE) continue;
      const d = lineOf(p);
      if (d === 0) l1++;
      else if (d === 1) l2++;
    }
  }
  console.log(`  一线平均 ${(l1 / N).toFixed(1)} 子，二线平均 ${(l2 / N).toFixed(1)} 子`);
  console.log('  9×9 一线共 32 个点；正常棋局里一线应该几乎没有子（收官除外）');
}

/* ---------- 2. 纯 MC（不含静态项/先验）会选哪 ---------- */
console.log('\n=== 纯 MC（每候选 200 次模拟）下的选点 ===');
{
  const cases = [
    ['空盘        ', mk([])],
    ['黑(4,4)白(8,8)', mk([[4, 4, BLACK], [8, 8, WHITE]])]
  ];
  for (const [name, b] of cases) {
    const ana = E.analyzeBoard(b);
    const legal = E.candidateMoves(b, b.toPlay, ana);
    const rows = [];
    for (const mv of legal) {
      const c = b.clone();
      c.play(mv, b.toPlay); c.toPlay = 3 - b.toPlay;
      const rng = ai.makeRng(4242);
      let sum = 0;
      const N = 200;
      for (let i = 0; i < N; i++) { const sc = ai.simulate(c.clone(), rng, ai.SIM_OPTS); sum += sc.black - sc.white - 6.5; }
      rows.push([mv, sum / N]);
    }
    rows.sort((a, b2) => b2[1] - a[1]);
    console.log(`  ${name} 前 8 手 = ` + rows.slice(0, 8).map(([mv]) =>
      `(${xOf(mv)},${yOf(mv)})线${lineOf(mv)}`).join(' '));
    const dist = {};
    for (const [mv] of rows.slice(0, 10)) { const d = lineOf(mv); dist[d] = (dist[d] || 0) + 1; }
    console.log(`             前 10 手的线位分布: ${JSON.stringify(dist)}`);
  }
}

/* ---------- 3. 模拟里每一步实际落在哪（用空盘开局，走 30 手看分布） ---------- */
console.log('\n=== 模拟过程中的落子线位（每步）===');
{
  // 借助 simulate 的分支概率无法直接观察，改为统计「终局盘上所有子」的线位直方图
  const rng = ai.makeRng(777);
  const b = new Board();
  b.toPlay = BLACK;
  const hist = {};
  const N = 60;
  for (let s = 0; s < N; s++) {
    const c = b.clone();
    ai.simulate(c, rng, ai.SIM_OPTS);
    for (let p = 0; p < 121; p++) {
      const st = c.stones[p];
      if (st !== BLACK && st !== WHITE) continue;
      const d = lineOf(p);
      hist[d] = (hist[d] || 0) + 1;
    }
  }
  const total = Object.values(hist).reduce((a, b) => a + b, 0);
  const line = Object.keys(hist).sort((a, b) => a - b).map(d =>
    `线${d}: ${(hist[d] / total * 100).toFixed(1)}%`).join('  ');
  console.log('  终局所有子的线位占比 →', line);
  console.log(`  一二线合计 ${(((hist[0] || 0) + (hist[1] || 0)) / total * 100).toFixed(1)}%` +
    `（9×9 盘面上一二线共占 ${(32 + 28) / 81 * 100}%）`);
}
