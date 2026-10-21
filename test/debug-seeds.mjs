/* 决定性实验：同样的总样本数，分给 1 个种子还是多个种子？
 * 如果"换种子"比"加样本"更有效，说明同种子内的模拟高度相关。
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

const b = new Board();
b.stones[idx(2, 4)] = WHITE; b.toggle(idx(2, 4), WHITE);
b.toPlay = BLACK;

function scoreWithSeeds(mv, seeds, perSeed) {
  let sum = 0;
  for (const sd of seeds) {
    const rng = ai.makeRng(sd);
    const bb = b.clone();
    bb.play(mv, BLACK); bb.toPlay = WHITE;
    for (let i = 0; i < perSeed; i++) {
      const t = bb.clone();
      const sc = ai.simulate(t, rng, ai.SIM_OPTS);
      sum += sc.black - sc.white - 6.5;
    }
  }
  return sum / (seeds.length * perSeed);
}

const A = idx(2, 2), B = idx(4, 3);
console.log('总样本数固定为 220，看分成 k 个种子时的差距估计噪声：');
for (const k of [1, 2, 4, 8, 16]) {
  const per = Math.max(1, Math.round(220 / k));
  const gaps = [];
  for (let g = 0; g < 14; g++) {
    const seeds = [];
    for (let i = 0; i < k; i++) seeds.push(((g * 131 + i * 7919 + 17) >>> 0));
    const a = scoreWithSeeds(A, seeds, per);
    const c = scoreWithSeeds(B, seeds, per);
    gaps.push(a - c);
  }
  const m = gaps.reduce((x, y) => x + y, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((x, y) => x + (y - m) ** 2, 0) / gaps.length);
  console.log(`  k=${String(k).padStart(2)} 个种子 × ${String(per).padStart(3)} 次：差距均值 ${m.toFixed(2)}，标准差 ${sd.toFixed(2)} 点`);
}
