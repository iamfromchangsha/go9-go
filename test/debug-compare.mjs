/* 对照：评估管线算出的值 vs 直接模拟算出的值（同样本数、同种子） */
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

const b = new Board();
b.stones[idx(2, 4)] = WHITE; b.toggle(idx(2, 4), WHITE);
b.toPlay = BLACK;

const ana = E.analyzeBoard(b);
const legal = E.candidateMoves(b, BLACK, ana);
const SEED = 999;

const evalStats = ai.evalMovesSync(b, 6.5, legal, 60, 220, SEED, 14);

/* 直接模拟：同样的种子、同样的样本数 */
function direct(mv, n, seed) {
  const rng = ai.makeRng(seed);
  const bb = b.clone();
  bb.play(mv, BLACK);
  bb.toPlay = WHITE;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = bb.clone();
    const sc = ai.simulate(t, rng, ai.SIM_OPTS);
    sum += sc.black - sc.white - 6.5;
  }
  return sum / n;
}

const ranked = [...evalStats.entries()].sort((a, c) => c[1].wr - a[1].wr);
console.log('着法      评估值(220)   直接模拟(220)   直接模拟(600)');
for (const [mv, inf] of ranked.slice(0, 8)) {
  const d220 = direct(mv, 220, SEED);
  const d600 = direct(mv, 600, 4242);
  console.log(`  ${COLS[E.xOf(mv)]}${9 - E.yOf(mv)}    ${(inf.wr * 100).toFixed(1)}%        ` +
    `${(d220).toFixed(2)} 目        ${(d600).toFixed(2)} 目`);
}
