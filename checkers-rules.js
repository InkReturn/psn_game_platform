/**
 * 跳棋（中国跳棋六角星棋盘）纯规则模块（服务端唯一裁决者，浏览器只用于展示与提示）。
 *
 * 规则口径与改造前 checkers.js 的客户端本地实现逐条对齐，不新增/删减玩法：
 * - 棋盘为 17 行六角星（starRows 共 121 格），格子用 {row, index} 寻址；
 * - 每位玩家一颗棋子，开局摆在各自区域的第一个格子上；
 * - 走法：走到相邻空格，或跳过一颗相邻棋子落到其正对面的空格（只允许一重跳）；
 * - 胜利：任一玩家的棋子到达自己的目标区域即获胜（单棋简化规则，沿用旧玩法）。
 *
 * 设计约束：
 * - 本文件没有任何 I/O、DOM 依赖与随机性，同样的 (state, input) 永远得到同样的结果；
 * - 同时被 Node（require）与浏览器（<script> 加载，暴露 window.CheckersRules）使用，
 *   服务端裁决与客户端"可落子位置"提示共用同一份实现，避免规则实现漂移成两份。
 */
"use strict";

/** 星形棋盘每行的格子数（六角星 17 行，共 121 格）。 */
const STAR_ROWS = Object.freeze([1, 2, 3, 4, 13, 12, 11, 10, 9, 10, 11, 12, 13, 4, 3, 2, 1]);

/** 邻接判定的距离阈值（归一化坐标系）。 */
const NEARBY_DISTANCE = 0.105;
/** 跳跃落点匹配的坐标容差（归一化坐标系）。 */
const JUMP_TOLERANCE = 0.035;
/** 邻接距离判定中 y 轴的视觉缩放（与旧实现保持一致，保证同一套几何口径）。 */
const NEARBY_Y_SCALE = 0.88;

/** 玩家颜色（按加入顺序分配前 N 个）。 */
const PLAYER_COLORS = Object.freeze(["red", "blue", "green", "gold", "purple", "orange"]);
/** 颜色的中文展示名（与颜色表一一对应）。 */
const COLOR_NAMES = Object.freeze({ red: "红方", blue: "蓝方", green: "绿方", gold: "黄方", purple: "紫方", orange: "橙方" });

/** 允许的玩家数范围。 */
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

/**
 * 计算某个格子所属的区域。
 *
 * @param {number} row - 行号（0..16）。
 * @param {number} index - 行内序号（0..该行格子数-1）。
 * @param {number} count - 该行格子总数。
 * @returns {string} 区域名（top/bottom/left/right/bottomLeft/bottomRight/center）。
 */
function regionFor(row, index, count) {
  if (row <= 3) return "top";
  if (row >= 13) return "bottom";
  if (row >= 4 && row <= 7 && index < 4 - (row - 4)) return "left";
  if (row >= 4 && row <= 7 && index >= count - (4 - (row - 4))) return "right";
  if (row >= 9 && row <= 12 && index < row - 8) return "bottomLeft";
  if (row >= 9 && row <= 12 && index >= count - (row - 8)) return "bottomRight";
  return "center";
}

/** 全部 121 个格子（含归一化坐标与区域标签），模块加载时一次性构建。 */
const STAR_CELLS = Object.freeze(
  (() => {
    const cells = [];
    STAR_ROWS.forEach((count, row) => {
      const start = (13 - count) / 2;
      for (let index = 0; index < count; index += 1) {
        cells.push({
          row,
          index,
          x: (start + index) / 12,
          y: row / 16,
          region: regionFor(row, index, count),
        });
      }
    });
    return cells;
  })(),
);

/**
 * 按区域取格子（每个区域最多 10 格，与旧实现一致）。
 *
 * @param {string} region - 区域名。
 * @returns {Array<object>} 该区域的格子列表。
 */
function cellsByRegion(region) {
  return STAR_CELLS.filter((cell) => cell.region === region).slice(0, 10);
}

/**
 * 六个座位的开局配置：颜色 -> 目标区域 + 出发区域。
 *
 * 目标区域是"正对面玩家的出发区域"（标准中国跳棋玩法）：
 * 红（下）奔上区、蓝（左）奔右区、绿（上）奔下区、金（右）奔左区，
 * 紫（左下）奔右下区、橙（右下）奔左下区。
 *
 * 注意：旧实现里 target 存的是颜色名（"green"/"gold"），而胜负判定比较的是
 * 区域名（"top"/"right"/...），两者永不相等，导致原版永远判不出胜负。
 * 本模块按原意改为存区域名，使"到达对面出发区获胜"真正生效。
 */
