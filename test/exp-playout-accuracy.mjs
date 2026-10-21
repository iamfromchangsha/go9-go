/* A/B：模拟策略改版前 vs 改版后，「胜率与真实胜负的一致率」有没有变化
 * 运行： node test/exp-playout-accuracy.mjs
 *
 * 控制变量：两边都用**随机合法着法**下棋（同一批种子 → 棋局完全相同），
 * 唯一变量是随机模拟（playout）策略本身 —— 改版前后模拟的落子分布不同，
 * 于是 evalPositionSync（纯 MC 胜率）与 finalScore（终局计分）都受影响。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* 从 git 里取出上一版引擎源码（用来做「改版前后」的对照） */
function gitShow(rel) {
  return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 });
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'go9-ab-'));
const OLD_AI = path.join(TMP, 'ai-old.js');
const OLD_ENGINE = path.join(TMP, 'engine-old.js');
fs.writeFileSync(OLD_AI, gitShow('js/ai.js'), 'utf8');
fs.writeFileSync(OLD_ENGINE, gitShow('js/engine.js'), 'utf8');

function load(aiFile, engineFile) {
  const ctx = { console, Math, Date, JSON, Map, Set, Array, Object, Number, String, Boolean, Error };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(engineFile, 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(aiFile, 'utf8'), ctx);
  return ctx.GO9;
}

const KOMI = 6.5, GAMES = 4, SAMPLE_EVERY = 6, EVAL_SIMS = 400;

function measure(GO9, label) {
  const { engine: E, ai } = GO9;
  const { Board, BLACK, WHITE } = E;
  let agree = 0, total = 0, absErr = 0;
  for (let g = 0; g < GAMES; g++) {
    const rng = ai.makeRng(1000 + g * 77);
    const b = new Board();
    const samples = [];
    for (let mv = 0; mv < 60; mv++) {
      const color = b.toPlay;
      const cands = E.candidateMoves(b, color, E.analyzeBoard(b));
      if (!cands.length) break;
      // 随机合法着法：两边棋局完全一致，唯一变量是模拟策略
      const mv2 = cands[(rng() * cands.length) | 0];
      b.play(mv2, color);
      b.toPlay = 3 - color;
      if (mv % SAMPLE_EVERY === 0) {
        const pos = ai.evalPositionSync(b, KOMI, EVAL_SIMS, ai.makeRng(90000 + g * 37 + mv));
        samples.push({ wr: pos.winRate });
      }
    }
    const fs2 = ai.finalScore(b, KOMI, 200, rng);
    const blackWon = fs2.diff > 0;
    for (const s of samples) {
      if ((s.wr > 0.5) === blackWon) agree++;
      total++;
      absErr += Math.abs(s.wr - (blackWon ? 1 : 0));
    }
    console.log(`  ${label} 第${g + 1}局：终局 黑${fs2.black}:白${fs2.white}，差 ${fs2.diff.toFixed(1)}，黑${blackWon ? '胜' : '负'}`);
  }
  console.log(`  ${label} → 一致率 ${agree}/${total} = ${(agree / total * 100).toFixed(1)}%，平均绝对误差 ${(absErr / total * 100).toFixed(1)}pt\n`);
  return { agree, total };
}

console.log('=== 模拟策略 A/B（棋局相同，只换模拟策略）===');
const oldGO9 = load(OLD_AI, OLD_ENGINE);
const newGO9 = load(path.join(ROOT, 'js/ai.js'), path.join(ROOT, 'js/engine.js'));
const oldR = measure(oldGO9, '旧模拟策略');
const newR = measure(newGO9, '新模拟策略');
console.log(`结论：旧 ${(oldR.agree / oldR.total * 100).toFixed(1)}%  vs  新 ${(newR.agree / newR.total * 100).toFixed(1)}%`);
