/* 评估「着法之间差距」的可靠性 —— 这正是妙手/俗手判定所依赖的量 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/engine.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/ai.js'), 'utf8'));
const { engine: E, ai } = globalThis.GO9;
const { idx, Board, BLACK } = E;

function makePos(seed) {
  const b = new Board();
  const rng = ai.makeRng(seed);
  for (let i = 0; i < 18; i++) {
    const x = (rng() * 9) | 0, y = (rng() * 9) | 0;
    const p = idx(x, y);
    if (b.stones[p] === 0 && b.play(p, b.toPlay)) b.toPlay = 3 - b.toPlay;
  }
  return b;
}

const b = makePos(4242);
const ana = E.analyzeBoard(b);
const legal = E.candidateMoves(b, b.toPlay, ana);
const KOMI = 6.5;

// 基准：每手 2000 次模拟
const truth = ai.evalMovesSync(b, KOMI, legal, 2000, 2000, 31337, 999);
const truthOrder = [...truth.entries()].sort((a, c) => c[1].wr - a[1].wr);
const truthBest = truthOrder[0][1].wr;
console.log(`基准最优着法 wr=${(truthBest * 100).toFixed(1)}%，候选 ${legal.length} 个`);

for (const per of [90, 160, 260, 400]) {
  const errs = [], bestHits = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    const ev = ai.evalMovesSync(b, KOMI, legal, per, per, seed * 7919, 999);
    const order = [...ev.entries()].sort((a, c) => c[1].wr - a[1].wr);
    const evBest = order[0][1].wr;
    // 各候选与「评估出的最优」之间的差距，与基准差距比较
    for (const [mv, inf] of truthOrder.slice(0, 8)) {
      const truthGap = (truthBest - inf.wr) * 100;           // 基准：落后多少个百分点
      const evGap = (evBest - ev.get(mv).wr) * 100;         // 评估：落后多少个百分点
      errs.push(Math.abs(evGap - truthGap));
    }
    bestHits.push(order[0][0] === truthOrder[0][0] ? 1 : 0);
  }
  const mae = errs.reduce((a, c) => a + c, 0) / errs.length;
  console.log(`  每手 ${String(per).padStart(3)} 次：差距估计平均误差 ${mae.toFixed(2)} 个百分点，` +
    `最优着法命中 ${bestHits.reduce((a, c) => a + c, 0)}/5 次`);
}
