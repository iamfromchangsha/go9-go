/* 3×3 局部形状策略的权重表
 *
 * 由 test/exp-pattern-train.mjs 用「自对弈 + 冻结判官」训练得到。
 * 训练参数：局面 1000，候选/局面 32，每候选判官评估 K=250 局，
 *           β=0.3，最少样本 20，收缩 0.2。
 * 标签来自 git HEAD 的冻结引擎（高样本 MC 评估），不是策略自己的模拟 ——
 * 自参照会把噪声当信号（第一版就是这么把胜率准确率从 65.6% 打到 52.1% 的）。
 *
 * 键：对称归一化后的 3×3 模式编号（0..6560）
 * 值：权重（放大 16 倍的整数）；未出现的模式沿用 js/ai.js 里的手工初始权重。
 *
 * ⚠️ **这张表通过了 G2（优于手工表 −0.46 目），但没通过 G1（引擎整体 −2.22 目），
 *    所以没有发布** —— 引擎默认仍用 js/ai.js 里的手工权重，且 `SIM_OPTS.pattern` 为 false。
 *    训练结果留档在 test/pattern-weights-trained.json，可随时复现与比对。
 *    详细数字与「为什么还换不来棋力」见 README 的 3×3 章节。
 *
 * 留档时间：2026-10-22
 */
(function (g) {
  const T = {};
  const api = g.GO9 && g.GO9.ai;
  if (api && api.applyPatternWeights) api.applyPatternWeights(T);
})(typeof window !== 'undefined' ? window : globalThis);
