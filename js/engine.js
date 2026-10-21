/* ============================================================
 * 九路围棋引擎 (9x9 Go engine)  —  rules.js
 *  - 中国规则：数子法（面积计子），禁自杀
 *  - 简单劫 + 位置超级劫（Positional Superko）
 *  - 提子、连通块气数计算
 *  - 形势计算：随机模拟统计死活 → 面积计子
 * ------------------------------------------------------------
 * 全局命名空间：window.GO9
 * ============================================================ */
(function (global) {
  'use strict';

  const N = 9;                       // 棋盘 9 路
  const W = N + 2;                   // 带边框的宽度
  const AREA = W * W;

  const EMPTY = 0, BLACK = 1, WHITE = 2, BORDER = 3;

  /* ---- 邻接表（一次性构建） ---- */
  const NEI = new Array(AREA);
  for (let i = 0; i < AREA; i++) NEI[i] = [];
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (x > 0) NEI[p].push(y * W + (x - 1));
      if (x < W - 1) NEI[p].push(y * W + (x + 1));
      if (y > 0) NEI[p].push((y - 1) * W + x);
      if (y < W - 1) NEI[p].push((y + 1) * W + x);
    }
  }

  const idx = (x, y) => (y + 1) * W + (x + 1);
  const xOf = p => (p % W) - 1;
  const yOf = p => ((p / W) | 0) - 1;

  /* ---- Zobrist 哈希（52bit，用 Number 精确表示） ---- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const zr = mulberry32(0x5EED1729);
  const Z_LO = new Int32Array(AREA * 2);
  const Z_HI = new Int32Array(AREA * 2);
  for (let i = 0; i < AREA * 2; i++) {
    Z_LO[i] = (zr() * 4294967296) | 0;
    Z_HI[i] = ((zr() * 4294967296) | 0) & 0xFFFFF;   // 高位保留 20bit，总计 52bit
  }

  /* ---- 连通块工具（热路径专用，全程无分配） ---- */
  let gStampC = 0;
  const gStamp = new Int32Array(AREA);      // 连通块访问标记
  let lStampC = 0;
  const lStamp = new Int32Array(AREA);      // 气点去重标记
  const gStack = new Int32Array(AREA);
  const GROUP = { size: 0, libs: 0, ata: -1 };

  /**
   * 求 p 所在连通块的气数等统计，结果写入共享对象 GROUP。
   * GROUP.size = 块内棋子数；GROUP.libs = 去重后的气数；
   * GROUP.ata = 仅剩一口气时的那个气点（否则 -1）。
   * 注意：不可嵌套调用；返回值在下一次调用时被覆盖。
   */
  function groupStats(b, p) {
    const color = b.stones[p];
    gStampC++; lStampC++;
    let sp = 0;
    gStack[sp++] = p;
    gStamp[p] = gStampC;
    let size = 0, libs = 0, ata = -1;
    while (sp > 0) {
      const c = gStack[--sp];
      size++;
      const ns = NEI[c];
      for (let i = 0; i < ns.length; i++) {
        const n = ns[i];
        const s = b.stones[n];
        if (s === EMPTY) {
          if (lStamp[n] !== lStampC) {
            lStamp[n] = lStampC;
            libs++;
            ata = (libs === 1) ? n : -1;
          }
        } else if (s === color && gStamp[n] !== gStampC) {
          gStamp[n] = gStampC; gStack[sp++] = n;
        }
      }
    }
    GROUP.size = size; GROUP.libs = libs; GROUP.ata = ata;
    return GROUP;
  }

  /**
   * 移除 p 所在的整块棋子（提子），被提的棋子写入共享缓冲 CAPTURED。
   */
  function removeGroup(b, p, color) {
    gStampC++;
    let sp = 0;
    gStack[sp++] = p;
    gStamp[p] = gStampC;
    while (sp > 0) {
      const c = gStack[--sp];
      CAPTURED.push(c);
      b.stones[c] = EMPTY;
      b.toggle(c, color);
      const ns = NEI[c];
      for (let i = 0; i < ns.length; i++) {
        const n = ns[i];
        if (b.stones[n] === color && gStamp[n] !== gStampC) {
          gStamp[n] = gStampC; gStack[sp++] = n;
        }
      }
    }
  }

  /* 提子缓冲：play 不会递归，可共享复用 */
  const CAPTURED = [];

  /* ============================ Board ============================ */
  class Board {
    constructor() {
      this.stones = new Uint8Array(AREA);
      // 边框必须标记为 BORDER，否则角上的子会凭空多出两口气
      for (let y = 0; y < W; y++) {
        for (let x = 0; x < W; x++) {
          if (x === 0 || y === 0 || x === W - 1 || y === W - 1) this.stones[y * W + x] = BORDER;
        }
      }
      this.toPlay = BLACK;
      this.ko = -1;                 // 简单劫禁着点
      this.lo = 0; this.hi = 0;      // Zobrist
      this.caps = [0, 0, 0];
      this.lastMove = -1;
      this.moveNum = 0;
      this.passes = 0;
      this.hist = null;              // Map<hash,true> 超级劫表（仅根局面维护）
      this.trackSuperko = false;
      this.lastCaptured = CAPTURED;
    }

    clone() {
      const b = new Board();
      b.stones.set(this.stones);
      b.toPlay = this.toPlay;
      b.ko = this.ko;
      b.lo = this.lo; b.hi = this.hi;
      b.caps[1] = this.caps[1]; b.caps[2] = this.caps[2];
      b.lastMove = this.lastMove;
      b.moveNum = this.moveNum;
      b.passes = this.passes;
      b.hist = this.hist;
      b.trackSuperko = false;        // 搜索树/随机模拟内部不记录超级劫
      return b;
    }

    hash() { return this.hi * 4294967296 + (this.lo >>> 0); }

    toggle(p, c) {
      const i = p * 2 + (c - 1);
      this.lo ^= Z_LO[i];
      this.hi ^= Z_HI[i];
    }

    /**
     * 落子。成功返回 true 并更新局面；非法（占位/劫点/自杀/超级劫）返回 false 且局面保持不变。
     */
    play(p, color) {
      if (p < 0 || p >= AREA) return false;
      if (this.stones[p] !== EMPTY) return false;
      if (p === this.ko) return false;

      const opp = 3 - color;
      const captured = CAPTURED;
      captured.length = 0;

      this.stones[p] = color;
      this.toggle(p, color);

      // 提掉被吃掉的对方棋块
      for (let i = 0; i < NEI[p].length; i++) {
        const n = NEI[p][i];
        if (this.stones[n] === opp) {
          const g = groupStats(this, n);
          if (g.libs === 0) removeGroup(this, n, opp);
        }
      }

      // 自杀判定
      const own = groupStats(this, p);
      if (own.libs === 0) {
        this.stones[p] = EMPTY;
        this.toggle(p, color);
        for (let j = 0; j < captured.length; j++) {
          const s = captured[j];
          this.stones[s] = opp;
          this.toggle(s, opp);
        }
        return false;
      }

      // 超级劫判定
      const h = this.hash();
      if (this.trackSuperko && this.hist && this.hist.has(h)) {
        this.stones[p] = EMPTY;
        this.toggle(p, color);
        for (let j = 0; j < captured.length; j++) {
          const s = captured[j];
          this.stones[s] = opp;
          this.toggle(s, opp);
        }
        return false;
      }

      // 简单劫：只提一子，且落下的是孤零零一子且只有一口气
      let newKo = -1;
      if (captured.length === 1 && own.size === 1 && own.libs === 1) {
        newKo = captured[0];
      }

      this.ko = newKo;
      this.lastMove = p;
      this.moveNum++;
      this.passes = 0;
      this.caps[color] += captured.length;
      this.lastCaptured = captured;
      if (this.trackSuperko && this.hist) this.hist.set(h, true);
      return true;
    }

    playCurrent(p) {
      const c = this.toPlay;
      if (!this.play(p, c)) return false;
      this.toPlay = 3 - c;
      return true;
    }

    passTurn() {
      this.toPlay = 3 - this.toPlay;
      this.passes++;
      this.moveNum++;
      this.ko = -1;
      this.lastMove = -1;
      CAPTURED.length = 0;
      return true;
    }
  }

  /* ====================== 局面分析（气数表） ====================== */
  /* 共享缓冲：analyzeBoard 不会嵌套调用，可安全复用，避免每次分配 */
  let anaGen = 0;
  const anaSeen = new Int32Array(AREA);
  const anaLibs = new Int32Array(AREA);
  const anaAta = new Int32Array(AREA);    // 该块只剩一口气时的落点
  const ANA = { libs: anaLibs, ata: anaAta };

  /**
   * 一次性算出每个格子所在连通块的气数，供快速合法性判定使用。
   * 返回共享对象 ANA（内容在下一次调用时被覆盖，请勿长期持有）。
   */
  function analyzeBoard(b) {
    const gen = ++anaGen;
    for (let p = 0; p < AREA; p++) {
      const s = b.stones[p];
      if (s !== BLACK && s !== WHITE) continue;
      if (anaSeen[p] === gen) continue;
      const g = groupStats(b, p);
      const lc = g.libs, al = g.ata;
      // 再走一遍，把该块的统计写给每个成员（不产生数组分配）
      gStampC++;
      let sp = 0;
      gStack[sp++] = p;
      gStamp[p] = gStampC;
      while (sp > 0) {
        const c = gStack[--sp];
        anaSeen[c] = gen;
        anaLibs[c] = lc;
        anaAta[c] = al;
        const ns = NEI[c];
        for (let i = 0; i < ns.length; i++) {
          const n = ns[i];
          if (b.stones[n] === s && gStamp[n] !== gStampC) {
            gStamp[n] = gStampC; gStack[sp++] = n;
          }
        }
      }
    }
    return ANA;
  }

  /**
   * 快速合法性判定（保守：不会误杀合法着法，只可能放进个别非法着法）。
   * 用于生成候选着法；最终落子仍由 Board.play 精确判定。
   */
  function approxLegal(b, p, color, ana) {
    if (b.stones[p] !== EMPTY) return false;
    if (p === b.ko) return false;                 // 劫点禁着
    const opp = 3 - color;
    const libs = ana.libs;
    let own = 0;
    const ns = NEI[p];
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      const s = b.stones[n];
      if (s === EMPTY) own++;
      else if (s === color) own += libs[n] - 1;      // 该块的气里包含 p，落子后失去 p
      else if (s === opp && libs[n] === 1) return true; // 能提子 → 必然合法
    }
    return own > 0;
  }

  /** 生成候选着法（近似合法，够用） */
  function candidateMoves(b, color, ana) {
    const list = [];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const p = idx(x, y);
        if (b.stones[p] !== EMPTY) continue;
        if (approxLegal(b, p, color, ana)) list.push(p);
      }
    }
    return list;
  }

  /** 精确合法性：直接试一手（失败自动回滚，不污染超级劫表） */
  function isLegalMove(b, p, color) {
    const snapshot = { ko: b.ko, lastMove: b.lastMove, moveNum: b.moveNum };
    const capsBefore = b.caps[color];
    const ok = b.play(p, color);
    const hAfter = b.hash();               // 试一手之后的局面哈希
    if (!ok) {
      b.ko = snapshot.ko; b.lastMove = snapshot.lastMove; b.moveNum = snapshot.moveNum;
      b.caps[color] = capsBefore;
      return false;
    }
    // 回滚
    b.stones[p] = EMPTY; b.toggle(p, color);
    for (const s of b.lastCaptured) { b.stones[s] = 3 - color; b.toggle(s, 3 - color); }
    b.ko = snapshot.ko; b.lastMove = snapshot.lastMove; b.moveNum = snapshot.moveNum;
    b.caps[color] = capsBefore;
    // 精确删掉本次试写���的哈希：不能用 size 回退，否则会误删历史条目
    if (b.hist) b.hist.delete(hAfter);
    return true;
  }

  /* ============================ 计分 ============================ */
  /**
   * 面积计子。dead 为可选的死子标记（Uint8Array）。
   * 返回 { black, white, owner }，owner[p] = 归属色（EMPTY 表示无主/单官）
   */
  function areaScore(b, dead) {
    const state = new Uint8Array(AREA);
    for (let p = 0; p < AREA; p++) {
      const s = b.stones[p];
      if (s === BORDER) { state[p] = BORDER; continue; }
      if (s === EMPTY) { state[p] = EMPTY; continue; }
      if (dead && dead[p]) { state[p] = EMPTY; continue; }  // 死子按空点处理
      state[p] = s;
    }
    const owner = new Uint8Array(AREA);
    const seen = new Uint8Array(AREA);
    let black = 0, white = 0;
    for (let p = 0; p < AREA; p++) {
      const s = state[p];
      if (s === BLACK) { black++; owner[p] = BLACK; }
      else if (s === WHITE) { white++; owner[p] = WHITE; }
      else if (s === EMPTY && !seen[p]) {
        // flood fill 空区
        const stack = [p];
        seen[p] = 1;
        const region = [];
        let borderBlack = false, borderWhite = false;
        while (stack.length) {
          const c = stack.pop();
          region.push(c);
          const ns = NEI[c];
          for (let i = 0; i < ns.length; i++) {
            const n = ns[i];
            const ns2 = state[n];
            if (ns2 === EMPTY) {
              if (!seen[n]) { seen[n] = 1; stack.push(n); }
            } else if (ns2 === BLACK) borderBlack = true;
            else if (ns2 === WHITE) borderWhite = true;
          }
        }
        if (borderBlack && !borderWhite) {
          black += region.length;
          for (const c of region) owner[c] = BLACK;
        } else if (borderWhite && !borderBlack) {
          white += region.length;
          for (const c of region) owner[c] = WHITE;
        }
      }
    }
    return { black, white, owner };
  }

  /* ============================ 导出 ============================ */
  global.GO9 = global.GO9 || {};
  global.GO9.engine = {
    N, W, AREA, EMPTY, BLACK, WHITE, BORDER,
    NEI, idx, xOf, yOf,
    Board, groupStats, analyzeBoard, approxLegal, candidateMoves, isLegalMove, areaScore,
    mulberry32
  };
})(typeof window !== 'undefined' ? window : globalThis);
