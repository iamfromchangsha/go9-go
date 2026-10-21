/* 决定性度量：混合评估的「区分能力」
 * 取多对候选着法，比较：
 *   基准 = 高样本(3000 次)蒙特卡洛的目差
 *   评估 = 各 λ 下算出的目差
 * 看相关系数与平均绝对误差 —— 相关性高、误差小 ⇒ 混合评估既准又稳
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
const { idx, Board, BLACK, WHITE } = E;

/* 一个中盘局面：双方各有几块棋，中心有接触 */
function midgamePos() {
  const b = new Board();
  const bl = [[1, 1], [1, 2], [2, 1], [6, 6], [6, 7], [7, 6], [5, 5], [4, 4]];
  const wh = [[7, 1], [7, 2], [6, 1], [1, 7], [2, 7], [1, 6], [4, 5], [5, 4]];
  for (const [x, y] of bl) { b.stones[idx(x, y)] = BLACK; b.toggle(idx(x, y), BLACK); }
  for (const [x, y] of wh) { b.stones[idx(x, y)] = WHITE; b.toggle(idx(x, y), WHITE); }
  b.toPlay = BLACK;
  return b;
}

const b = midgamePos();
const ana = E.analyzeBoard(b);
const legal = E.candidateMoves(b, BLACK, ana);
console.log(`中盘局面：黑 ${Array.from(b.stones).filter(v => v === 1).length} 子 / 白 ${Array.from(b.stones).filter(v => v === 2).length} 子，候选 ${legal.length} 个`);

/* 基准：每候选 2500 次蒙特卡洛 */
const TRUTH_N = 2500;
console.log(`计算基准中（每候选 ${TRUTH_N} 次模拟，约需一分钟）…`);
const truth = new Map();
for (const mv of legal) {
  const stats = ai.evalMovesSync(b, 6.5, [mv], TRUTH_N, TRUTH_N, 20260101, 1);
  truth.set(mv, stats.get(mv).margin);
}
const tv = [...truth.values()];
console.log(`基准目差范围：${Math.min(...tv).toFixed(1)} ~ ${Math.max(...tv).toFixed(1)} 点`);

function correlation(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, c) => a + c, 0) / n, my = ys.reduce((a, c) => a + c, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

console.log('\nλ      与基准的相关系数   平均绝对误差(点)   排序前3命中率');
for (const w of [0, 0.2, 0.35, 0.6, 1.0]) {
  ai.setMcWeight(w);
  const stats = ai.evalMovesSync(b, 6.5, legal, 60, 220, 777, legal.length);
  const xs = [], ys = [];
  for (const mv of legal) { xs.push(stats.get(mv).margin); ys.push(truth.get(mv)); }
  const r = correlation(xs, ys);
  const mae = xs.reduce((a, c, i) => a + Math.abs(c - ys[i]), 0) / xs.length;
  const topEval = [...stats.entries()].sort((x, y) => y[1].margin - x[1].margin).slice(0, 3).map(([mv]) => mv);
  const topTrue = [...truth.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([mv]) => mv);
  const hit = topEval.filter(mv => topTrue.includes(mv)).length;
  console.log(`  ${w.toFixed(2)}       ${r.toFixed(3)}              ${mae.toFixed(2)}              ${hit}/3`);
}