const START_CONFIGS = Object.freeze(
  [
    { color: "red", target: "top", cells: cellsByRegion("bottom") },
    { color: "blue", target: "right", cells: cellsByRegion("left") },
    { color: "green", target: "bottom", cells: cellsByRegion("top") },
    { color: "gold", target: "left", cells: cellsByRegion("right") },
    { color: "purple", target: "bottomRight", cells: cellsByRegion("bottomLeft") },
    { color: "orange", target: "bottomLeft", cells: cellsByRegion("bottomRight") },
  ].map((entry) => Object.freeze(entry)),
);

/**
 * 生成开局棋子位置（每位玩家一颗，摆在各自出发区域的第一个格子）。
 *
 * @param {number} count - 玩家数（2..6）。
 * @returns {Array<{color: string, row: number, index: number, target: string}>} 初始棋子数组。
 */
function createPieces(count) {
  return START_CONFIGS.slice(0, count).map((config) => {
    const cell = config.cells[0];
    return { color: config.color, row: cell.row, index: cell.index, target: config.target };
  });
}

/**
 * 取某个格子对象。
 *
 * @param {number} row - 行号。
 * @param {number} index - 行内序号。
 * @returns {object|null} 格子对象，不存在返回 null。
 */
function cellAt(row, index) {
  return STAR_CELLS.find((cell) => cell.row === row && cell.index === index) || null;
}

/**
 * 归一化坐标是否指向同一格。
 *
 * @param {{row: number, index: number}} a - 格子 A。
 * @param {{row: number, index: number}} b - 格子 B。
 * @returns {boolean} true 表示同一格。
 */
function sameCell(a, b) {
  return a.row === b.row && a.index === b.index;
}

/**
 * 某格当前是否被棋子占据。
 *
 * @param {Array<object>} pieces - 棋子数组（每颗含 row/index）。
 * @param {number} row - 行号。
 * @param {number} index - 行内序号。
 * @returns {boolean} true 表示有棋子。
 */
function occupied(pieces, row, index) {
  return pieces.some((piece) => piece.row === row && piece.index === index);
}

/**
 * 某格子的相邻空格与跳跃落点（走法生成的唯一入口）。
 *
 * 步骤与旧 checkers.js 的 legalTargets 完全一致：
 * 1. 相邻且为空 -> 可直接走；
 * 2. 相邻且被占 -> 检查其正对面延长线一格是否为空格，是则可跳。
 *
 * @param {Array<object>} pieces - 棋子数组。
 * @param {object} cell - 出发格子对象。
 * @returns {Array<{row: number, index: number}>} 全部合法落点。
 */
function moveTargets(pieces, cell) {
  const targets = [];
  STAR_CELLS.forEach((near) => {
    // 1. 计算与出发格的邻接距离（y 轴带视觉缩放，保持旧口径）。
    const dx = near.x - cell.x;
    const dy = (near.y - cell.y) * NEARBY_Y_SCALE;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= 0 || dist > NEARBY_DISTANCE) return;
    // 2. 相邻空格可直接走。
    if (!occupied(pieces, near.row, near.index)) {
      targets.push({ row: near.row, index: near.index });
      return;
    }
    // 3. 相邻格被占：找正对面延长线的落点（容差匹配），空则可跳。
    const jump = STAR_CELLS.find((candidate) => {
      const jx = candidate.x - cell.x;
      const jy = candidate.y - cell.y;
      return Math.abs(jx - (near.x - cell.x) * 2) < JUMP_TOLERANCE && Math.abs(jy - (near.y - cell.y) * 2) < JUMP_TOLERANCE;
    });
    if (jump && !occupied(pieces, jump.row, jump.index)) {
      targets.push({ row: jump.row, index: jump.index });
    }
  });
  return targets;
}

/**
 * 某颜色棋子的全部合法落点。
 *
 * @param {Array<object>} pieces - 棋子数组。
 * @param {string} color - 玩家颜色。
 * @returns {Array<{row: number, index: number}>} 合法落点列表；无此颜色棋子返回 []。
 */
function legalTargetsFor(pieces, color) {
  const piece = pieces.find((item) => item.color === color);
  if (!piece) return [];
  const cell = cellAt(piece.row, piece.index);
  if (!cell) return [];
  return moveTargets(pieces, cell);
}

