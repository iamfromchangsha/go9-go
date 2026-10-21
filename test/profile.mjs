/* 性能剖析：定位随机模拟的耗时分布 */
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

function midBoard(seed) {
  const b = new Board();
  const rng = ai.makeRng(seed);
  for (let i = 0; i < 24; i++) {
    const x = (rng() * 9) | 0, y = (rng() * 9) | 0;
    const p = idx(x, y);
    if (b.stones[p] === 0 && b.play(p, b.toPlay)) b.toPlay = 3 - b.toPlay;
  }
  return b;
}
const b = midBoard(7);
const rng = ai.makeRng(3);
const N = 20000;

function time(label, fn, n) {
  fn(); // warm
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn();
  const dt = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`${label.padEnd(26)} ${(dt / n * 1000).toFixed(2)} µs/次   总 ${dt.toFixed(0)}ms / ${n}`);
  return dt / n;
}

const gi = { stones: [], libs: [], libCount: 0 };
const cells = [];
for (let p = 0; p < 121; p++) if (b.stones[p] === BLACK || b.stones[p] === WHITE) cells.push(p);

time('groupStats', () => E.groupStats(b, cells[0]), N);
time('analyzeBoard', () => E.analyzeBoard(b), N);
time('areaScore', () => E.areaScore(b), N);
time('board.clone', () => b.clone(), N);
time('board.play', () => { const c = b.clone(); c.play(cells[5], c.toPlay); }, 2000);
time('quickLegal', () => ai.quickLegal(b, cells[0], BLACK), N);
time('localTacticalFast', () => ai.localTacticalFast(b, cells[0], BLACK), N);
time('simulate(整局)', () => ai.simulate(b.clone(), rng, ai.SIM_OPTS), 2000);
