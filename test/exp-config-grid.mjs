/* 四种配置对照：静态项渐入(ramp) × 软上限(cap) 对引擎线位选择的影响
 * 运行： node test/exp-config-grid.mjs
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
const COARSE = 40, FINE = 160, REFINE = 10;

function play(seed, ramp, cap, moves) {
  ai.setStaticRamp(ramp);
  ai.setStaticCap(cap);
  const rng = ai.makeRng(seed);
  const b = new Board();
  const lines = [];
  for (let m = 0; m < moves; m++) {
    const color = b.toPlay;
    const cands = E.candidateMoves(b, color, E.analyzeBoard(b));
    if (!cands.length) break;
    const st = ai.evalMovesSync(b, 6.5, cands, COARSE, FINE, seed + m * 31, REFINE, color === BLACK);
    const mv = ai.chooseAiMove(st, ai.LEVELS[4], rng, cands);
    if (mv < 0) break;
    lines.push(lineOf(mv));
    b.play(mv, color);
    b.toPlay = 3 - color;
  }
  return lines;
}

console.log('配置             一线  二线  三线+   一二线占比   （2 局 × 24 手）');
for (const [ramp, cap] of [[true, 3.0], [true, 0], [false, 3.0], [false, 0]]) {
  const all = [];
  for (let g = 0; g < 2; g++) all.push(...play(20260101 + g * 1000, ramp, cap, 24));
  const c = [0, 0, 0];
  for (const d of all) c[Math.min(d, 2)]++;
  const edge = c[0] + c[1];
  console.log(`ramp=${ramp ? 'ON ' : 'OFF'} cap=${cap ? cap.toFixed(1) : 'OFF '}  ` +
    `${String(c[0]).padStart(4)} ${String(c[1]).padStart(5)} ${String(c[2]).padStart(5)}   ` +
    `${(edge / all.length * 100).toFixed(0)}%`);
}
ai.setStaticRamp(true);
ai.setStaticCap(3.0);
