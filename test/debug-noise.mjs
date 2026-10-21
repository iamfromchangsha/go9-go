/* 量化评估噪声结构：单次模拟的分数分布 / 估计随种子与样本数的波动 */
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

function playoutScores(mv, n, seed) {
  const rng = ai.makeRng(seed);
  const bb = b.clone();
  bb.play(mv, BLACK); bb.toPlay = WHITE;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = bb.clone();
    const sc = ai.simulate(t, rng, ai.SIM_OPTS);
    out.push(sc.black - sc.white - 6.5);
  }
  return out;
}

/* 1) 单次模拟分数的分布 */
const s = playoutScores(idx(2, 2), 400, 1);
const mean = s.reduce((a, c) => a + c, 0) / s.length;
const sd = Math.sqrt(s.reduce((a, c) => a + (c - mean) ** 2, 0) / s.length);
console.log(`单次模拟终局差：均值 ${mean.toFixed(2)} 点，标准差 ${sd.toFixed(2)} 点`);
console.log(`  → 220 次的理论上 SE ≈ ${(sd / Math.sqrt(220)).toFixed(2)} 点，但实测跨种子摆动 5.6 点 ⇒ 存在「种子级偏置」`);

/* 2) 同一候选，跨种子的估计（220 次/种子） */
console.log('\n同一候选（C2），不同种子的 220 次估计：');
const est = [];
for (let seed = 1; seed <= 6; seed++) {
  const sc = playoutScores(idx(2, 2), 220, seed * 7919);
  est.push(sc.reduce((a, c) => a + c, 0) / sc.length);
  process.stdout.write(`  seed${seed}: ${est[est.length - 1].toFixed(2)}`);
}
const em = est.reduce((a, c) => a + c, 0) / est.length;
const esd = Math.sqrt(est.reduce((a, c) => a + (c - em) ** 2, 0) / est.length);
console.log(`\n  跨种子均值 ${em.toFixed(2)}，跨种子标准差 ${esd.toFixed(2)} 点`);

/* 3) 两个候选的「差距」跨种子波动 —— 这才是妙手/俗手判定所依赖的量 */
console.log('\n两个候选的差距（C2 - E4），跨种子：');
const gaps = [];
for (let seed = 1; seed <= 6; seed++) {
  const s2 = seed * 7919;
  const a = playoutScores(idx(2, 2), 220, s2).reduce((x, c) => x + c, 0) / 220;
  const c2 = playoutScores(idx(4, 3), 220, s2).reduce((x, c) => x + c, 0) / 220;
  gaps.push(a - c2);
  process.stdout.write(`  ${(a - c2).toFixed(2)}`);
}
const gm = gaps.reduce((a, c) => a + c, 0) / gaps.length;
const gsd = Math.sqrt(gaps.reduce((a, c) => a + (c - gm) ** 2, 0) / gaps.length);
console.log(`\n  差距均值 ${gm.toFixed(2)} 点，跨种子标准差 ${gsd.toFixed(2)} 点`);
console.log(`  → 差距的噪声 ${gsd.toFixed(1)} 点 vs 着法间真实差距 1~4 点 ⇒ 单种子评估排序基本靠运气`);

/* 4) 多种子平均能不能压住？ */
console.log('\n用 k 个种子平均后的差距估计（k 个种子各 220 次）：');
for (const k of [1, 2, 4, 8]) {
  const vals = [];
  for (let g = 0; g < 12; g++) {
    let acc = 0;
    for (let kk = 0; kk < k; kk++) {
      const s2 = (g * 97 + kk * 7919 + 1) >>> 0;
      const a = playoutScores(idx(2, 2), 220, s2).reduce((x, c) => x + c, 0) / 220;
      const c2 = playoutScores(idx(4, 3), 220, s2).reduce((x, c) => x + c, 0) / 220;
      acc += a - c2;
    }
    vals.push(acc / k);
  }
  const m = vals.reduce((a, c) => a + c, 0) / vals.length;
  const d = Math.sqrt(vals.reduce((a, c) => a + (c - m) ** 2, 0) / vals.length);
  console.log(`  k=${k}: 差距均值 ${m.toFixed(2)}，标准差 ${d.toFixed(2)} 点`);
}
