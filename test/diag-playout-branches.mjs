/* 诊断：模拟里的边缘落子到底来自哪条分支
 * 运行： node test/diag-playout-branches.mjs
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

ai.SIM_DEBUG.on = true;
ai.simDebugReset();
const rng = ai.makeRng(20261021);
const b = new Board();
b.toPlay = BLACK;
for (let i = 0; i < 12; i++) ai.simulate(b.clone(), rng, ai.SIM_OPTS);

const br = ai.SIM_DEBUG.branch;
const li = ai.SIM_DEBUG.lines;
const totalMoves = br.tactical + br.friendly + br.local + br.global;
console.log('=== 12 次模拟的落子分支统计 ===');
for (const k of ['tactical', 'friendly', 'local', 'global']) {
  console.log(`  ${k.padEnd(9)} ${String(br[k] || 0).padStart(6)} 次  ${((br[k] || 0) / totalMoves * 100).toFixed(1)}%`);
}
const totalLines = Object.values(li).reduce((a, b) => a + b, 0);
console.log('\n=== 落子线位分布（全部分支合计）===');
Object.keys(li).sort((a, b) => a - b).forEach(d => {
  console.log(`  线${d}: ${String(li[d]).padStart(6)} 次  ${(li[d] / totalLines * 100).toFixed(1)}%`);
});
console.log(`  一二线合计 ${(((li[0] || 0) + (li[1] || 0)) / totalLines * 100).toFixed(1)}%` +
  `（9×9 一二线占 ${(60 / 81 * 100).toFixed(1)}%）`);

console.log('\n=== 每个分支自己的线位分布 ===');
for (const k of ['tactical', 'friendly', 'local', 'global']) {
  const d = ai.SIM_DEBUG.bl[k] || {};
  const t = Object.values(d).reduce((a, b) => a + b, 0);
  if (!t) continue;
  const s = Object.keys(d).sort((a, b) => a - b)
    .map(x => `线${x}:${(d[x] / t * 100).toFixed(0)}%`).join(' ');
  console.log(`  ${k.padEnd(9)} ${String(t).padStart(5)} 手  ${s}`);
}
