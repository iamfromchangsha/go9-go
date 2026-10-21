/* 用「像人类的着法」与 AI 对弈，看 AI 实际的选择
 * 人类走法：占角(三线)、挂角、拆边等常规手
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
const COLS = 'ABCDEFGHJ';
const lineOf = (x, y) => Math.min(x, y, 8 - x, 8 - y) + 1;

function show(p) { return COLS[E.xOf(p)] + (9 - E.yOf(p)); }

/* ---------- 1) 空盘：引擎最推荐哪 ---------- */
{
  const b = new Board(); b.toPlay = BLACK;
  const ana = E.analyzeBoard(b);
  const legal = E.candidateMoves(b, BLACK, ana);
  const stats = ai.evalMovesSync(b, 6.5, legal, 60, 220, 4242, 14);
  const ranked = [...stats.entries()].sort((a, c) => c[1].wr - a[1].wr);
  console.log('=== 空盘：引擎前 8 候选 ===');
  ranked.slice(0, 8).forEach(([mv, inf], i) =>
    console.log(`  ${i + 1}. ${show(mv)}  wr=${(inf.wr * 100).toFixed(1)}%  第${lineOf(E.xOf(mv), E.yOf(mv))}线`));
}

/* ---------- 2) 人类下常规角落后，AI 应该怎么应 ---------- */
{
  const b = new Board();
  b.stones[idx(2, 2)] = BLACK; b.toggle(idx(2, 2), BLACK);   // 人类 C7 三线
  b.toPlay = WHITE;
  const ana = E.analyzeBoard(b);
  const legal = E.candidateMoves(b, WHITE, ana);
  const stats = ai.evalMovesSync(b, 6.5, legal, 60, 220, 4242, 14);
  const ranked = [...stats.entries()].sort((a, c) => c[1].wr - a[1].wr);
  console.log('\n=== 人类下 C7 后，白的候选前 8 ===');
  ranked.slice(0, 8).forEach(([mv, inf], i) => {
    const d = Math.max(Math.abs(E.xOf(mv) - 2), Math.abs(E.yOf(mv) - 2));
    console.log(`  ${i + 1}. ${show(mv)}  wr=${(inf.wr * 100).toFixed(1)}%  第${lineOf(E.xOf(mv), E.yOf(mv))}线  距人类那手 ${d} 格`);
  });
}

/* ---------- 3) 完整一局：人类走常规着法，看 AI 的每手 ---------- */
{
  const b = new Board();
  b.hist = new Map(); b.trackSuperko = true; b.hist.set(b.hash(), true);
  const level = ai.LEVELS[2];
  const rng = ai.makeRng(20261021);
  // 人类的固定套路：占角 → 挂角 → 拆边
  const humanMoves = [[2, 2], [6, 6], [0, 4], [4, 0], [4, 8], [8, 4], [2, 6], [6, 2], [4, 4], [4, 2]];
  let hi = 0;
  const log = [];
  for (let i = 0; i < 20; i++) {
    if (b.toPlay === BLACK) {                      // 人类
      let p = -1;
      while (hi < humanMoves.length) {
        const [x, y] = humanMoves[hi++];
        const q = idx(x, y);
        if (b.stones[q] === 0 && b.play(q, BLACK)) { p = q; break; }
      }
      if (p < 0) { b.passTurn(); log.push('人类 停一手'); continue; }
      log.push(`人类 ${show(p)} [第${lineOf(E.xOf(p), E.yOf(p))}线]`);
    } else {                                       // AI
      const ana = E.analyzeBoard(b);
      const legal = E.candidateMoves(b, b.toPlay, ana);
      const stats = ai.evalMovesSync(b, 6.5, legal, 60, 220, (i * 7919 + 13) >>> 0, 14);
      const mv = ai.chooseAiMove(stats, level, rng, legal);
      if (mv < 0) { b.passTurn(); log.push('AI 停一手'); continue; }
      b.play(mv, b.toPlay);
      const lastHuman = log.filter(s => s.startsWith('人类')).slice(-1)[0] || '';
      log.push(`AI   ${show(mv)} [第${lineOf(E.xOf(mv), E.yOf(mv))}线]`);
    }
    b.toPlay = 3 - b.toPlay;
  }
  console.log('\n=== 对局过程（人类常规着法 vs AI）===');
  log.forEach(l => console.log('  ' + l));
  const aiMoves = log.filter(l => l.startsWith('AI'));
  const lines = aiMoves.map(l => parseInt(l.match(/第(\d)线/)[1], 10));
  const cnt = {};
  lines.forEach(l => cnt[l] = (cnt[l] || 0) + 1);
  console.log('\nAI 的线位分布:', JSON.stringify(cnt), '（1线最差，3/4线是主战场）');
}
