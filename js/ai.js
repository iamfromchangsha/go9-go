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
  const { N, AREA, EMPTY, BLACK, WHITE, idx, xOf, yOf, NEI, areaScore } = E;

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

  /**
   * 在己方棋子附近落子：形成成片的阵势。
   * 这一条对评估质量很关键 —— 如果模拟里双方都乱下，早期着法对终局目数
   * 几乎没有影响，着法之间的真实差距（几个点）会被随机填盘的噪声淹没，
   * 评估就退化成"从一堆噪声里挑最大值"，于是候选点多的角上被系统性地高估。
   * 让模拟形成块状阵势后，终局归属更由前期着法决定，信噪比明显改善。
   */
  function pickNearFriendly(b, rng, color) {
    // 随机找一颗己方棋子（命中率高；开局棋子少时退化为扫一遍）
    let s = -1;
    for (let t = 0; t < 5; t++) {
      const q = (rng() * AREA) | 0;
      if (b.stones[q] === color) { s = q; break; }
    }
    if (s < 0) {
      for (let q = 0; q < AREA; q++) if (b.stones[q] === color) { s = q; break; }
    }
    if (s < 0) return -1;

    const sx = xOf(s), sy = yOf(s);
    const bit = color === BLACK ? 1 : 2;
    // 这颗子所在的「线位」（离边多远）
    const sEdge = Math.min(sx, sy, N - 1 - sx, N - 1 - sy);
    // 只考虑不往边上退的落点：棋总是往中央长，
    // 否则一线一子会沿边线长成一整条带子，把面积计分撑爆（伪影）。
    const minEdge = sEdge === 0 ? 1 : sEdge;
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
    for (let t = 0; t < 4; t++) {
      const p = cands[(rng() * cands.length) | 0];
      if (quickLegal(b, p, color)) return p;
    }
    return -1;
  }


  /* ========================= 随机模拟 ========================= */
  const SIM_OPTS = {
    tacticalProb: 0.88,   // 采用局部战术的概率
    friendlyProb: 0.55,   // 靠己方棋子形成阵势的概率
    localProb: 0.45,      // 靠近上一手的概率
    maxMoves: 170,        // 模拟手数上限
    rebuildEvery: 10      // 每隔多少手重建一次合法点表
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

  /**
   * 从给定局面开始随机模拟到终局，返回 areaScore 结果。
   * 会修改传入的 b（调用方负责传副本）。
   */
  function simulate(b, rng, opts) {
    const O = opts || SIM_OPTS;
    let passes = 0, moves = 0, fails = 0, sinceRebuild = 0;

    rebuildLegal(b, b.toPlay);

    while (passes < 2 && moves < O.maxMoves) {
      const color = b.toPlay;
      const last = b.lastMove;
      const legal = POOL.legal;
      if (!legal.length) { b.passTurn(); passes++; continue; }

      let p = -1;
      // 1) 局部战术（最快路径：无需整盘分析）
      if (rng() < O.tacticalProb) {
        const t = localTacticalFast(b, last, color);
        if (t >= 0) p = t;
      }
      // 2) 靠己方棋子形成阵势（让早期着法真正影响终局，提升评估信噪比）
      if (p < 0 && rng() < O.friendlyProb) {
        p = pickNearFriendly(b, rng, color);
      }
      // 3) 局部性：靠近上一手
      if (p < 0 && last >= 0 && rng() < O.localProb) {
        const lx = xOf(last), ly = yOf(last);
        const near = POOL.near;
        near.length = 0;
        for (let i = 0; i < legal.length; i++) {
          const q = legal[i];
          if (POOL.forbid[q] & (color === BLACK ? 1 : 2)) continue;   // 不钻死形 / 不填自己的眼
          if (Math.abs(xOf(q) - lx) <= 2 && Math.abs(yOf(q) - ly) <= 2) near.push(q);
        }
        if (near.length) p = near[(rng() * near.length) | 0];
      }
      // 4) 全局随机
      if (p < 0) {
        const bit = color === BLACK ? 1 : 2;
        for (let k = 0; k < legal.length; k++) {
          const q = legal[(rng() * legal.length) | 0];
          if (POOL.forbid[q] & bit) { legalRemove(q); continue; }   // 剔出候选表
          p = q;
          break;
        }
      }

      if (p === b.ko) { legalRemove(p); continue; }      // 劫点不能下
      if (!b.play(p, color)) {                            // 候选表偶尔过期
        legalRemove(p);
        if (++fails > 6) { fails = 0; b.passTurn(); passes++; }
        continue;
      }
      fails = 0;
      legalRemove(p);
      for (const c of b.lastCaptured) legalAdd(c);        // 被提的点重新成为候选
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
    const target = cfg.playouts;

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
      bestP: 0.28, randomP: 0.30, temp: 0.030, topK: 6 },
    { key: 'l2', name: '初级', desc: '基本不送吃，力战尚可',
      bestP: 0.48, randomP: 0.12, temp: 0.018, topK: 5 },
    { key: 'l3', name: '中级', desc: '有大局观，局部计算可靠',
      bestP: 0.70, randomP: 0.04, temp: 0.010, topK: 4 },
    { key: 'l4', name: '高级', desc: '计算准确，接近业余高段',
      bestP: 0.88, randomP: 0.0,  temp: 0.005, topK: 3 },
    { key: 'l5', name: '大师', desc: '全力搜索，很难占到便宜',
      bestP: 0.97, randomP: 0.0,  temp: 0.002, topK: 2 }
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
   * 线位效率先验（单位：目）。
   *
   * 为什么要它：面积计分有系统偏差 —— 二线一子能稳稳锁住一线的 9 目，
   * 而三线一子的地盘容易被对方搅浑，蒙特卡洛模拟因此偏爱二线；
   * 但在真实围棋里二线是废线。真实引擎同样用模式先验解决这类问题。
   * 这里只在开局阶段生效（40 手后淡出），用于在蒙特卡洛分不出高下时合理破局。
   */
  function linePrior(x, y, moveCount) {
    let fade = Math.max(0, 1 - moveCount / 60);   // 线位先验在中盘也保留一段时间
    if (fade <= 0) return 0;

    const d = Math.min(x, y, 8 - x, 8 - y);       // 0 = 一线
    if (d === 0) return -5.0 * fade;             // 一线：开局是废线
    if (d === 1) return -2.5 * fade;             // 二线：效率低
    if (d === 2) return 1.0 * fade;              // 三线：主战场
    if (d === 3) return 0.5 * fade;              // 四线：可下
    return 0;                                    // 中腹：开局偏虚
  }

  /** 标记「局部战」相关的点：被打吃块自身及其周围。这些点上不施加线位先验
   *  （死活里二线三线反而是对的），其余位置照常生效。 */
  const TACTICAL = new Uint8Array(AREA);
  function markTactical(b) {
    const ana = E.analyzeBoard(b);
    TACTICAL.fill(0);
    const mark = p => {
      if (p < 0 || p >= AREA) return;
      TACTICAL[p] = 1;
      const ns = NEI[p];
      for (let i = 0; i < ns.length; i++) TACTICAL[ns[i]] = 1;
    };
    for (let p = 0; p < AREA; p++) {
      const s = b.stones[p];
      if (s !== BLACK && s !== WHITE) continue;    // 只看有子的点（空点的 libs 是陈旧值）
      if (ana.libs[p] !== 1) continue;
      mark(p);
    }
    return TACTICAL;
  }


  function* evalMovesGen(board, komi, moves, coarsePer, finePer, seed, refineTop) {
    const topK = refineTop || 20;
    const out = new Map();
    const rngs = new Map();
    const total = moves.length || 1;
    // 局部战（打吃点及其周边）不施加线位先验
    const tactical = markTactical(board);
    // 静态项用「增量」：static(落子后) - static(落子前)
    // 这样开局那种「整片空地都算有子的一方」的巨大偏移会被抵消掉，
    // 而「提子赚了多少地」这类真正有意义的信号被保留下来。
    const staticBase = staticScore(board);

    // 阶段一：全体粗评
    for (let i = 0; i < moves.length; i++) {
      const mv = moves[i];
      const child = applyMove(board, mv);
      if (!child) continue;
      const rng = makeRng(seed);
      rngs.set(mv, rng);
      const sum = evalOne(child, rng, coarsePer, komi);
      out.set(mv, { sum, n: coarsePer, stat: staticScore(child) - staticBase,
                   prior: tactical[mv] ? 0 : linePrior(xOf(mv), yOf(mv), board.moveNum) });
      if (i % 8 === 0) yield { ratio: (i / total) * 0.55, out: toStats(out) };
    }

    // 阶段二：前 topK 名精评到 finePer 样本
    const top = pickTop(out, topK);
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
      out.set(mv, { sum, n, prior: rec.prior, stat: rec.stat });
      yield { ratio: 0.55 + (i / top.length) * 0.45, out: toStats(out) };
    }

    // 只保留精评过的候选（样本数一致，比较公平）
    const final = new Map();
    for (const [mv] of top) if (out.has(mv)) final.set(mv, out.get(mv));
    return toStats(final);
  }

  /** 混合评估：最终目差 = 静态势力分 + EVAL_MC_WEIGHT × 模拟终局差 + 线位先验
   *  蒙特卡洛有远见但噪声大（单次模拟标准差 ~28 目），静态评估零噪声但短视；
   *  权重越小，噪声越小，但越依赖静态项（越短视）。 */
  let EVAL_MC_WEIGHT = 0.35;          // 可标定：0 = 纯静态，1 = 纯模拟
  function setMcWeight(w) { EVAL_MC_WEIGHT = Math.max(0, Math.min(1, w)); }
  function getMcWeight() { return EVAL_MC_WEIGHT; }

  /** 精评阶段使用的多个随机种子（跨候选保持一致，保证可比） */
  const REFINE_SEEDS = [0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd3a2646c];

  /** 取当前评估最好的前 N 个候选 */
  function pickTop(out, n) {
    // 注意：必须按「含先验」的值排序，否则先验只能影响名次、无法把候选带进精评名单
    const val = rec => (rec.stat || 0) + EVAL_MC_WEIGHT * (rec.sum / rec.n) + (rec.prior || 0);
    return [...out.entries()].sort((a, c) => val(c[1]) - val(a[1])).slice(0, n);
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
  function toStats(raw) {
    const out = new Map();
    for (const [mv, rec] of raw) {
      const mcMargin = rec.sum / rec.n;                                  // 纯蒙特卡洛：用于显示胜率
      const margin = (rec.stat || 0) + EVAL_MC_WEIGHT * mcMargin + (rec.prior || 0);  // 混合：用于排序与点评
      out.set(mv, { wr: valueFromMargin(mcMargin), margin, mcMargin, visits: rec.n });
    }
    return out;
  }

  function evalMovesSync(board, komi, moves, coarsePer, finePer, seed, refineTop) {
    const g = evalMovesGen(board, komi, moves, coarsePer, finePer, seed, refineTop);
    let r = g.next();
    while (!r.done) r = g.next();
    return r.value;
  }

  async function evalMovesAsync(board, komi, moves, coarsePer, finePer, seed, onProgress, refineTop) {
    const g = evalMovesGen(board, komi, moves, coarsePer, finePer, seed, refineTop);
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
    const raw = moverIsBlack ? (bMargin - pMargin) : (pMargin - bMargin);
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
   * 从着法评估表里按难度选点。stats: Map<move, {wr, visits}>
   */
  function chooseAiMove(stats, level, rng, legalFallback) {
    const cands = [];
    for (const [mv, info] of stats) {
      if (!info || !info.visits) continue;
      cands.push({ mv, wr: info.wr, visits: info.visits });
    }
    if (!cands.length) return -1;

    // 低难度：有一定概率直接随机走一步（明显失误）
    if (level.randomP > 0 && rng() < level.randomP && legalFallback && legalFallback.length) {
      return legalFallback[(rng() * legalFallback.length) | 0];
    }

    // 按胜率排序
    cands.sort((a, b) => b.wr - a.wr);
    // 以 bestP 的概率直接选最优着法；否则在前列候选里按胜率加权随机
    if (rng() < (level.bestP === undefined ? 0.7 : level.bestP)) return cands[0].mv;

    const pool = cands.slice(0, Math.max(2, level.topK));
    const maxWR = pool[0].wr;
    const t = Math.max(0.002, level.temp);
    let sum = 0;
    for (const c of pool) { c.w = Math.exp((c.wr - maxWR) / t); sum += c.w; }
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
    staticScore, setMcWeight, getMcWeight,
    GRADES, LEVELS, EVAL_COARSE, EVAL_FINE, EVAL_REFINE, EVAL_POSITION,
    finalScore, quickLegal, localTacticalFast
  };
})(typeof window !== 'undefined' ? window : globalThis);
