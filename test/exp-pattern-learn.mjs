/* 用自对弈给 3×3 模式的权重做一轮「经验学习」
 * 运行： node test/exp-pattern-learn.mjs [--positions 1200] [--plays 4] [--beta 1.2]
 *
 * 做法（简化版的 PGL 思路）：
 *   1. 用「引擎着法 + 随机着法」混合生成一批局面（覆盖开/中/官子）
 *   2. 对每个局面，随机抽若干候选着法；每个候选都从「落子之后」的局面
 *      跑 K 局模拟到终局，记录终局目差（行棋方视角，越大越好）
 *   3. 每个候选的「价值」= 它的终局目差 − 该局面所有被抽候选的平均值
 *      （减掉局面本身的底分，避免把「局面好」记成「这个形状好」）
 *   4. 按 3×3 模式（对称归一化后）累加价值 → 每个模式的平均价值
 *   5. 价值 → 权重：w = clamp(exp(beta × value) × 基准, 下限, 上限)
 *   6. 输出 js/pattern-weights.js（页面加载时覆盖内置的手工权重）
 *
 * 说明：这是「让模拟更聪明」的自我强化，不是真值学习 ——
 *       它把「在这个局面里更可能带来好结果」的局部形状挑出来，
 *       标签来自同一套模拟，所以不会引入外部偏差，但也不会突破模拟本身的天花板。
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
const { idx, xOf, yOf, BLACK, WHITE, EMPTY, Board } = E;

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const N_POS = parseInt(argOf('--positions', '1200'), 10);
const N_PLAYS = parseInt(argOf('--plays', '30'), 10);
const BETA = parseFloat(argOf('--beta', '0.3'));
const CAND_PER_POS = parseInt(argOf('--cands', '8'), 10);
const MIN_SAMPLES = parseInt(argOf('--min-samples', '5'), 10);

/* ---------- 1. 生成局面 ---------- */
console.log(`生成 ${N_POS} 个局面…`);
const positions = [];
{
  const rng = ai.makeRng(20261022);
  const t0 = Date.now();
  const genSeconds = parseInt(argOf('--gen-seconds', '150'), 10);
  let game = 0;
  while (positions.length < N_POS && (Date.now() - t0) / 1000 < genSeconds) {
    const b = new Board();
    const useEngine = (game % 2) === 0;      // 一半用引擎走（局面像真棋），一半随机（覆盖更广）
    const moves = [];
    for (let m = 0; m < 45; m++) {
      const color = b.toPlay;
      const cands = E.candidateMoves(b, color, E.analyzeBoard(b));
      if (!cands.length) break;
      let mv;
      if (useEngine) {
        const st = ai.evalMovesSync(b, 6.5, cands, 4, 15, 7000 + game * 37 + m * 29, 4, color === BLACK);
        mv = ai.chooseAiMove(st, ai.LEVELS[1], rng, cands);
      } else {
        mv = cands[(rng() * cands.length) | 0];
      }
      if (mv < 0) break;
      moves.push({ color: color === BLACK ? 'B' : 'W', p: mv });
      b.play(mv, color);
      b.toPlay = 3 - color;
    }
    game++;
    // 采样局面：开局/早中盘/中盘/官子各取一些
    for (const frac of [0.15, 0.4, 0.7, 0.95]) {
      const k = Math.min(moves.length - 1, Math.floor(moves.length * frac));
      if (k < 0) continue;
      positions.push(moves.slice(0, k + 1));
      if (positions.length >= N_POS) break;
    }
    if (game % 20 === 0) process.stdout.write(`\r  已生成 ${positions.length} 个局面（${game} 局）…`);
  }
  process.stdout.write('\n');
}
console.log(`  得到 ${positions.length} 个局面`);

/* ---------- 2. 给每个候选着法打分（从落子后的局面跑模拟） ---------- */
const patVal = new Map();      // 规范模式 → {sum, n}
const base = new Map();        // 规范模式 → 内置权重（用作基准）
for (let c = 0; c < ai.PAT_CODES; c++) base.set(c, ai.PAT_W[c]);

