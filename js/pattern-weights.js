/* 3×3 局部形状策略的权重表
 *
 * 这个文件由 test/exp-pattern-learn.mjs 生成（自对弈训练）。
 * 现在是「空表」—— 引擎沿用 js/ai.js 里的手工初始权重。
 *
 * 训练结果目前**不建议启用**：实测自参照训练会把噪声当信号
 * （每个模式只有 5~15 个样本，价值的误差就有 ±1.6 目），
 * 覆盖的权重反而让胜率准确率从 65.6% 掉到 52.1%。
 * 真正要提升，得先让「好形状」的标签来自更强的对手（而不是引擎自己）。
 *
 * 键：对称归一化后的 3×3 模式编号（0..6560）
 * 值：权重（放大 16 倍的整数）
 */
(function (g) {
  const T = {};
  const api = g.GO9 && g.GO9.ai;
  if (api && api.applyPatternWeights) api.applyPatternWeights(T);
})(typeof window !== 'undefined' ? window : globalThis);
