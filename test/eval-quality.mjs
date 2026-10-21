/* 评估质量验证：引擎给的胜率，和真实结果一致吗？
 *
 * 做法：用「界面同款」的混合评估选点下棋，中途采样胜率估计，
 *      赛后用终局计分定胜负，统计一致率。
 *
 * 注意：早先这个脚本走的是已被界面弃用的 MCTS 路径，而且它引用了
 * LEVELS 里并不存在的 level.playouts，导致 createSearch 的预算为 undefined
 * → while(!s.step(800)){} 变成死循环（脚本会永远跑不完）。现在改成走界面同款管线。
 *
 * 运行： node test/eval-quality.mjs
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
const SAMPLE_EVERY = 5;
const EVAL_SIMS = 400;          // 采样局面胜率的模拟次数（纯 MC，与界面一致）
const COARSE = 30, FINE = 120, REFINE = 10;   // 选点用的评估预算（与界面同管线，缩小以提速）
const LEVEL = ai.LEVELS[1];     // 初级

let agree = 0, total = 0, absErr = 0;
const rows = [];
// 「胜率」与「终局目差」的相关系数与系统偏差 —— 比只看符号一致率更能说明问题
const pairs = [];

for (let g = 0; g < GAMES; g++) {
  const rng = ai.makeRng(1000 + g * 77);
  const b = new Board();
  const samples = [];

  for (let mv = 0; mv < 60; mv++) {
    const color = b.toPlay;
    const cands = E.candidateMoves(b, color, E.analyzeBoard(b));
    if (!cands.length) break;
    const stats = ai.evalMovesSync(b, KOMI, cands, COARSE, FINE, 5000 + g * 131 + mv * 17, REFINE, color === BLACK);
    const mv2 = ai.chooseAiMove(stats, LEVEL, rng, cands);
    if (mv2 < 0) break;
    b.play(mv2, color);
    b.toPlay = 3 - color;

    if (mv % SAMPLE_EVERY === 0) {
      const pos = ai.evalPositionSync(b, KOMI, EVAL_SIMS, ai.makeRng(90000 + g * 37 + mv));
      // 同时记下确定性静态分，用来比较两种信号谁更能预测终局
      samples.push({ mv, wr: pos.winRate, margin: pos.margin, stat: ai.staticScore(b) });
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
    pairs.push({ mc: smp.margin, stat: smp.stat, final: fs2.diff });
  }
  console.log(`第 ${g + 1} 局：终局 黑${fs2.black} : 白${fs2.white}（贴目 ${KOMI}），` +
    `黑${blackWon ? '胜' : '负'}，差 ${fs2.diff.toFixed(1)} 目，采样 ${samples.length} 次`);
}

console.log('\n采样明细（胜率为黑方）：');
for (const r of rows) console.log(`  第${r.game + 1}局 第${r.mv}手  胜率 ${(r.wr * 100).toFixed(1)}%  实际 ${r.blackWon ? '黑胜' : '白胜'}`);

console.log(`\n一致率：${agree}/${total} = ${(agree / total * 100).toFixed(1)}%` +
  `（n=${total}，95% 置信区间约 ±${(1.96 * Math.sqrt((agree / total) * (1 - agree / total) / total) * 100).toFixed(0)}pt）`);
console.log(`平均绝对误差：${(absErr / total * 100).toFixed(1)} 个百分点`);

/* ---- 信号质量：谁更能预测终局目差 ---- */
function corr(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, c) => a + c, 0) / n, my = ys.reduce((a, c) => a + c, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}
const fin = pairs.map(p => p.final);
const mc = pairs.map(p => p.mc);
const st = pairs.map(p => p.stat);
const mcBias = pairs.reduce((a, p) => a + (p.mc - p.final), 0) / pairs.length;
const stBias = pairs.reduce((a, p) => a + (p.stat - p.final), 0) / pairs.length;
console.log('\n=== 两种局面信号与「终局目差」的关系 ===');
console.log(`  纯蒙特卡洛目差：相关系数 ${corr(mc, fin).toFixed(3)}，平均偏差 ${mcBias.toFixed(1)} 目`);
console.log(`  静态势力分：    相关系数 ${corr(st, fin).toFixed(3)}，平均偏差 ${stBias.toFixed(1)} 目`);
// 静态分减掉贴目后也当目差用，比较两者的符号一致率
let mcAgree = 0, stAgree = 0;
for (const p of pairs) {
  if ((p.mc > 0) === (p.final > 0)) mcAgree++;
  if ((p.stat - KOMI > 0) === (p.final > 0)) stAgree++;
}
console.log(`  符号一致率：纯蒙特卡洛 ${(mcAgree / pairs.length * 100).toFixed(0)}%，静态分 ${(stAgree / pairs.length * 100).toFixed(0)}%`);