const rng = ai.makeRng(777);
let done = 0;
for (let pi = 0; pi < positions.length; pi++) {
  const moves = positions[pi];
  const b = new Board();
  for (const mv of moves) {
    const c = mv.color === 'B' ? BLACK : WHITE;
    b.play(mv.p, c);
    b.toPlay = 3 - c;
  }
  const color = b.toPlay;
  const cands = E.candidateMoves(b, color, E.analyzeBoard(b));
  if (cands.length < 4) continue;

  // 随机抽若干候选
  const sample = [];
  const used = new Set();
  for (let k = 0; k < CAND_PER_POS && used.size < cands.length; k++) {
    const i = (rng() * cands.length) | 0;
    if (used.has(i)) continue;
    used.add(i);
    sample.push(cands[i]);
  }
  if (sample.length < 3) continue;

  // 每个候选：从落子后的局面跑 N_PLAYS 局，记录终局目差（行棋方视角）
  const vals = [];
  for (const mv of sample) {
    const child = b.clone();
    if (!child.play(mv, color)) { vals.push(null); continue; }
    child.toPlay = 3 - color;
    let sum = 0;
    const r2 = ai.makeRng((pi * 7919 + mv * 131 + 17) >>> 0);
    for (let pl = 0; pl < N_PLAYS; pl++) {
      const sc = ai.simulate(child.clone(), r2, ai.SIM_OPTS);
      sum += (color === BLACK ? sc.black - sc.white : sc.white - sc.black);
    }
    vals.push(sum / N_PLAYS);
  }
  const okv = vals.filter(v => v !== null);
  if (okv.length < 3) continue;
  const mean = okv.reduce((a, c) => a + c, 0) / okv.length;

  for (let i = 0; i < vals.length; i++) {
    if (vals[i] === null) continue;
    const p = sample[i];
    const pat = ai.patternCode(b, p, color);
    const v = vals[i] - mean;
    const rec = patVal.get(pat) || { sum: 0, n: 0 };
    rec.sum += v; rec.n++;
    patVal.set(pat, rec);
  }
  done++;
  if (done % 100 === 0) console.log(`  已处理 ${done}/${positions.length} 局面…`);
}

/* ---------- 3. 价值 → 权重 ---------- */
console.log(`\n统计到 ${patVal.size} 个不同模式（被采样到的）`);
const rows = [];
for (const [pat, rec] of patVal) rows.push({ pat, v: rec.sum / rec.n, n: rec.n });
rows.sort((a, b) => b.v - a.v);
const reliable = rows.filter(r => r.n >= MIN_SAMPLES);
console.log(`其中样本数 ≥ ${MIN_SAMPLES} 的有 ${reliable.length} 个`);
console.log('最有价值的形状（样本够多的）：');
for (const r of reliable.slice(0, 8)) console.log(`  模式 ${r.pat}: 价值 ${r.v.toFixed(2)} 目（样本 ${r.n}）`);
console.log('最差的形状（样本够多的）：');
for (const r of reliable.slice(-5)) console.log(`  模式 ${r.pat}: 价值 ${r.v.toFixed(2)} 目（样本 ${r.n}）`);

// 权重 = 基准 × exp(beta × 价值)，夹在 [6, 60] 之间（放大 16 倍存整数）
const LO = 6, HI = 60;
const table = {};
let changed = 0;
for (const r of rows) {
  if (r.n < MIN_SAMPLES) continue;           // 样本太少的模式不动（否则就是拿噪声当信号）
  const w = Math.max(LO, Math.min(HI, Math.round(base.get(r.pat) * Math.exp(BETA * r.v))));
  if (w !== base.get(r.pat)) changed++;
  table[r.pat] = w;
}
console.log(`\n调整了 ${changed} 个模式的权重（共 ${rows.length} 个有样本，${reliable.length} 个达样本门槛）`);

/* ---------- 4. 输出 js/pattern-weights.js ---------- */
const out = path.join(ROOT, 'js', 'pattern-weights.js');
const body = `/* 自动生成：3×3 局部形状策略的权重（由 test/exp-pattern-learn.mjs 训练得到）
 * 生成时间：${new Date().toISOString()}
 * 训练数据：${positions.length} 个局面 × ${CAND_PER_POS} 候选 × ${N_PLAYS} 局模拟
 * 键是「对称归一化后的模式编号」，值是权重（放大 16 倍的整数）。
 * 没有出现在表里的模式沿用 ai.js 里的手工初始权重。
 */
(function (g) {
  const T = ${JSON.stringify(table)};
  const api = g.GO9 && g.GO9.ai;
  if (api && api.applyPatternWeights) api.applyPatternWeights(T);
})(typeof window !== 'undefined' ? window : globalThis);
`;
fs.writeFileSync(out, body, 'utf8');
console.log(`已写出：${out}`);
