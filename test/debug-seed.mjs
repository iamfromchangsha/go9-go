/* 提子识别的稳定性：换种子换局面，看识别率与预算的关系 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/engine.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/ai.js'), 'utf8'));
const { engine: E, ai } = globalThis.GO9;
const { idx, Board, BLACK, WHITE, EMPTY } = E;

function cornerCase() {
  const b = new Board();
  b.stones[idx(0, 0)] = WHITE; b.toggle(idx(0, 0), WHITE);
  b.stones[idx(1, 0)] = WHITE; b.toggle(idx(1, 0), WHITE);
  b.stones[idx(0, 1)] = WHITE; b.toggle(idx(0, 1), WHITE);
  b.stones[idx(2, 0)] = BLACK; b.toggle(idx(2, 0), BLACK);
  b.stones[idx(0, 2)] = BLACK; b.toggle(idx(0, 2), BLACK);
  b.toPlay = BLACK;
  return { b, cap: idx(1, 1) };
}

const { b, cap } = cornerCase();
const ana = E.analyzeBoard(b);
const legal = E.candidateMoves(b, BLACK, ana);

for (const per of [80, 160, 320, 640]) {
  const ranks = [];
  for (let s = 1; s <= 6; s++) {
    const stats = ai.evalMovesSync(b, 6.5, legal, per, per, s * 104729, 999);
    const order = [...stats.entries()].sort((a, c) => c[1].wr - a[1].wr);
    ranks.push(order.findIndex(([mv]) => mv === cap) + 1);
  }
  const top1 = ranks.filter(r => r === 1).length;
  const top5 = ranks.filter(r => r <= 5).length;
  console.log(`每手 ${String(per).padStart(3)} 次模拟：名次 ${ranks.join(',')}  第一 ${top1}/6  前五 ${top5}/6`);
}

// 真实基准（样本极多）
const truth = ai.evalMovesSync(b, 6.5, legal, 3000, 3000, 99991, 999);
const order = [...truth.entries()].sort((a, c) => c[1].wr - a[1].wr);
console.log(`\n基准（每手 3000 次）：提子名次 ${order.findIndex(([mv]) => mv === cap) + 1}，` +
  `胜率 ${(truth.get(cap).wr * 100).toFixed(1)}%，第 2 名 ${(order[1][1].wr * 100).toFixed(1)}%`);
