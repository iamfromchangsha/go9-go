/* 量化：面积计分对「1-1 点」的偏好有多大（不含先验的原始模拟值） */
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
const show = p => COLS[E.xOf(p)] + (9 - E.yOf(p));

/* 白占 C7（人类），黑候选 */
function rawMargin(b, mv, color, n = 600, seed = 777) {
  const rng = ai.makeRng(seed);
  const bb = b.clone();
  bb.play(mv, color);
  bb.toPlay = 3 - color;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = bb.clone();
    const sc = ai.simulate(t, rng, ai.SIM_OPTS);
    sum += sc.black - sc.white - 6.5;
  }
  return sum / n;
}

const b = new Board();
b.stones[idx(2, 2)] = BLACK; b.toggle(idx(2, 2), BLACK);   // 人类 C7
b.toPlay = WHITE;

console.log('白走各点的「原始模拟终局差」（600 次，不含任何先验）：');
const pts = [
  ['A9  一线1-1点', idx(0, 0)],
  ['B9  二线', idx(1, 0)],
  ['C7  三线3-3点(同角)', idx(2, 2)],   // 已被占
  ['C8  三线', idx(2, 1)],
  ['A7  三线', idx(0, 2)],
  ['C3  三线(对角)', idx(2, 6)],
  ['G7  三线(对角)', idx(6, 1)],
  ['E5  天元', idx(4, 4)],
  ['D7  挂角附近', idx(3, 1)]
];
for (const [label, p] of pts) {
  if (b.stones[p] !== 0) { console.log(`  ${label.padEnd(18)} （已被占）`); continue; }
  const m = rawMargin(b, p, WHITE);
  console.log(`  ${label.padEnd(18)} ${m.toFixed(2)} 目`);
}
