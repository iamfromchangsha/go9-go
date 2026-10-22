/* ============================================================
 * 九路围棋 AI  —  ai.js
 *  - 随机模拟（局部战术 + 局部性启发）
 *  - MCTS 搜索（UCT + 根节点 Dirichlet 噪声）
 *  - 胜率评估（黑方视角）与形势差
 *  - 着法品质判定：妙手 / 好手 / 普通 / 俗手 / 恶手
 *  - 死活判定与终局计分
 * ------------------------------------------------------------
 * 依赖全局：GO9.engine
 * ============================================================ */
(function (global) {
  'use strict';

  const E = global.GO9.engine;
  const { N, AREA, EMPTY, BLACK, WHITE, BORDER, idx, xOf, yOf, NEI, areaScore } = E;

  /* ==================== 3×3 局部形状策略 ====================
   *
   * 为什么要它：蒙特卡洛评估的质量全看「模拟出来的棋局像不像真棋」。
   * 原来的模拟落子只有「贴己方棋 / 贴上一手 / 全局随机」三条粗规则，
   * 长出来的形状全是团块，模拟终局跟真实棋谱差得很远，评估的信噪比被拉低。
   * 经典 MC Go（PGL / Mogo）用「局部形状表」决定模拟该走哪一手，
   * 这是公认的棋力大杠杆。
   *
   * 本实现：
   *   · 模式 = 候选点周围 8 格的 3 态编码（空 / 我方 / 对方），base-3，6561 种；
   *   · 用 8 个对称（4 旋转 × 镜像）归一化 → 同一类形状只占一个编号；
   *   · 每个模式一个权重（权重表可被训练脚本覆盖，见 test/exp-pattern-learn.mjs）；
   *   · 模拟落子时按权重加权抽样，而不是纯随机。
   *
   * 权重规则是按围棋常识手写的（写在 initPatternWeights 里）：
   *   · 贴着自己的棋（延伸/连接）好；
   *   · 往对方厚势里钻、孤零零下一子差；
   *   · 「竹节」（两个对角是自己、中间两条正交不是自己）这种坏连接要罚。
   */

  const PAT_DX = [-1, 0, 1, -1, 1, -1, 0, 1];
  const PAT_DY = [-1, -1, -1, 0, 0, 1, 1, 1];
  const PAT_POW3 = [1, 3, 9, 27, 81, 243, 729, 2187];
  const PAT_CODES = 6561;                     // 3^8

  /** 每个点的 8 个邻居（含边框格，越界处指向边框格本身） */
  const PAT_NEI8 = new Int32Array(AREA * 8);
  for (let p = 0; p < AREA; p++) {
    const x = xOf(p), y = yOf(p);
    for (let i = 0; i < 8; i++) {
      const nx = x + PAT_DX[i], ny = y + PAT_DY[i];
      PAT_NEI8[p * 8 + i] = (nx < 0 || ny < 0 || nx >= N || ny >= N) ? p : idx(nx, ny);
    }
  }

  /** 8 个对称变换：perm[i] = 位置 i 变换后的新位置 */
  const PAT_PERM = (function () {
    const syms = [
      (x, y) => [x, y], (x, y) => [-y, x], (x, y) => [-x, -y], (x, y) => [y, -x],
      (x, y) => [-x, y], (x, y) => [x, -y], (x, y) => [y, x], (x, y) => [-y, -x]
    ];
    const out = [];
    for (const s of syms) {
      const perm = new Uint8Array(8);
      for (let i = 0; i < 8; i++) {
        const nx = s(PAT_DX[i], PAT_DY[i])[0], ny = s(PAT_DX[i], PAT_DY[i])[1];
        let j = 0;
        for (let k = 0; k < 8; k++) if (PAT_DX[k] === nx && PAT_DY[k] === ny) { j = k; break; }
        perm[i] = j;
      }
      out.push(perm);
    }
    return out;
  })();

  /** 归一化表：原始编码 → 对称等价类里的最小编码 */
  const PAT_CANON = new Uint16Array(PAT_CODES);
  (function buildCanon() {
    const d = new Uint8Array(8);
    for (let c = 0; c < PAT_CODES; c++) {
      let v = c;
      for (let i = 0; i < 8; i++) { d[i] = v % 3; v = (v / 3) | 0; }
      let best = c;
      for (const perm of PAT_PERM) {
        let t = 0;
        for (let i = 0; i < 8; i++) t += d[i] * PAT_POW3[perm[i]];
        if (t < best) best = t;
      }
      PAT_CANON[c] = best;
    }
  })();

  /** 模式权重表（放大 16 倍存整数，方便整数抽样；可被学习结果覆盖） */
  const PAT_W = new Uint8Array(PAT_CODES);

  /**
   * 按围棋常识给每个模式一个初始权重。
   * 规则只看 3×3 邻域（不含全局信息），所以是「局部形状」而不是「局面判断」。
   */
  function initPatternWeights() {
    const d = new Uint8Array(8);
    for (let c = 0; c < PAT_CODES; c++) {
      let v = c, f = 0, o = 0;
      for (let i = 0; i < 8; i++) { d[i] = v % 3; v = (v / 3) | 0; if (d[i] === 1) f++; else if (d[i] === 2) o++; }
      let w;
      if (f === 0) {
        // 周围没有自己的棋
        if (o === 0) w = 0.70;        // 空旷处：普通
        else if (o === 1) w = 0.60;    // 贴着对方的一子
        else w = 0.30;                // 往对方厚势里钻：差
      } else if (f === 1) {
        if (o === 0) w = 1.10;         // 干净地延伸
        else if (o === 1) w = 1.00;    // 一对一
        else w = 0.75;                 // 贴着对方：薄形
      } else {
        w = 1.80;                     // 连接/加固自己的棋：好
      }
      // 竹节（坏连接）：两个对角是自己，而夹在中间的两条正交邻居不是自己
      if (f >= 2 && ((d[0] === 1 && d[7] === 1 && d[1] !== 1 && d[3] !== 1) ||
                     (d[2] === 1 && d[5] === 1 && d[1] !== 1 && d[4] !== 1))) {
        w *= 0.45;
      }
      PAT_W[c] = Math.max(1, Math.round(w * 16));
    }
  }
  initPatternWeights();

  /**
   * 用训练出来的权重覆盖内置的手工权重。
   * @param table { 规范模式编号: 权重 }（权重是放大 16 倍的整数）
   * @returns 实际覆盖的模式个数
   */
  function applyPatternWeights(table) {
    if (!table) return 0;
    let n = 0;
    for (const k in table) {
      const pat = +k;
      if (!(pat >= 0 && pat < PAT_CODES)) continue;
      const w = table[k] | 0;
      if (w <= 0) continue;
      PAT_W[pat] = w > 255 ? 255 : w;
      n++;
    }
    return n;
  }

  /** 某个候选点的局部形状模式（相对行棋方：1=自己，2=对方，0=空/边框） */
  function patternCode(b, p, color) {
    const stones = b.stones;
    let code = 0;
    const base = p * 8;
    for (let i = 0; i < 8; i++) {
      const s = stones[PAT_NEI8[base + i]];
      const v = (s === EMPTY || s === BORDER) ? 0 : (s === color ? 1 : 2);
      code += v * PAT_POW3[i];
    }
    return PAT_CANON[code];
  }

  /** 局部形状权重（放大 16 倍的整数） */
  function patternWeight(b, p, color) {
    return PAT_W[patternCode(b, p, color)];
  }

  /** 加权抽样用的临时缓冲（避免每次分配） */
  const PAT_BUF = new Uint16Array(128);

  /**
   * 在候选点里按「局部形状权重」加权随机挑一个。
   * 这就是 3×3 策略的核心：模拟落子不再是均匀随机，而是偏向局部形状好的点。
   */
  function pickWeighted(cands, len, b, color, rng) {
    if (len <= 0) return -1;
    if (len === 1) return cands[0];
    const sum = fillPatternWeights(cands, len, b, color);
    return cands[pickByWeightIndex(len, sum, rng)];
  }

  /** 计算候选点的局部形状权重（写入 PAT_BUF），返回权重总和 */
  function fillPatternWeights(cands, len, b, color) {
    let sum = 0;
    for (let i = 0; i < len; i++) {
      const w = PAT_W[patternCode(b, cands[i], color)];
      PAT_BUF[i] = w;
      sum += w;
    }
    return sum;
  }

  /** 按 PAT_BUF 里的权重加权抽一个下标 */
  function pickByWeightIndex(len, sum, rng) {
    if (sum <= 0) return (rng() * len) | 0;
    let r = rng() * sum;
    for (let i = 0; i < len; i++) {
      r -= PAT_BUF[i];
      if (r <= 0) return i;
    }
    return len - 1;
  }

  /* ============================ RNG ============================ */
  function makeRng(seed) {
    return E.mulberry32((seed >>> 0) || 0x2545F491);
  }

  /* ==================== 局部合法性（快速） ==================== */

  /**
   * 落子后自身是否有气（保守估计，只用于筛选）。
   */
  function quickLegal(b, p, color) {
    if (b.stones[p] !== EMPTY) return false;
    if (p === b.ko) return false;
    const opp = 3 - color;
    let own = 0;
    const ns = NEI[p];
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      const s = b.stones[n];
      if (s === EMPTY) { own++; continue; }
      const g = E.groupStats(b, n);
      if (s === color) own += g.libs - 1;    // 该块的气里含有 p
      else if (g.libs === 1) return true;    // 可提子 → 必然合法
    }
    return own > 0;
  }

  /** l 点落下后能否让被打吃的棋块获得 2 口气（逃出） */
  function escapePoint(b, l) {
    let empty = 0;
    const ns = NEI[l];
    for (let i = 0; i < ns.length; i++) if (b.stones[ns[i]] === EMPTY) empty++;
    return empty >= 2;
  }

  /**
   * 局部战术着法（无需整盘分析，只看上一手周围的 4 个点）。
   * 提子必然合法；逃跑要求该点落下后能获得 2 口气。
   */
  function localTacticalFast(b, last, color) {
    if (last < 0) return -1;
    const opp = 3 - color;
    const ns = NEI[last];
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      if (b.stones[n] === opp) {
        const g = E.groupStats(b, n);
        if (g.libs === 1) {
          const cap = g.ata;
          if (cap >= 0 && cap !== b.ko) return cap;           // 提子
        }
      }
    }
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      if (b.stones[n] === color) {
        const g = E.groupStats(b, n);
        if (g.libs === 1) {
          const l = g.ata;
          if (l >= 0 && l !== last && l !== b.ko && escapePoint(b, l)) return l;  // 逃
        }
      }
    }
    return -1;
  }

  /** 一线点查表（0/1）：热路径上要查很多次，别每次都算坐标 */
  const FIRST_LINE = new Uint8Array(AREA);
  for (let p = 0; p < AREA; p++) {
    const x = xOf(p), y = yOf(p);
    if (x === 0 || y === 0 || x === N - 1 || y === N - 1) FIRST_LINE[p] = 1;
  }

  /** 该点是否在棋盘最外圈（一线） */
  function isFirstLine(p) {
    return FIRST_LINE[p] === 1;
  }

  /**
   * 这一手会不会把自己送进「只剩一口气」的状态（自杀手）。
   *
   * 为什么要禁：实测引擎自对弈 5.7% 的手是自杀手 —— 模拟里也经常这么下，
   * 于是「模拟出来的终局」根本不是棋谱该有的样子，评估的信噪比被拉低。
   *
   * 快速版（用于模拟热路径）：周围有 2 个以上空点就不可能是自杀手，
   * 只有「贴边/贴身」的少数点才去算连通块的气数。
   */
  function isSelfAtariMove(b, p, color) {
    const opp = 3 - color;
    const ns = NEI[p];
    // 第一遍只数空邻居（最便宜的读）：≥2 个空点就不可能是自杀手 —— 绝大多数情况
    let emptyN = 0;
    for (let i = 0; i < ns.length; i++) if (b.stones[ns[i]] === EMPTY) emptyN++;
    if (emptyN >= 2) return false;
    // 第二遍：只有「贴边/贴身」的少数点才去算连通块气数
    let friendMax = 0;
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      const s = b.stones[n];
      if (s === EMPTY) continue;
      if (s === opp) {
        const g = E.groupStats(b, n);
        if (g.libs === 1) return false;          // 能提子 → 不是自杀手
        continue;
      }
      const g = E.groupStats(b, n);
      if (g.libs > friendMax) friendMax = g.libs;
    }
    // 落子后这块的气 = 空邻居 + 己方邻块的气（p 被占掉一口）
    return (friendMax - 1) + emptyN <= 1;
  }

  /**
   * 精确版（用于选点层）：在已经落子后的棋盘上直接查连通块气数。
   * 「没提到子且只剩一口气」= 自杀手。
   */
  function isSelfAtariExact(child, mv, color, capsBefore) {
    if (child.caps[color] > capsBefore) return false;   // 提到了子，不算自杀
    const g = E.groupStats(child, mv);
    return g.libs <= 1;
  }

  /**
   * 这一手是不是下进了「自己的眼」里。
   *
   * 做法：把这一手拿掉，看它所在的空区是不是只被自己的子围住。
   * 下自己的眼是典型的浪费：眼位被填掉，既少了眼形，又给对方侵入的机会。
   * 实测引擎自对弈 6.2% 的手是「填自己的眼」。
   */
  function fillsOwnEye(child, mv, color) {
    const s = child.stones[mv];
    if (s !== color) return false;
    child.stones[mv] = EMPTY; child.toggle(mv, s);
    const seen = OWN_EYE.seen;
    seen.fill(0);
    const stack = OWN_EYE.stack;
    let sp = 0, size = 0, borderOpp = false;
    stack[sp++] = mv; seen[mv] = 1;
    while (sp > 0) {
      const c = stack[--sp];
      size++;
      const ns = NEI[c];
      for (let i = 0; i < ns.length; i++) {
        const n = ns[i];
        const st = child.stones[n];
        if (st === EMPTY) { if (!seen[n]) { seen[n] = 1; stack[sp++] = n; } }
        else if (st !== color) borderOpp = true;
      }
    }
    child.stones[mv] = s; child.toggle(mv, s);
    // 单点真眼由「自杀手」那条规则管；这里只管 ≥2 点的自己的空区
    return size >= 2 && !borderOpp;
  }

  const OWN_EYE = { seen: new Uint8Array(AREA), stack: new Int32Array(AREA) };
  const FRIENDLY_BUF = new Int32Array(AREA);

  /**
   * 在己方棋子附近落子：形成成片的阵势。
   * 这一条对评估质量很关键 —— 如果模拟里双方都乱下，早期着法对终局目数
   * 几乎没有影响，着法之间的真实差距（几个点）会被随机填盘的噪声淹没，
   * 评估就退化成"从一堆噪声里挑最大值"，于是候选点多的角上被系统性地高估。
   * 让模拟形成块状阵势后，终局归属更由前期着法决定，信噪比明显改善。
   */
  function pickNearFriendly(b, rng, color) {
    // 均匀随机挑一颗己方棋子。
    // 旧写法是「随机试 5 次，没命中就按索引顺序取第一颗」—— 那等于永远发展
    // 左上角：模拟出来的盘面系统性偏向左上，MC 估计因此带着方向性偏置。
    const own = FRIENDLY_BUF;          // 专用临时数组（避免和别的临时缓冲打架）
    let n = 0;
    for (let q = 0; q < AREA; q++) if (b.stones[q] === color) own[n++] = q;
    if (!n) return -1;
    const s = own[(rng() * n) | 0];

    const sx = xOf(s), sy = yOf(s);
    const bit = color === BLACK ? 1 : 2;
    // 这颗子所在的「线位」（离边多远）
    const sEdge = Math.min(sx, sy, N - 1 - sx, N - 1 - sy);
    // 只考虑不往边上退的落点：棋总是往中央长，
    // 否则一线一子会沿边线长成一整条带子，把面积计分撑爆（伪影）。
    // inwardGrow：贴边的棋要「往内线长」而不是「沿着边长」——
    // 实测旧规则下模拟终局里 66.5% 的子挤在一二线（线0 占 33.7%），
    // 蒙特卡洛因此天然认为「边上才是好地方」，引擎就一直往边上走。
    const minEdge = SIM_OPTS.inwardGrow ? Math.max(sEdge, 2) : (sEdge === 0 ? 1 : sEdge);
    const cands = [];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = sx + dx, y = sy + dy;
        if (x < 0 || y < 0 || x >= N || y >= N) continue;
        const p = idx(x, y);
        if (b.stones[p] !== EMPTY) continue;
        if (POOL.forbid[p] & bit) continue;
        if (Math.min(x, y, N - 1 - x, N - 1 - y) < minEdge) continue;
        cands.push(p);
      }
    }
    if (!cands.length) return -1;
    if (SIM_OPTS.pattern) {
      // 3×3 策略：按局部形状权重加权挑；挑到自杀手就把它权重清零再挑
      const sum = fillPatternWeights(cands, cands.length, b, color);
      for (let t = 0; t < 4; t++) {
        const i = pickByWeightIndex(cands.length, sum, rng);
        const p = cands[i];
        PAT_BUF[i] = 0;                        // 这个点不再参与后续抽样
        if (SIM_OPTS.noSelfAtari && isSelfAtariMove(b, p, color)) continue;
        if (quickLegal(b, p, color)) return p;
      }
      return -1;
    }
    // 旧路径：先随机挑，挑到自杀手就换一个（热路径上每手只查几次）
    for (let t = 0; t < 4; t++) {
      const p = cands[(rng() * cands.length) | 0];
      if (!SIM_OPTS.noSelfAtari || !isSelfAtariMove(b, p, color)) {
        if (quickLegal(b, p, color)) return p;
      }
    }
    return -1;
  }


  /* ========================= 随机模拟 ========================= */
  const SIM_OPTS = {
    tacticalProb: 0.88,   // 采用局部战术的概率
    friendlyProb: 0.55,   // 靠己方棋子形成阵势的概率
    localProb: 0.45,      // 靠近上一手的概率
    maxMoves: 170,        // 模拟手数上限
    rebuildEvery: 10,     // 每隔多少手重建一次合法点表
    // 以下两项用于消除模拟的「边缘引力」（实测旧行为让 MC 天然偏爱边）
    noEdge: true,         // 前期不许在一线落子
    edgeFreeEmpty: 34,    // 空点少于这个数时放开一线（收官阶段一线本来就要用）
    inwardGrow: true,     // 贴边的棋往内线长，不沿边长
    noSelfAtari: true,    // 模拟里不下自杀手（否则模拟出来的终局根本不像棋谱）
    pattern: true         // 3×3 局部形状策略：按局部形状权重抽样，而不是纯随机
  };


  // 模拟用临时缓冲（模拟不会嵌套，可安全复用）
  const POOL = {
    legal: [],                 // 候选点
    lpos: new Int32Array(AREA),// 候选点 → 下标
    near: [],
    forbid: new Uint8Array(AREA)   // 1=黑禁入, 2=白禁入（对手封闭的小目）
  };

  /**
   * 计算「封闭小目」：被单一颜色围住、且点数很少的空区。
   * 随机模拟时双方都不往里走 —— 一是对手不能倒回死形（捉子的价值才能被算清），
   * 二是自己不能填自己的眼（否则会白送目数）。这是蒙特卡洛围棋的经典启发式。
   */
  function computeForbidden(b, out) {
    const forbid = out || POOL.forbid;
    forbid.fill(0);
    const seen = POOL.seen || (POOL.seen = new Uint8Array(AREA));
    seen.fill(0);
    const stack = POOL.stack || (POOL.stack = new Int32Array(AREA));
    const region = POOL.region || (POOL.region = []);
    for (let p = 0; p < AREA; p++) {
      if (b.stones[p] !== EMPTY || seen[p]) continue;
      let sp = 0;
      stack[sp++] = p;
      seen[p] = 1;
      let size = 0, borderBlack = false, borderWhite = false;
      region.length = 0;
      while (sp > 0) {
        const c = stack[--sp];
        region.push(c);
        size++;
        const ns = NEI[c];
        for (let i = 0; i < ns.length; i++) {
          const n = ns[i];
          const s = b.stones[n];
          if (s === EMPTY) {
            if (!seen[n]) { seen[n] = 1; stack[sp++] = n; }
          } else if (s === BLACK) borderBlack = true;
          else if (s === WHITE) borderWhite = true;
        }
      }
      if (size > 5) continue;                     // 大空区不是「封闭小目」
      if (borderBlack !== borderWhite) {          // 只被一种颜色围住
        for (let i = 0; i < region.length; i++) forbid[region[i]] = 3;   // 黑白都不进
      }
    }
  }

  /** 重建合法点表 */
  function rebuildLegal(b, color) {
    const ana = E.analyzeBoard(b);
    const legal = POOL.legal, lpos = POOL.lpos;
    legal.length = 0;
    lpos.fill(-1);
    computeForbidden(b);
    for (let p = 0; p < AREA; p++) {
      if (b.stones[p] !== EMPTY) continue;
      if (!E.approxLegal(b, p, color, ana)) continue;
      lpos[p] = legal.length;
      legal.push(p);
    }
  }

  function legalRemove(p) {
    const legal = POOL.legal, lpos = POOL.lpos;
    const i = lpos[p];
    if (i < 0) return;
    const last = legal.pop();
    if (i < legal.length) { legal[i] = last; lpos[last] = i; }
    lpos[p] = -1;
  }

  function legalAdd(p) {
    const legal = POOL.legal, lpos = POOL.lpos;
    if (lpos[p] >= 0) return;
    lpos[p] = legal.length;
    legal.push(p);
  }

  /** 调试：统计模拟里各类落子分支的次数与线位分布（默认关闭） */
  const SIM_DEBUG = { on: false, branch: {}, lines: {}, bl: {} };
  function simDebugReset() {
    SIM_DEBUG.branch = { tactical: 0, friendly: 0, local: 0, global: 0, pass: 0 };
    SIM_DEBUG.lines = {};
    SIM_DEBUG.bl = {};
  }
  function simDebugNote(branch, p) {
    if (!SIM_DEBUG.on) return;
    SIM_DEBUG.branch[branch] = (SIM_DEBUG.branch[branch] || 0) + 1;
    if (p >= 0) {
      const d = Math.min(xOf(p), N - 1 - xOf(p), yOf(p), N - 1 - yOf(p));
      SIM_DEBUG.lines[d] = (SIM_DEBUG.lines[d] || 0) + 1;
      const key = branch;
      (SIM_DEBUG.bl[key] = SIM_DEBUG.bl[key] || {})[d] = (SIM_DEBUG.bl[key][d] || 0) + 1;
    }
  }

  /**
   * 从给定局面开始随机模拟到终局，返回 areaScore 结果。
   * 会修改传入的 b（调用方负责传副本）。
   */
  function simulate(b, rng, opts) {
    const O = opts || SIM_OPTS;
    let passes = 0, moves = 0, fails = 0, sinceRebuild = 0;

    rebuildLegal(b, b.toPlay);

    // 盘面剩余空点数（用于「前期不下一线」的判断）；落子减 1、提子加回
    let empty = 0;
    for (let p = 0; p < AREA; p++) if (b.stones[p] === EMPTY) empty++;
    // 一线是否已被禁止（前期禁止、收官放开）
    const edgeAllowed = () => !O.noEdge || empty <= O.edgeFreeEmpty;

    while (passes < 2 && moves < O.maxMoves) {
      const color = b.toPlay;
      const last = b.lastMove;
      const legal = POOL.legal;
      if (!legal.length) { b.passTurn(); passes++; continue; }

      let p = -1;
      let branch = '';
      // 1) 局部战术（最快路径：无需整盘分析）
      if (rng() < O.tacticalProb) {
        const t = localTacticalFast(b, last, color);
        if (t >= 0) { p = t; branch = 'tactical'; }
      }
      // 2) 靠己方棋子形成阵势（让早期着法真正影响终局，提升评估信噪比）
      if (p < 0 && rng() < O.friendlyProb) {
        p = pickNearFriendly(b, rng, color);
        if (p >= 0) branch = 'friendly';
      }
      // 3) 局部性：靠近上一手
      if (p < 0 && last >= 0 && rng() < O.localProb) {
        const lx = xOf(last), ly = yOf(last);
        // 前期不让「贴着上一手」把棋带到一线：上一手在中央时，
        // 回复若落在一线就会在边上滚雪球（实测这条分支贡献了 40% 的一线落子）。
        // 上一手本身就在一线时（对手下边、或者要救边上的棋）则允许。
        const banEdge = !edgeAllowed() && !isFirstLine(last);
        const near = POOL.near;
        near.length = 0;
        for (let i = 0; i < legal.length; i++) {
          const q = legal[i];
          if (POOL.forbid[q] & (color === BLACK ? 1 : 2)) continue;   // 不钻死形 / 不填自己的眼
          if (banEdge && isFirstLine(q)) continue;
          if (Math.abs(xOf(q) - lx) <= 2 && Math.abs(yOf(q) - ly) <= 2) near.push(q);
        }
        if (near.length) {
          p = -1;
          if (O.pattern) {
            // 3×3 策略：按局部形状权重加权挑（自杀手权重清零）
            const sum = fillPatternWeights(near, near.length, b, color);
            for (let t = 0; t < 4; t++) {
              const i = pickByWeightIndex(near.length, sum, rng);
              const q = near[i];
              PAT_BUF[i] = 0;
              if (O.noSelfAtari && isSelfAtariMove(b, q, color)) continue;
              p = q; break;
            }
          } else {
            // 旧路径：先随机挑，挑到自杀手就换一个（热路径上每手只查几次）
            const tries = Math.min(4, near.length);
            for (let t = 0; t < tries; t++) {
              const idx = (rng() * near.length) | 0;
              const q = near[idx];
              near.splice(idx, 1);
              if (!O.noSelfAtari || !isSelfAtariMove(b, q, color)) { p = q; break; }
            }
          }
          if (p < 0 && near.length) p = near[(rng() * near.length) | 0];
          if (p >= 0) branch = 'local';
        }
      }
      // 4) 全局随机（前期排除一线：真实棋局里一线几乎不会是「随手一着」）
      if (p < 0) {
        const bit = color === BLACK ? 1 : 2;
        const banEdge = !edgeAllowed();
        if (O.pattern) {
          // 3×3 策略：先均匀抽一批候选，再按局部形状权重加权挑
          // （抽子集而不是全盘算权重：全盘 80 个点的模式计算太贵）
          const sub = POOL.near;
          sub.length = 0;
          const tries = Math.min(12, legal.length);
          for (let k = 0; k < tries; k++) {
            const q = legal[(rng() * legal.length) | 0];
            if (POOL.forbid[q] & bit) { legalRemove(q); continue; }   // 剔出候选表
            if (banEdge && isFirstLine(q)) continue;                   // 一线：跳过（不剔出，收官还要用）
            sub.push(q);
          }
          if (sub.length) {
            const sum = fillPatternWeights(sub, sub.length, b, color);
            for (let t = 0; t < 4; t++) {
              const i = pickByWeightIndex(sub.length, sum, rng);
              const q = sub[i];
              PAT_BUF[i] = 0;
              if (O.noSelfAtari && isSelfAtariMove(b, q, color)) continue;
              p = q;
              break;
            }
          }
        }
        if (p < 0) {
          for (let k = 0; k < legal.length; k++) {
            const q = legal[(rng() * legal.length) | 0];
            if (POOL.forbid[q] & bit) { legalRemove(q); continue; }   // 剔出候选表
            if (banEdge && isFirstLine(q)) continue;                   // 一线：跳过（不剔出，收官还要用）
            p = q;
            break;
          }
        }
        // 全盘只剩一线可下时（极少见）→ 放开一线
        if (p < 0 && banEdge) {
          for (let k = 0; k < legal.length; k++) {
            const q = legal[(rng() * legal.length) | 0];
            if (POOL.forbid[q] & bit) { legalRemove(q); continue; }
            p = q;
            break;
          }
        }
        branch = 'global';
      }
      simDebugNote(branch, p);

      if (p === b.ko) { legalRemove(p); continue; }      // 劫点不能下
      if (p < 0) { b.passTurn(); passes++; continue; }
      if (!b.play(p, color)) {                            // 候选表偶尔过期
        legalRemove(p);
        if (++fails > 6) { fails = 0; b.passTurn(); passes++; }
        continue;
      }
      fails = 0;
      legalRemove(p);
      for (const c of b.lastCaptured) legalAdd(c);        // 被提的点重新成为候选
      // 空点变化：落子占掉 1 个点，被提的子变回空点又加回来
      empty += b.lastCaptured.length - 1;
      b.toPlay = 3 - color;
      passes = 0; moves++;
      if (++sinceRebuild >= O.rebuildEvery) {
        sinceRebuild = 0;
        rebuildLegal(b, b.toPlay);
      }
    }
    return areaScore(b);
  }

  /* ============================ 价值 ============================ */
  /* 形势差 → 黑方胜率（0~1）。
   * σ=16 目：目差的不确定度约 10 目量级；贴目计入差值，
   * 因此均势局面（双方目数相同、贴目 6.5）黑方约 40%，符合直觉。 */
  const VALUE_SIGMA = 16;
  function valueFromMargin(margin) {
    return 1 / (1 + Math.exp(-margin / VALUE_SIGMA));
  }

  /* ============================ MCTS ============================ */
  class Node {
    constructor(move, parent, player, board) {
      this.move = move;
      this.parent = parent;
      this.player = player;        // 该节点轮到谁走
      this.board = board;
      this.children = new Map();   // move -> Node | null(已列为候选但未展开)
      this.visits = 0;
      this.w = 0;                  // 黑方视角累计价值
    }
  }

  function applyMove(board, p) {
    const b = board.clone();
    const c = b.toPlay;
    if (!b.play(p, c)) return null;
    b.toPlay = 3 - c;
    return b;
  }

  const TREE_FORBID = new Uint8Array(AREA);   // 搜索树专用（与模拟互不干扰）

  function expand(node) {
    const ana = E.analyzeBoard(node.board);
    // 与随机模拟保持同一套规则：双方都不填自己的眼、不钻对手的死形。
    // 否则搜索树会选出「往对手刚赢下的角里倒灌」这类现实中是恶手的应手，
    // 导致深层模拟污染评估、根节点着法排序失真。
    computeForbidden(node.board, TREE_FORBID);
    const bit = node.player === BLACK ? 1 : 2;
    const cands = E.candidateMoves(node.board, node.player, ana);
    for (const p of cands) {
      if (TREE_FORBID[p] & bit) continue;
      if (!node.children.has(p)) node.children.set(p, null);
    }
  }

  /** 父节点视角下，该子节点对应的黑方胜率 */
  function winProbFor(player, child) {
    const bw = child.w / child.visits;
    return player === BLACK ? bw : 1 - bw;
  }

  function uctSelect(node, cfg) {
    const logN = Math.log(Math.max(2, node.visits));
    let best = null, bestV = -Infinity;
    for (const [mv, ch] of node.children) {
      if (!ch || ch.visits === 0) continue;
      let v = winProbFor(node.player, ch) + cfg.c * Math.sqrt(logN / ch.visits);
      if (cfg.noise > 0 && cfg.noiseMap) {
        const nz = cfg.noiseMap.get(mv);
        if (nz !== undefined) v += nz * cfg.noise * 3.2;
      }
      if (v > bestV) { bestV = v; best = ch; }
    }
    return best;
  }

  function descend(root, cfg) {
    let node = root;
    for (;;) {
      if (node.children.size === 0) {
        expand(node);
        if (node.children.size === 0) return node;     // 无合法着法（终局）
      }
      let unexp = -1;
      for (const [mv, ch] of node.children) {
        if (ch === null) { unexp = mv; break; }
      }
      if (unexp >= 0) {
        const child = new Node(unexp, node, 3 - node.player, applyMove(node.board, unexp));
        node.children.set(unexp, child);
        return child;
      }
      const child = uctSelect(node, cfg);
      if (!child) return node;
      node = child;
    }
  }

  /** Dirichlet 噪声（根节点用）：近似 χ² 采样后归一化 */
  function dirichlet(map, size, alpha, rng) {
    const g = new Float32Array(size);
    let sum = 0;
    for (let i = 0; i < size; i++) {
      const u = Math.max(1e-6, rng());
      const v = Math.max(1e-6, rng());
      const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      const x = Math.max(1e-6, alpha * n * n);       // 近似 χ²(1)
      g[i] = x;
      sum += x;
    }
    const out = new Map();
    let i = 0;
    for (const k of map.keys()) { out.set(k, g[i++] / sum); }
    return out;
  }

  /**
   * 创建一次可分片执行的搜索。
   * 用法：const s = createSearch(board, cfg, rng); while(!s.step(500)) {...}
   */
  function createSearch(rootBoard, cfg, rng) {
    const root = new Node(-1, null, rootBoard.toPlay, rootBoard);
    expand(root);
    if (cfg.noise > 0) {
      cfg.noiseMap = dirichlet(root.children, root.children.size, cfg.noiseAlpha || 0.15, rng);
    }
    let done = 0;
    // 预算兜底：cfg.playouts 缺失/非数会让 target 变成 undefined，
    // 而 Math.min(undefined, …) = NaN → 循环体一次都不执行 → step() 永远返回 false
    // → 调用方的 while(!s.step(n)) {} 变成死循环。
    const target = (typeof cfg.playouts === 'number' && cfg.playouts > 0) ? cfg.playouts : 1000;

    function step(budget) {
      const end = Math.min(target, done + budget);
      while (done < end) {
        const node = descend(root, cfg);
        const sim = simulate(node.board.clone(), rng, cfg.sim || SIM_OPTS);
        const margin = sim.black - sim.white - cfg.komi;
        const v = valueFromMargin(margin);
        let n = node;
        while (n) { n.visits++; n.w += v; n = n.parent; }
        done++;
      }
      return done >= target;
    }
    return { root, step, get done() { return done; }, get total() { return target; } };
  }

  /* ====================== 静态势力评估 ====================== */
  /**
   * 静态形势评估：把每个空区里的点，归给「离它最近的边界子所属的一方」。
   *  - 边界同色 → 整块算该色的地（已经围住的空地）
   *  - 边界异色 → 按最近边界子逐点划分（还没定下的势力）
   *
   * 为什么按空区逐点划分、而不是直接数「离某子几格内的点」：
   * 后者会因为中央的势力球体比角上大，而系统性地偏爱中央 ✗；
   * 按空区划分时每个空区的总分固定，不会有这种偏置 ✓。
   *
   * 返回「黑 − 白」的点数。纯静态、零随机噪声，是评估里的「骨架」。
   */
  const SS = {
    seen: new Uint8Array(AREA),
    stack: new Int32Array(AREA),
    region: [],
    stones: []
  };

  function staticScore(b) {
    const seen = SS.seen;
    seen.fill(0);
    const region = SS.region, stones = SS.stones;
    // 被打吃的棋块大概率是死子，死子不该有势力 → 它的距离要打折
    const ana = E.analyzeBoard(b);
    let black = 0, white = 0;

    for (let p = 0; p < AREA; p++) {
      if (b.stones[p] !== EMPTY || seen[p]) continue;

      // 1) 收集这个空区
      region.length = 0;
      let sp = 0;
      SS.stack[sp++] = p; seen[p] = 1;
      while (sp > 0) {
        const c = SS.stack[--sp];
        region.push(c);
        const ns = NEI[c];
        for (let i = 0; i < ns.length; i++) {
          const n = ns[i];
          if (b.stones[n] === EMPTY && !seen[n]) { seen[n] = 1; SS.stack[sp++] = n; }
        }
      }

      // 2) 找出包围这个空区的棋子（按颜色去重）
      stones.length = 0;
      let hasB = false, hasW = false;
      for (let i = 0; i < region.length; i++) {
        const ns = NEI[region[i]];
        for (let k = 0; k < ns.length; k++) {
          const s = b.stones[ns[k]];
          if (s === BLACK) { hasB = true; stones.push(ns[k]); }
          else if (s === WHITE) { hasW = true; stones.push(ns[k]); }
        }
      }
      if (!stones.length) continue;              // 整盘皆空（或无边界）

      // 3a) 边界只有一种颜色 → 这块空地已经归它了，整块计入
      if (hasB !== hasW) {
        if (hasB) black += region.length; else white += region.length;
        continue;
      }

      // 3b) 其余情况：只把「双方势力真正接触」的点算给近的一侧，
      //     远离某一方又没有另一方影响的点算中立。
      //     （否则开局只有几颗子时，整片空地都会被算给有子的一方 ✗）
      for (let i = 0; i < region.length; i++) {
        const c = region[i];
        const cx = xOf(c), cy = yOf(c);
        let dB = 99, dW = 99;
        for (let k = 0; k < stones.length; k++) {
          const s = stones[k];
          const d = Math.max(Math.abs(cx - xOf(s)), Math.abs(cy - yOf(s)));
          const dd = ana.libs[s] === 1 ? d + 3 : d;   // 被打吃 → 死子，势力打折
          if (b.stones[s] === BLACK) { if (dd < dB) dB = dd; }
          else { if (dd < dW) dW = dd; }
        }
        if (dB < dW) black++; else white++;
      }
    }
    return black - white;
  }

  /* ====================== 着法评估（配对模拟） ====================== */
  /** 直接模拟评估一个局面：跑 playouts 次随机模拟，返回平均终局目差与胜率。 */
  function evalPositionSync(board, komi, playouts, seed) {
    const rng = makeRng(seed);
    let sum = 0;
    for (let i = 0; i < playouts; i++) {
      const sc = simulate(board.clone(), rng, SIM_OPTS);
      sum += sc.black - sc.white - komi;
    }
    const margin = sum / playouts;      // 胜率只用纯蒙特卡洛（已验证与真实胜负一致率约 95%）
    return { winRate: valueFromMargin(margin), margin, playouts };
  }

  async function evalPositionAsync(board, komi, playouts, seed, onProgress) {
    const rng = makeRng(seed);
    let sum = 0;
    for (let i = 0; i < playouts; i++) {
      const sc = simulate(board.clone(), rng, SIM_OPTS);
      sum += sc.black - sc.white - komi;
      if (onProgress && i % 50 === 0) { onProgress(i / playouts); await yieldToUI(); }
    }
    const margin = sum / playouts;      // 胜率只用纯蒙特卡洛（已验证与真实胜负一致率约 95%）
    return { winRate: valueFromMargin(margin), margin, playouts };
  }

  /* ========================= 难度配置 ========================= */
  const LEVELS = [
    { key: 'l1', name: '入门', desc: '会吃子，常犯低级错误',
      bestP: 0.28, randomP: 0.30, temp: 0.030, topK: 6, playouts: 800 },
    { key: 'l2', name: '初级', desc: '基本不送吃，力战尚可',
      bestP: 0.48, randomP: 0.12, temp: 0.018, topK: 5, playouts: 1500 },
    { key: 'l3', name: '中级', desc: '有大局观，局部计算可靠',
      bestP: 0.70, randomP: 0.04, temp: 0.010, topK: 4, playouts: 2500 },
    { key: 'l4', name: '高级', desc: '计算准确，接近业余高段',
      bestP: 0.88, randomP: 0.0,  temp: 0.005, topK: 3, playouts: 4000 },
    { key: 'l5', name: '大师', desc: '全力搜索，很难占到便宜',
      bestP: 0.97, randomP: 0.0,  temp: 0.002, topK: 2, playouts: 6000 }
  ];

  /* ====================== 评估 / 分析搜索 ====================== */
  /** 旧的 MCTS 路径（analyzePosition 等）用的模拟预算；界面走的是混合评估，不用它 */
  const EVAL_PLAYOUTS = 2200;

  /** 把搜索树整理成统计信息（可中途调用，用于实时展示） */
  function summarize(root, komi) {
    const rootWR = root.visits ? root.w / root.visits : 0.5;
    // 访问次数少的候选点噪声大，用根节点胜率做先验做贝叶斯收缩
    const PRIOR = 10;
    const stats = new Map();
    let bestMove = -1, bestWR = -1;
    for (const [mv, ch] of root.children) {
      if (!ch || ch.visits === 0) continue;
      const wr = (ch.w + PRIOR * rootWR) / (ch.visits + PRIOR);   // 黑方胜率
      stats.set(mv, { wr, visits: ch.visits });
      if (wr > bestWR) { bestWR = wr; bestMove = mv; }
    }
    return { winRate: rootWR, scoreLead: estimateLead(rootWR, komi), bestMove, bestWR, stats, root };
  }

  /** 由胜率粗略反推形势差（点），用于显示 */
  function estimateLead(wr, komi) {
    const p = Math.min(0.995, Math.max(0.005, wr));
    const margin = VALUE_SIGMA * Math.log(p / (1 - p));
    return margin + komi;
  }

  /** 同步评估（Node 环境用） */
  function analyzePosition(board, komi, playouts, rng) {
    const cfg = { playouts, c: 0.95, noise: 0, komi, sim: SIM_OPTS };
    const s = createSearch(board, cfg, rng);
    while (!s.step(400)) { /* 跑完 */ }
    return summarize(s.root, komi);
  }

  /** 让出主线程，保证界面不卡。
   *  用 setTimeout 而非 requestAnimationFrame：后台标签页里 rAF 会被节流甚至暂停，
   *  会导致 AI 在页面不可见时卡住不动。 */
  function yieldToUI() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  /**
   * 异步评估：分片执行搜索，边算边回调进度。
   * onProgress(ratio, summary) —— summary 为当前（可能未完成）的统计
   */
  async function analyzePositionAsync(board, komi, playouts, rng, onProgress) {
    const cfg = { playouts, c: 0.95, noise: 0, komi, sim: SIM_OPTS };
    const s = createSearch(board, cfg, rng);
    for (;;) {
      const finished = s.step(220);
      if (onProgress) onProgress(s.done / s.total, summarize(s.root, komi));
      if (finished) break;
      await yieldToUI();
    }
    return summarize(s.root, komi);
  }

  /** 异步下 AI 一手（按难度） */
  async function playAiMoveAsync(board, komi, level, rng, onProgress) {
    const cfg = {
      playouts: level.playouts, c: 0.95,
      noise: level.noise, noiseAlpha: level.noiseAlpha,
      komi, sim: SIM_OPTS
    };
    const s = createSearch(board, cfg, rng);
    for (;;) {
      const finished = s.step(300);
      if (onProgress) onProgress(s.done / s.total);
      if (finished) break;
      await yieldToUI();
    }
    const ana = E.analyzeBoard(board);
    const legal = E.candidateMoves(board, board.toPlay, ana);
    const mv = chooseAiMove(summarize(s.root, komi).stats, level, rng, legal);
    return { move: mv, root: s.root, summary: summarize(s.root, komi) };
  }

  /**
   * 评估一批候选着法（两阶段：全体粗评 + 前几名精评）。
   * 关键：所有候选共用同一条随机序列（配对模拟），
   * 候选之间的差异主要来自着法本身，而不是随机填盘的运气。
   * 用生成器实现，同步与异步版本共用同一套逻辑。
   */
  /**
   * 两阶段评估：
   *   阶段一 全体候选「粗评」（样本数完全相同，不引入偏置）
   *   阶段二 对粗评靠前的候选「精评」到同样的最终样本数
   * 最终只用精评过的候选做排序与展示 —— 它们样本数一致，比较是公平的。
   */
  /**
   * 线位效率先验（单位：目）。分两段，各自有各自的淡出条件。
   *
   * ① 避边段（一线 −5 / 二线 −2.5）：
   *    「一线是废线」在任何阶段都成立，一直有效到收官（按剩余空点数淡出）。
   *    之前这条是按手数淡出（60 手后归零），而 9×9 的中盘正好落在 30~60 手，
   *    先验一撤，静态项的边缘偏好与模拟的边缘偏差联手把引擎推向边线。
   *
   * ② 开局偏好段（三线 +1 / 四线 +0.5）：
   *    「三线是主战场、中腹偏虚」是**开局棋理**，只在前十几手有效。
   *    之前它和避边段同生共死，于是中盘也被硬往内线塞 ——
   *    实测引擎 32 颗子里有 19 颗挤在内线 21 个点里，形状完全走样。
   *
   * @param empty   盘面剩余空点数
   * @param moveNum 已走手数
   */
  function linePrior(x, y, empty, moveNum) {
    const d = Math.min(x, y, 8 - x, 8 - y);       // 0 = 一线
    let v = 0;
    // ① 避边段
    const fEdge = priorFade(empty);
    if (fEdge > 0) {
      if (d === 0) v -= 5.0 * fEdge;
      else if (d === 1) v -= 2.5 * fEdge;
    }
    // ② 开局偏好段
    const fOpen = moveNum === undefined ? 1 : Math.max(0, 1 - moveNum / 16);
    if (fOpen > 0) {
      if (d === 2) v += 1.0 * fOpen;
      else if (d === 3) v += 0.5 * fOpen;
    }
    return v;
  }

  /** 先验强度：按盘面剩余空点数线性淡出 */
  function priorFade(empty) {
    let f = (empty - 4) / 16;
    if (f > 1) f = 1;
    if (f < 0) f = 0;
    return f;
  }

  /**
   * 标记「局部战」相关的点：被打吃到的棋块本身，以及它的最后一口气（吃子点 / 逃子点）。
   * 这些点上不施加线位先验（死活里二线三线反而是对的），其余位置照常生效。
   *
   * 范围必须收窄：旧写法是「打吃的棋块 + 它周围 8 个点」全部豁免。
   * 中盘里打吃的棋块一多（引擎自己下得糙，打吃本来就多），
   * 等于大半盘面都不受线位先验约束 —— 静态项的边缘偏好立刻占上风，
   * 引擎从中盘开始疯狂往边上下（实测中盘 83%、官子 80% 的手下一二线）。
   */
  const TACTICAL = new Uint8Array(AREA);
  function markTactical(b) {
    const ana = E.analyzeBoard(b);
    TACTICAL.fill(0);
    for (let p = 0; p < AREA; p++) {
      const s = b.stones[p];
      if (s !== BLACK && s !== WHITE) continue;    // 只看有子的点（空点的 libs 是陈旧值）
      if (ana.libs[p] !== 1) continue;
      TACTICAL[p] = 1;                             // 这块棋本身
      const g = E.groupStats(b, p);
      if (g.ata >= 0 && g.ata < AREA) TACTICAL[g.ata] = 1;   // 最后一口气：吃子点 / 逃子点
    }
    return TACTICAL;
  }


  /**
   * 静态势力项的权重：随盘面棋子数从 0 线性长到 1。
   *
   * 为什么要渐入：
   * staticScore 是「把空区按离哪颗边界子近来划分」的 Voronoi 划分。
   * 开局只有几颗子时，一颗子就能「占」住整片空地（实测增量高达 ±40 点），
   * 于是会出现两个荒谬后果：
   *   · 贴着对手的子下，能偷到最多的空地 → 引擎莫名其妙贴着对手下；
   *   · 在对手旁边的边上一线落子，能抢到对手角上的空地 → 引擎一直往边上走。
   * 实测三个局面里静态项的极差是 0 / 40 / 24 点，
   * 而 0.35×模拟项只有 1~2 点、线位先验只有 0.5~6 点 ——
   * 静态项把另外两项压成了噪声，引擎完全跟着 Voronoi 几何走。
   * 等盘面棋子多起来，划分才有真正的「势力」意义，权重就长到 1。
   */
  function staticWeightFor(b) {
    let n = 0;
    for (let p = 0; p < AREA; p++) {
      const s = b.stones[p];
      if (s === BLACK || s === WHITE) n++;
    }
    return Math.min(1, Math.max(0, (n - 4) / 12));
  }

  /** 是否启用静态项渐入（关掉＝旧行为，用于 A/B 对照实验） */
  let STATIC_RAMP = true;
  function setStaticRamp(on) { STATIC_RAMP = !!on; }
  function getStaticRamp() { return STATIC_RAMP; }

  /**
   * 混合评估值（唯一口径）。
   * margin 一律以「行棋方」为基准：sign=+1 黑走 / -1 白走。
   *   = 行棋方视角的(静态项×权重 + 0.35×模拟终局差) + 线位先验
   * 线位先验不乘 sign —— 它是「谁下这手谁吃亏」的行棋方相对惩罚。
   *
   * 静态项要过一道软上限（tanh）：它在有意义的局面里只有几目，
   * 但在「贴着对手棋子的那条边」上会飙到 5~7 目，把线位先验整个盖掉
   * （实测中盘二线静态 +5.00 vs 三线 +1.67，先验只有 ±1.7，压不住）。
   * 软上限保证它不越界，同时在正常幅度下几乎不改变数值。
   */
  function mixValue(rec, sign) {
    const sw = rec.sw === undefined ? 1 : rec.sw;
    const mc = rec.sum / rec.n;
    const stat = STATIC_CAP > 0 ? softCap(rec.stat || 0, STATIC_CAP) : (rec.stat || 0);
    return sign * (stat * sw + EVAL_MC_WEIGHT * mc) + (rec.prior || 0) + (rec.adj || 0);
  }

  /** 自杀手的确定性惩罚（单位：目）。不乘 sign —— 谁下这手谁吃亏。 */
  const SELF_ATARI_PENALTY = 4.0;
  /** 填自己眼的确定性惩罚（单位：目） */
  const OWN_EYE_PENALTY = 2.0;

  /** 软上限：x 很大时趋近 c，x 很小时几乎等于 x */
  function softCap(x, c) { return c * Math.tanh(x / c); }

  /** 静态项软上限（0 = 不限） */
  let STATIC_CAP = 3.0;
  function setStaticCap(c) { STATIC_CAP = Math.max(0, c || 0); }
  function getStaticCap() { return STATIC_CAP; }

  function* evalMovesGen(board, komi, moves, coarsePer, finePer, seed, refineTop, moverIsBlack) {
    const topK = refineTop || 20;
    const out = new Map();
    const rngs = new Map();
    const total = moves.length || 1;
    const sign = moverIsBlack === false ? -1 : 1;   // margin 一律以行棋方为基准
    // 局部战（打吃点及其周边）不施加线位先验
    const tactical = markTactical(board);
    // 静态项用「增量」：static(落子后) - static(落子前)
    // 这样开局那种「整片空地都算有子的一方」的巨大偏移会被抵消掉，
    // 而「提子赚了多少地」这类真正有意义的信号被保留下来。
    const staticBase = staticScore(board);
    // 开局阶段静态项失真 → 权重渐入（见 staticWeightFor 的说明）
    const sw = STATIC_RAMP ? staticWeightFor(board) : 1;
    // 线位先验按「剩余空点数」淡出（见 linePrior 的说明）
    let emptyCount = 0;
    for (let p = 0; p < AREA; p++) if (board.stones[p] === EMPTY) emptyCount++;
    const fade = priorFade(emptyCount);

    // 阶段一：全体粗评
    for (let i = 0; i < moves.length; i++) {
      const mv = moves[i];
      const child = applyMove(board, mv);
      if (!child) continue;
      const rng = makeRng(seed);
      rngs.set(mv, rng);
      const sum = evalOne(child, rng, coarsePer, komi);
      // 自杀手 / 填自己眼：确定性惩罚，不依赖有噪声的模拟值去发现
      let adj = 0;
      if (SIM_OPTS.noSelfAtari && isSelfAtariExact(child, mv, board.toPlay, board.caps[board.toPlay])) {
        adj = -SELF_ATARI_PENALTY * fade;
      } else if (fillsOwnEye(child, mv, board.toPlay)) {
        adj = -OWN_EYE_PENALTY * fade;
      }
      out.set(mv, { sum, n: coarsePer, stat: staticScore(child) - staticBase, sw, adj,
                   prior: tactical[mv] ? 0 : linePrior(xOf(mv), yOf(mv), emptyCount, board.moveNum) });
      if (i % 8 === 0) yield { ratio: (i / total) * 0.55, out: toStats(out, sign) };
    }

    // 阶段二：前 topK 名精评到 finePer 样本
    const top = pickTop(out, topK, sign);
    for (let i = 0; i < top.length; i++) {
      const [mv, rec] = top[i];
      const child = applyMove(board, mv);
      const rng = rngs.get(mv);
      if (!child || !rng) continue;
      const more = Math.max(0, finePer - rec.n);
      // 同一种子内的多次模拟高度相关（随机流相同），加样本收效有限，
      // 换种子才真正降噪：把精评样本分给多个种子。
      const per = Math.floor(more / REFINE_SEEDS.length);
      let sum = rec.sum, n = rec.n;
      for (const sd of REFINE_SEEDS) {
        sum += evalOne(child, makeRng(sd), per, komi);
        n += per;
      }
      out.set(mv, { sum, n, prior: rec.prior, stat: rec.stat, sw: rec.sw, adj: rec.adj });
      yield { ratio: 0.55 + (i / top.length) * 0.45, out: toStats(out, sign) };
    }

    // 只保留精评过的候选（样本数一致，比较公平）
    const final = new Map();
    for (const [mv] of top) if (out.has(mv)) final.set(mv, out.get(mv));
    return toStats(final, sign);
  }

  /** 混合评估：最终目差 = 静态势力分 + EVAL_MC_WEIGHT × 模拟终局差 + 线位先验
   *  蒙特卡洛有远见但噪声大（单次模拟标准差 ~28 目），静态评估零噪声但短视；
   *  权重越小，噪声越小，但越依赖静态项（越短视）。 */
  let EVAL_MC_WEIGHT = 0.35;          // 可标定：0 = 纯静态，1 = 纯模拟
  function setMcWeight(w) { EVAL_MC_WEIGHT = Math.max(0, Math.min(1, w)); }
  function getMcWeight() { return EVAL_MC_WEIGHT; }

  /** 精评阶段使用的多个随机种子（跨候选保持一致，保证可比） */
  const REFINE_SEEDS = [0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd3a2646c];

  /** 取当前评估最好的前 N 个候选（以行棋方为基准排序） */
  function pickTop(out, n, sign) {
    // 注意：必须按「含先验」的值排序，否则先验只能影响名次、无法把候选带进精评名单
    return [...out.entries()].sort((a, c) => mixValue(c[1], sign) - mixValue(a[1], sign)).slice(0, n);
  }

  /** 对单个候选做 n 次模拟，返回终局目差之和 */
  function evalOne(child, rng, n, komi) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const sc = simulate(child.clone(), rng, SIM_OPTS);
      sum += sc.black - sc.white - komi;
    }
    return sum;
  }

  /** 内部累计量 → 对外的胜率统计 */
  /**
   * 把累计量换算成统计量。
   * sign = +1（黑走）/ -1（白走）：margin 一律表示「对行棋方有多有利」，
   * 这样排序、选点、点评、线位先验的符号就全都自洽了，
   * 不会出现「轮到白走时，一二线先验反而在鼓励下边角线」这种方向性错误。
   * wr 则始终是「黑方胜率」，只用于界面显示。
   */
  function toStats(raw, sign) {
    const out = new Map();
    for (const [mv, rec] of raw) {
      const mcMargin = rec.sum / rec.n;                                   // 黑方视角的模拟终局差
      const wr = valueFromMargin(mcMargin);                              // 黑方胜率（显示用）
      const stat = rec.stat || 0;                                        // 静态势力增量（黑方视角）
      const prior = rec.prior || 0;                                      // 线位先验（行棋方视角）
      const adj = rec.adj || 0;                                          // 确定性战术调整（行棋方视角）
      const sw = rec.sw === undefined ? 1 : rec.sw;                       // 静态项权重
      const margin = mixValue(rec, sign);
      // 同时保留分解项，便于诊断「引擎为什么选这一手」
      out.set(mv, { wr, margin, mcMargin, stat, prior, adj, sw, visits: rec.n });
    }
    return out;
  }

  function evalMovesSync(board, komi, moves, coarsePer, finePer, seed, refineTop, moverIsBlack) {
    const g = evalMovesGen(board, komi, moves, coarsePer, finePer, seed, refineTop, moverIsBlack);
    let r = g.next();
    while (!r.done) r = g.next();
    return r.value;
  }

  async function evalMovesAsync(board, komi, moves, coarsePer, finePer, seed, onProgress, refineTop, moverIsBlack) {
    const g = evalMovesGen(board, komi, moves, coarsePer, finePer, seed, refineTop, moverIsBlack);
    for (;;) {
      const r = g.next();
      if (r.done) return r.value;
      if (onProgress) onProgress(r.value.ratio, r.value.out);
      await yieldToUI();
    }
  }

  /* 每一档难度下，一次局面分析的模拟预算：粗评样本数 / 精评最终样本数 / 精评候选数 */
  const EVAL_COARSE = { l1: 25, l2: 40, l3: 60, l4: 80, l5: 100 };
  const EVAL_FINE = { l1: 80, l2: 140, l3: 220, l4: 320, l5: 440 };
  const EVAL_REFINE = { l1: 10, l2: 12, l3: 14, l4: 16, l5: 18 };
  /** 局面自身胜率的评估次数 */
  const EVAL_POSITION = { l1: 150, l2: 250, l3: 400, l4: 600, l5: 800 };

  /* ===================== 着法品质（妙手/俗手） ==================== */
  const GRADES = {
    brilliant: { name: '妙手', desc: '比引擎算出的最佳着法还好', color: '#e9b949' },
    good:      { name: '好手', desc: '与最佳着法基本相当', color: '#57c98a' },
    ordinary:  { name: '普通', desc: '略有损失，可接受', color: '#93a3b5' },
    mundane:   { name: '俗手', desc: '明显不如最佳着法', color: '#e08a3c' },
    blunder:   { name: '恶手', desc: '严重失误，损失很大', color: '#e2564f' }
  };

  /**
   * 给玩家的某一手定性。
   * @param stats   着法评估结果
   * @param played  玩家下的一手
   * @param moverIsBlack 玩家是否执黑
   * @param noise   评估噪声带（概率单位，如 0.05 表示 ±5 个百分点）
   *
   * 蒙特卡洛评估本身有噪声，着法之间几十分点的差距未必是真差距。
   * 因此所有判定都按噪声带分级：差距落在噪声内就只说「与最佳着法相当」，
   * 绝不把统计噪声说成「恶手」。
   */
  function gradeMove(stats, played, moverIsBlack, bestMove, bestWR, noise, bestMargin) {
    const band = Math.max(0.012, noise || 0.045);
    const playedInfo = stats.get(played);
    if (!playedInfo) {
      return { grade: 'ordinary', delta: 0, playedWR: 0.5, bestMove, bestWR, band,
               note: '这一手未被评估覆盖' };
    }
    // 差距用「混合评估值」算（噪声小），并换算成胜率百分点
    const pMargin = (playedInfo.margin === undefined || !isFinite(playedInfo.margin)) ? 0 : playedInfo.margin;
    let bMargin = bestMargin;
    if (bMargin === undefined || bMargin === null || !isFinite(bMargin)) {
      bMargin = -Infinity;
      for (const [, inf] of stats) if (inf && inf.margin > bMargin) bMargin = inf.margin;
      if (!isFinite(bMargin)) bMargin = 0;
    }
    // margin 一律以「行棋方」为基准，所以两种颜色用同一个公式
    const raw = bMargin - pMargin;
    const delta = raw / VALUE_SIGMA;                 // 目差 → 胜率百分点
    const pWR = playedInfo.wr;
    const isBest = played === bestMove;
    // 与次优候选的差距要用「混合评估值」比，用模拟胜率比会被噪声带偏（假妙手）
    const gapToSecond = isBest ? (bMargin - secondBestMargin(stats, played)) : 0;
    const bandMargin = band * VALUE_SIGMA;        // 噪声带换算成目差单位
    let grade;
    if (delta <= -band) grade = 'brilliant';                 // 明显优于引擎的最佳着法
    else if (isBest && gapToSecond >= bandMargin * 4) grade = 'brilliant';  // 最佳且优势明显
    else if (delta <= band) grade = 'good';                  // 与最佳着法基本相当
    else if (delta <= band * 2) grade = 'ordinary';
    else if (delta <= band * 3.5) grade = 'mundane';
    else grade = 'blunder';
    return {
      grade, delta, playedWR: pWR, bestMove, bestWR, isBest, band,
      note: grade === 'brilliant' ? '这一手比引擎的最佳选择还好'
          : grade === 'good' ? '这一手和最佳着法效果相当'
          : grade === 'ordinary' ? '这一手略有损失，但影响不大'
          : grade === 'mundane' ? '这一手明显劣于最佳着法'
          : '这一手是明显的失误'
    };
  }

  /** 由模拟次数估算「着法差距」的噪声带（概率单位）
   *  实测：差距估计的平均误差 ≈ 60/√(每手模拟次数) 个百分点 */
  function noiseBandOf(perMove) {
    // 混合评估把蒙特卡洛的权重压到 EVAL_MC_WEIGHT，噪声同步缩小
    return Math.min(0.12, EVAL_MC_WEIGHT * 60 / Math.sqrt(Math.max(20, perMove)) / 100);
  }

  /** 次优候选的混合评估值 */
  function secondBestMargin(stats, exclude) {
    let s = -Infinity;
    for (const [mv, info] of stats) {
      if (mv === exclude || !info || info.margin === undefined) continue;
      if (info.margin > s) s = info.margin;
    }
    return isFinite(s) ? s : 0;
  }


  /* ==================== AI 选点（按难度） ==================== */
  /**
   * 从着法评估表里按难度选点。
   * stats 的 margin 一律是「对行棋方有多有利」✓ 所以直接取最大即可，
   * 不需要再关心黑/白——这正是之前搞反的地方：按黑方胜率排序，
   * AI 执白时等于专门挑对自己不利的一手，线位先验的方向也跟着反了。
   */
  function chooseAiMove(stats, level, rng, legalFallback) {
    const cands = [];
    for (const [mv, info] of stats) {
      if (!info || !info.visits) continue;
      cands.push({ mv, margin: info.margin, wr: info.wr, visits: info.visits });
    }
    if (!cands.length) return -1;

    // 低难度：有一定概率直接随机走一步（明显失误）
    if (level.randomP > 0 && rng() < level.randomP && legalFallback && legalFallback.length) {
      return legalFallback[(rng() * legalFallback.length) | 0];
    }

    // 按「对行棋方的有利程度」排序
    cands.sort((a, b) => b.margin - a.margin);
    // 以 bestP 的概率直接选最优着法；否则在前列候选里加权随机
    if (rng() < (level.bestP === undefined ? 0.7 : level.bestP)) return cands[0].mv;

    const pool = cands.slice(0, Math.max(2, level.topK));
    const maxM = pool[0].margin;
    const t = Math.max(0.002, level.temp);
    let sum = 0;
    for (const c of pool) { c.w = Math.exp((c.margin - maxM) / t); sum += c.w; }
    let r = rng() * sum;
    for (const c of pool) { r -= c.w; if (r <= 0) return c.mv; }
    return pool[0].mv;
  }

  /* ======================= 死活 / 终局计分 ======================= */
  /**
   * 通过多次随机模拟统计每个点的归属，推断死子并计算终局结果。
   */
  function finalScore(board, komi, sims, rng) {
    const blackOwn = new Float64Array(AREA);
    let sumMargin = 0;
    for (let i = 0; i < sims; i++) {
      const b = board.clone();
      const sc = simulate(b, rng, SIM_OPTS);
      sumMargin += sc.black - sc.white - komi;
      for (let p = 0; p < AREA; p++) if (sc.owner[p] === BLACK) blackOwn[p]++;
    }
    const ratio = new Float64Array(AREA);
    for (let p = 0; p < AREA; p++) ratio[p] = blackOwn[p] / sims;

    const dead = new Uint8Array(AREA);
    for (let p = 0; p < AREA; p++) {
      const s = board.stones[p];
      if (s !== BLACK && s !== WHITE) continue;
      if (s === BLACK && ratio[p] < 0.35) dead[p] = 1;
      else if (s === WHITE && ratio[p] > 0.65) dead[p] = 1;
    }
    const sc = areaScore(board, dead);
    const diff = sc.black - sc.white - komi;
    return {
      black: sc.black, white: sc.white, diff, dead, ratio,
      winRate: valueFromMargin(diff),
      avgMargin: sumMargin / sims
    };
  }

  /* ============================ 导出 ============================ */
  global.GO9.ai = {
    makeRng, simulate, SIM_OPTS,
    createSearch, analyzePosition, analyzePositionAsync, playAiMoveAsync,
    evalPositionSync, evalPositionAsync, evalMovesSync, evalMovesAsync,
    summarize, estimateLead, yieldToUI,
    valueFromMargin, chooseAiMove, gradeMove, secondBestMargin, noiseBandOf,
    staticScore, setMcWeight, getMcWeight, setStaticRamp, getStaticRamp, staticWeightFor,
    setStaticCap, getStaticCap, linePrior, mixValue, SIM_DEBUG, simDebugReset,
    patternCode, patternWeight, PAT_W, PAT_CANON, PAT_CODES, pickWeighted, applyPatternWeights,
    GRADES, LEVELS, EVAL_COARSE, EVAL_FINE, EVAL_REFINE, EVAL_POSITION,
    finalScore, quickLegal, localTacticalFast
  };
})(typeof window !== 'undefined' ? window : globalThis);