/** 走法校验失败原因（服务端据此映射错误码）。 */
const MoveRejection = Object.freeze({
  NOT_STARTED: "NOT_STARTED",
  FINISHED: "FINISHED",
  NOT_YOUR_TURN: "NOT_YOUR_TURN",
  BAD_FROM: "BAD_FROM",
  NOT_YOUR_PIECE: "NOT_YOUR_PIECE",
  ILLEGAL_TARGET: "ILLEGAL_TARGET",
});

/**
 * 走法校验（状态、轮次、归属、目标一次性判定）。
 *
 * @param {object} params - 校验入参。
 * @param {Array<object>} params.pieces - 棋子数组。
 * @param {number} params.moverIndex - 发起操作的棋子下标（按玩家数组的座位下标）。
 * @param {number} params.turn - 当前轮到的棋子下标。
 * @param {{row: number, index: number}} params.from - 起点（操作者声称的己方棋子位置）。
 * @param {{row: number, index: number}} params.to - 终点。
 * @param {boolean} params.started - 对局是否已开始。
 * @param {boolean} params.over - 对局是否已结束。
 * @returns {{ok: true, to: {row:number,index:number}}|{ok: false, reason: string}} 校验结果。
 */
function validateMove({ pieces, moverIndex, turn, from, to, started, over }) {
  // 1. 状态校验。
  if (!started) return { ok: false, reason: MoveRejection.NOT_STARTED };
  if (over) return { ok: false, reason: MoveRejection.FINISHED };
  // 2. 轮次校验（先于归属校验，与其它权威房的拒绝顺序一致）。
  if (moverIndex !== turn) return { ok: false, reason: MoveRejection.NOT_YOUR_TURN };
  const mover = pieces[moverIndex];
  if (!mover) return { ok: false, reason: MoveRejection.NOT_YOUR_PIECE };
  // 3. 起点校验：坐标必须存在且确实是自己棋子的当前位置。
  if (!from || !Number.isInteger(from.row) || !Number.isInteger(from.index) || !cellAt(from.row, from.index)) {
    return { ok: false, reason: MoveRejection.BAD_FROM };
  }
  if (!sameCell(from, mover)) return { ok: false, reason: MoveRejection.NOT_YOUR_PIECE };
  // 4. 终点校验：必须在合法落点集合内。
  if (!to || !Number.isInteger(to.row) || !Number.isInteger(to.index)) {
    return { ok: false, reason: MoveRejection.ILLEGAL_TARGET };
  }
  const legal = moveTargets(pieces, cellAt(from.row, from.index)).some((target) => sameCell(target, to));
  if (!legal) return { ok: false, reason: MoveRejection.ILLEGAL_TARGET };
  return { ok: true, to: { row: to.row, index: to.index } };
}

/**
 * 应用一步走法（纯函数：返回新棋子数组，不修改入参）。
 *
 * 前置条件：调用方已通过 validateMove 校验。本函数只做推进与胜负判定。
 *
 * @param {Array<object>} pieces - 棋子数组。
 * @param {number} moverIndex - 走子棋子下标。
 * @param {{row: number, index: number}} to - 终点。
 * @returns {{pieces: Array<object>, won: boolean, nextTurn: number}} 推进结果；
 *   won 为 true 表示该棋子已到达目标区域。
 */
function applyMove(pieces, moverIndex, to) {
  // 1. 复制棋子数组并移动目标棋子。
  const next = pieces.map((piece, index) => (index === moverIndex ? { ...piece, row: to.row, index: to.index } : piece));
  // 2. 胜负判定：落点区域是否等于该棋子的目标区域。
  const cell = cellAt(to.row, to.index);
  const won = Boolean(cell && cell.region === next[moverIndex].target);
  // 3. 轮次推进（未分胜负时严格按座位顺序轮换）。
  const nextTurn = won ? moverIndex : (moverIndex + 1) % pieces.length;
  return { pieces: next, won, nextTurn };
}

/** 导出 API（Node 与浏览器共用）。 */
const api = {
  STAR_ROWS,
  STAR_CELLS,
  START_CONFIGS,
  PLAYER_COLORS,
  COLOR_NAMES,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MoveRejection,
  regionFor,
  cellsByRegion,
  createPieces,
  cellAt,
  sameCell,
  occupied,
  moveTargets,
  legalTargetsFor,
  validateMove,
  applyMove,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.CheckersRules = api;
