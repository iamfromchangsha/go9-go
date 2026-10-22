/* 量化：各评估配置在「开局 16 手」里下到一线的频率
 * 运行： node test/diag-edge-open.mjs [种子数]
 *
 * 为什么要有这个脚本：「自对弈 16 手没有一手下在一线」是一条回归防线，
 * 但它只覆盖**一个种子**。评估权重一改，这一条防线就可能：
 *   ① 触发 → 可能是真的「往边上爬」回来了；
 *   ② 没触发 → 也可能只是那个种子碰巧没踩到。
 * 所以要横向量一遍：同一批种子、同一套评估预算，三个配置各跑一遍，
 * 看「多少局的开局出现一手一线」。
 *
 * 三个配置：
 *   v1.0.6 基准（git HEAD 的引擎，先验 ×1、MC 0.35）
 *   D：先验 ×0.5 + MC 0.35
 *   G：先验 ×0.5 + MC 0.6
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = parseInt(process.argv[2] || '20', 10);

const engineSrc = fs.readFileSync(path.join(ROOT, 'js/engine.js'), 'utf8');
const workSrc = fs.readFileSync(path.join(ROOT, 'js/ai.js'), 'utf8');
// 基准用固定的 tag（v1.0.6），不用 HEAD —— 否则提交一次基准就变了，量测不可复现
const BASE_REF = process.env.GO9_BASE_REF || 'v1.0.6';
let headSrc = null;
try { headSrc = execFileSync('git', ['show', `${BASE_REF}:js/ai.js`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 }); }
catch { console.warn(`（取不到基准 ${BASE_REF}，只跑工作区配置）`); }

function load(aiSrc) {
  const ctx = { console, Math, Date, JSON, Map, Set, Array, Object, Number, String, Boolean, Error, isFinite, parseInt, parseFloat };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(engineSrc, ctx);
  vm.runInContext(aiSrc, ctx);
  return ctx.GO9;
}

const CONFIGS = [];
if (headSrc) CONFIGS.push({ name: `v1.0.6 基准（先验×1, MC 0.35）`, src: headSrc });
CONFIGS.push({ name: 'D：先验×0.5 + MC 0.35        ', src: workSrc, prior: 0.5, mc: 0.35 });
CONFIGS.push({ name: 'G：先验×0.5 + MC 0.6         ', src: workSrc, prior: 0.5, mc: 0.6 });

console.log(`开局 16 手的一线频率（${N} 个种子，预算 粗评30/精评120/精化10，l5 难度）\n`);
for (const cfg of CONFIGS) {
  const GO9 = load(cfg.src);
  const { engine: E, ai } = GO9;
  if (cfg.prior !== undefined && ai.setPriorScale) ai.setPriorScale(cfg.prior);
  if (cfg.mc !== undefined) ai.setMcWeight(cfg.mc);
  const lineOf = p => Math.min(E.xOf(p), 8 - E.xOf(p), E.yOf(p), 8 - E.yOf(p));

  let gamesWithEdge = 0, edgeMoves = 0, totalMoves = 0;
  const byLine = {};
  for (let g = 0; g < N; g++) {
    const seed = 20261001 + g * 7919;
    const rng = ai.makeRng(seed);
    const b = new E.Board();
    let edge = 0;
    for (let m = 0; m < 16; m++) {
      const color = b.toPlay;
      const cands = E.candidateMoves(b, color, E.analyzeBoard(b));
      if (!cands.length) break;
      const st = ai.evalMovesSync(b, 6.5, cands, 30, 120, seed + m * 31, 10, color === E.BLACK);
      const mv = ai.chooseAiMove(st, ai.LEVELS[4], rng, cands);
      if (mv < 0) break;
      const d = lineOf(mv);
      totalMoves++;
      byLine[d] = (byLine[d] || 0) + 1;
      if (d === 0) { edge++; edgeMoves++; }
      b.play(mv, color);
      b.toPlay = 3 - color;
    }
    if (edge > 0) gamesWithEdge++;
  }
  const dist = Object.keys(byLine).sort((a, b) => a - b).map(d => `线${d}:${byLine[d]}`).join(' ');
  console.log(`${cfg.name}  ${gamesWithEdge}/${N} 局开局出现一线手（${edgeMoves}/${totalMoves} 手）  ${dist}`);
}
