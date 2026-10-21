/* 定位：为什么有子之后评估偏向一二线？ */
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
const COLS = 'ABCDEFGHJ';
const lineOf = (x, y) => Math.min(x, y, 8 - x, 8 - y) + 1;

/* 白占 C4（天元），黑该走什么 */
const b = new Board();
b.stones[idx(2, 4)] = WHITE; b.toggle(idx(2, 4), WHITE);
b.toPlay = BLACK;

const ana = E.analyzeBoard(b);
const legal = E.candidateMoves(b, BLACK, ana);
const stats = ai.evalMovesSync(b, 6.5, legal, 60, 220, 999, 14);
const ranked = [...stats.entries()].sort((a, c) => c[1].wr - a[1].wr);

console.log('=== 白占 C4 后，黑的候选前 12 ===');
const cnt = {};
for (const [mv, inf] of ranked.slice(0, 12)) {
  const x = E.xOf(mv), y = E.yOf(mv);
  const l = lineOf(x, y);
  cnt[l] = (cnt[l] || 0) + 1;
  console.log(`  ${COLS[x]}${9 - y}  wr=${(inf.wr * 100).toFixed(1)}%  第${l}线`);
}
console.log('  前 12 名线位分布:', JSON.stringify(cnt));

/* 直接模拟对比：一线 vs 三线 vs 中腹，看模拟终局到底差在哪 */
function detail(mv, label, n = 400) {
  const rng = ai.makeRng(555);
  const bb = b.clone();
  bb.play(mv, BLACK); bb.toPlay = WHITE;
  let sum = 0, sumBlack = 0, sumWhite = 0, sumNeutral = 0;
  for (let i = 0; i < n; i++) {
    const t = bb.clone();
    const sc = ai.simulate(t, rng, ai.SIM_OPTS);
    sum += sc.black - sc.white - 6.5;
    sumBlack += sc.black; sumWhite += sc.white;
    for (let p = 0; p < 121; p++) {
      const x = E.xOf(p), y = E.yOf(p);
      if (x < 0 || y < 0 || x > 8 || y > 8) continue;
      if (!sc.owner[p]) sumNeutral++;
    }
  }
  console.log(`  ${label}: 平均终局差 ${(sum / n).toFixed(2)} 点  黑目 ${(sumBlack / n).toFixed(1)}  白目 ${(sumWhite / n).toFixed(1)}  无主 ${(sumNeutral / n).toFixed(1)}`);
}
console.log('\n=== 直接模拟对比（400 次）===');
detail(idx(8, 0), '黑 J9（一线角）');
detail(idx(6, 0), '黑 H9（三线角）');
detail(idx(4, 4), '黑 E5（中腹天元）');
detail(idx(0, 8), '黑 A1（一线角）');
