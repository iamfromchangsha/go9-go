/* 评估质量验证：引擎给的胜率，和真实结果一致吗？
 * 做法：引擎自对弈，中途采样胜率估计，赛后用终局计分定胜负，统计一致性。
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

const KOMI = 6.5;
const GAMES = 8;
const SAMPLE_EVERY = 8;
const EVAL_SIMS = 400;

let agree = 0, total = 0, absErr = 0;
const rows = [];

for (let g = 0; g < GAMES; g++) {
  const rng = ai.makeRng(1000 + g * 77);
  const b = new Board();
  b.hist = new Map(); b.trackSuperko = true; b.hist.set(b.hash(), true);
  const samples = [];

  for (let mv = 0; mv < 100; mv++) {
    // 该轮到谁，就用引擎走一手（入门强度，保证速度）
    const level = ai.LEVELS[0];
    const cfg = { playouts: level.playouts, c: 0.95, noise: 0, komi: KOMI, sim: ai.SIM_OPTS };
    const s = ai.createSearch(b, cfg, rng);
    while (!s.step(800)) { }
    const ana = E.analyzeBoard(b);
    const legal = E.candidateMoves(b, b.toPlay, ana);
    const mv2 = ai.chooseAiMove(s.root, level, rng, legal);
    if (mv2 < 0) break;
    b.play(mv2, b.toPlay);
    b.toPlay = 3 - b.toPlay;

    if (mv % SAMPLE_EVERY === 0) {
      const sum = ai.analyzePosition(b, KOMI, EVAL_SIMS, rng);
      samples.push({ mv, wr: sum.winRate });
    }
  }

  const fs2 = ai.finalScore(b, KOMI, 200, rng);
  const blackWon = fs2.diff > 0;
  for (const smp of samples) {
    const saidBlack = smp.wr > 0.5;
    if (saidBlack === blackWon) agree++;
    total++;
    absErr += Math.abs(smp.wr - (blackWon ? 1 : 0));
    rows.push({ game: g, mv: smp.mv, wr: smp.wr, blackWon });
  }
  console.log(`第 ${g + 1} 局：终局 黑${fs2.black} : 白${fs2.white}（贴目 ${KOMI}），` +
    `黑${blackWon ? '胜' : '负'}，差 ${fs2.diff.toFixed(1)} 目`);
}

console.log(`\n中途胜率与最终胜负一致率：${(agree / total * 100).toFixed(1)}%  (${agree}/${total})`);
console.log(`平均绝对误差：${(absErr / total * 100).toFixed(1)} 个百分点`);
console.log('\n抽样明细（wr = 引擎当时给的黑方胜率）：');
for (const r of rows.filter(r => r.mv % 24 === 0)) {
  console.log(`  第${r.game + 1}局 第${r.mv}手  wr=${(r.wr * 100).toFixed(1)}%  实际黑${r.blackWon ? '胜' : '负'}`);
}
