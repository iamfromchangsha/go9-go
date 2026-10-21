/* 对照实验：新的配对模拟评估，排序是否可靠
 * 1) 与「高样本直接模拟」这个基准对比，看排序是否一致
 * 2) 重复评估同一批着法，量化噪声水平（用于标定「妙手/俗手」阈值）
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

function makePos() {
  const b = new Board();
  for (const [x, y] of [[0, 0], [1, 0], [0, 1]]) { b.stones[idx(x, y)] = WHITE; b.toggle(idx(x, y), WHITE); }
  for (const [x, y] of [[2, 0], [0, 2]]) { b.stones[idx(x, y)] = BLACK; b.toggle(idx(x, y), BLACK); }
  b.toPlay = BLACK;
  return b;
}

const b = makePos();
const cap = idx(1, 1);
const ana = E.analyzeBoard(b);
const legal = E.candidateMoves(b, BLACK, ana);

/* 基准：每个候选跑 1200 次模拟（配对），耗时较长但更可信 */
const truth = ai.evalMovesSync(b, 6.5, legal, 1200, 1200, 20240101, 999);
const truthRank = [...truth.entries()].sort((a, c) => c[1].wr - a[1].wr).map(([mv]) => mv);
console.log(`基准（每手 1200 次模拟）：提子着法排名 ${truthRank.indexOf(cap) + 1} / ${legal.length}`);

/* 产品实际使用的预算 */
for (const per of [40, 90, 160, 260, 400]) {
  const ev = ai.evalMovesSync(b, 6.5, legal, per, per, 777, 999);
  const order = [...ev.entries()].sort((a, c) => c[1].wr - a[1].wr).map(([mv]) => mv);
  const capPos = order.indexOf(cap) + 1;
  // 与基准排序的一致性（Spearman 近似：前 10 名的重合数）
  const top10 = new Set(order.slice(0, 10));
  const overlap = truthRank.slice(0, 10).filter(m => top10.has(m)).length;
  const capWR = ev.get(cap).wr;
  const capTruth = truth.get(cap).wr;
  console.log(`  每手 ${String(per).padStart(3)} 次模拟：提子排名 ${String(capPos).padStart(2)}  ` +
    `wr=${(capWR * 100).toFixed(1)}%（基准 ${(capTruth * 100).toFixed(1)}%）  前10重合 ${overlap}/10`);
}

/* 噪声水平：同一批着法用不同种子评估两次，看排名波动 */
const s1 = ai.evalMovesSync(b, 6.5, legal, 160, 160, 111, 999);
const s2 = ai.evalMovesSync(b, 6.5, legal, 160, 160, 222, 999);
const o1 = [...s1.entries()].sort((a, c) => c[1].wr - a[1].wr).map(([mv]) => mv);
const o2 = [...s2.entries()].sort((a, c) => c[1].wr - a[1].wr).map(([mv]) => mv);
let maxDiff = 0, sumDiff = 0, n = 0;
for (const [mv, inf] of s1) {
  const d = Math.abs(inf.wr - s2.get(mv).wr) * 100;
  maxDiff = Math.max(maxDiff, d); sumDiff += d; n++;
}
const top10o = new Set(o2.slice(0, 10));
console.log(`\n噪声（160 次/手，两次独立评估）：平均 |Δwr| = ${(sumDiff / n).toFixed(2)} 个百分点，最大 ${maxDiff.toFixed(1)}`);
console.log(`前10名重合：${o1.slice(0, 10).filter(m => top10o.has(m)).length}/10`);
