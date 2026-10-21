/* 参数寻优：评估预算与分阶段策略，怎样才能稳定认出「该提的一手」 */
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

/* 造若干带「可提子」的随机局面 */
function makePositions(n) {
  const list = [];
  for (let g = 0; g < n; g++) {
    const rng = ai.makeRng(1000 + g * 131);
    const b = new Board();
    for (let i = 0; i < 26; i++) {
      const x = (rng() * 9) | 0, y = (rng() * 9) | 0;
      const p = idx(x, y);
      if (b.stones[p] === 0 && b.play(p, b.toPlay)) b.toPlay = 3 - b.toPlay;
    }
    // 找出一个对方棋块只有一口气的点，作为「该提的一手」
    const ana = E.analyzeBoard(b);
    let cap = -1;
    for (let y = 0; y < 9 && cap < 0; y++) {
      for (let x = 0; x < 9 && cap < 0; x++) {
        const p = idx(x, y);
        if (b.stones[p] !== EMPTY) continue;
        // 该点若能提子（周围有被打吃的块）
        for (const n of E.NEI[p]) {
          if (b.stones[n] === 3 - b.toPlay && ana.libs[n] === 1) { cap = p; break; }
        }
      }
    }
    if (cap >= 0) list.push({ b, cap });
  }
  return list;
}
const EMPTY = 0;

const positions = makePositions(8);
console.log(`构造了 ${positions.length} 个「有子可提」的局面\n`);

const configs = [
  { name: '单段 160',        per: 160, top: 999, ratio: 1.0, fin: 0 },
  { name: '粗45/精16/终6',  per: 160, top: 16,  ratio: 0.45, fin: 6 },
  { name: '粗45/精20/终8',  per: 160, top: 20,  ratio: 0.45, fin: 8 },
  { name: '粗60/精16/终6',  per: 160, top: 16,  ratio: 0.60, fin: 6 },
  { name: '粗45/精16/终6 @260', per: 260, top: 16, ratio: 0.45, fin: 6 },
  { name: '粗45/精16/终6 @400', per: 400, top: 16, ratio: 0.45, fin: 6 }
];

for (const cfg of configs) {
  let hit = 0, top3 = 0, ranks = [], cost = 0;
  for (const pos of positions) {
    const ana = E.analyzeBoard(pos.b);
    const legal = E.candidateMoves(pos.b, pos.b.toPlay, ana);
    const stats = ai.evalMovesSync(pos.b, 6.5, legal, Math.round(cfg.per * cfg.ratio), cfg.per, 20260921, cfg.top);
    const order = [...stats.entries()].sort((a, c) => c[1].wr - a[1].wr);
    const rank = order.findIndex(([mv]) => mv === pos.cap) + 1;
    ranks.push(rank);
    if (rank === 1) hit++;
    if (rank <= 3) top3++;
    cost += legal.length * Math.round(cfg.per * cfg.ratio) + cfg.top * Math.round(cfg.per * (1 - cfg.ratio)) + cfg.fin * Math.round(cfg.per * 0.5);
  }
  console.log(`${cfg.name.padEnd(22)} 命中第一 ${hit}/${positions.length}  前三 ${top3}/${positions.length}  ` +
    `名次 ${ranks.join(',')}  约 ${Math.round(cost / positions.length)} 次模拟`);
}
