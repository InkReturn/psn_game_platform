/**
 * 斗兽棋纯规则模块（服务端唯一裁决者，浏览器只用于展示）。
 *
 * 棋盘 9 行 × 7 列，坐标 row 0..8 / col 0..6，原点在左上角：
 * - 蓝方兽穴 (0,3)，红方兽穴 (8,3)；
 * - 蓝方陷阱 (0,2)(0,4)(1,3)，红方陷阱 (7,3)(8,2)(8,4)；
 * - 河流 行 3..5 × 列 1,2,4,5；
 * - 红方 8 枚棋子初始在 row 6..8，蓝方镜像在 row 0..2。
 *
 * 本模块没有任何 I/O 与随机性：同样的 (pieces, from, to) 永远得到同样的判定结果，
 * 因此服务端可以把它当作最终裁决依据，浏览器也可以拿它做"可走位置"提示。
 * 规则口径刻意与改造前 animal-chess.js 的本地实现逐条对齐，不新增/删减玩法。
 *
 * 本文件同时被 Node（require）与浏览器（<script> 同路径加载）使用：
 * 顶部不引用 window/document，浏览器侧只读取纯函数，不做任何 DOM 操作。
 */
"use strict";

/** 棋子等级表（数值越大越强）。 */
const RANKS = Object.freeze({ 鼠: 1, 猫: 2, 狗: 3, 狼: 4, 豹: 5, 虎: 6, 狮: 7, 象: 8 });

/** 棋子名称清单（按等级升序）。 */
const PIECE_NAMES = Object.freeze(["鼠", "猫", "狗", "狼", "豹", "虎", "狮", "象"]);

/** 棋盘尺寸。 */
const ROWS = 9;
const COLS = 7;

/** 双方阵营标识。 */
const SIDES = Object.freeze(["red", "blue"]);

/** 能跳河的棋子。 */
const RIVER_JUMPERS = Object.freeze(["虎", "狮"]);

/** 唯一能在河里停留/穿行的棋子。 */
const RIVER_SWIMMER = "鼠";

/** 初始棋子布局：[阵营, 名称, row, col]（与改造前 local 实现完全一致）。 */
const INITIAL_LAYOUT = Object.freeze([
  ["red", "狮", 8, 0],
  ["red", "虎", 8, 6],
  ["red", "狗", 7, 1],
  ["red", "猫", 7, 5],
  ["red", "鼠", 6, 0],
  ["red", "豹", 6, 2],
  ["red", "狼", 6, 4],
  ["red", "象", 6, 6],
  ["blue", "狮", 0, 6],
  ["blue", "虎", 0, 0],
  ["blue", "狗", 1, 5],
  ["blue", "猫", 1, 1],
  ["blue", "鼠", 2, 6],
  ["blue", "豹", 2, 4],
  ["blue", "狼", 2, 2],
  ["blue", "象", 2, 0],
]);

/**
 * 坐标是否在棋盘内。
 *
 * @param {number} row - 行号（0..8）。
 * @param {number} col - 列号（0..6）。
 * @returns {boolean} true 表示合法坐标。
 */
function inBounds(row, col) {
  return Number.isInteger(row) && Number.isInteger(col) && row >= 0 && row < ROWS && col >= 0 && col < COLS;
}

/**
 * 坐标归一化：把任何输入收敛成 {row, col} 整数或 null。
 *
 * @param {*} point - 形如 {row, col} 的任意输入。
 * @returns {{row: number, col: number}|null} 合法坐标或 null。
 */
function normalizePoint(point) {
  if (!point || typeof point !== "object") return null;
  const row = Number(point.row);
  const col = Number(point.col);
  if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
  if (!inBounds(row, col)) return null;
  return { row, col };
}

/**
 * 地形判定。
 *
 * @param {number} row - 行号。
 * @param {number} col - 列号。
 * @returns {"land"|"river"|"red-den"|"blue-den"|"red-trap"|"blue-trap"} 地形类型。
 */
function terrainAt(row, col) {
  // 1. 兽穴：蓝方在顶行中间，红方在底行中间。
  if ((row === 0 || row === ROWS - 1) && col === 3) return row === 0 ? "blue-den" : "red-den";
  // 2. 陷阱：围绕各自兽穴的四个格子。
  if (
    (row === 0 && (col === 2 || col === 4)) ||
    (row === 1 && col === 3) ||
    (row === ROWS - 2 && col === 3) ||
    (row === ROWS - 1 && (col === 2 || col === 4))
  ) {
    return row < 4 ? "blue-trap" : "red-trap";
  }
  // 3. 河流：中间三行的第 1/2/4/5 列。
  if (row >= 3 && row <= 5 && (col === 1 || col === 2 || col === 4 || col === 5)) return "river";
  return "land";
}

/**
 * 是否落在该阵营自己的兽穴。
 *
 * @param {string} side - 阵营（red/blue）。
 * @param {number} row - 行号。
 * @param {number} col - 列号。
 * @returns {boolean} true 表示是己方兽穴（规则上不可进入）。
 */
function isOwnDen(side, row, col) {
  return terrainAt(row, col) === `${side}-den`;
}

/**
 * 目标格是否属于"攻击方的敌方陷阱"（敌方棋子站进去等级归零）。
 *
 * @param {string} attackerSide - 攻击方阵营。
 * @param {number} row - 行号。
 * @param {number} col - 列号。
 * @returns {boolean} true 表示该格是攻击方的敌方陷阱。
 */
function isTrapFor(attackerSide, row, col) {
  return terrainAt(row, col) === `${attackerSide === "red" ? "blue" : "red"}-trap`;
}

/**
 * 生成初始棋子列表。
 *
 * @returns {Array<object>} 16 枚棋子的可序列化对象数组（全新对象，调用方可自由修改）。
 */
function createInitialPieces() {
  return INITIAL_LAYOUT.map(([owner, name, row, col]) => ({
    id: `${owner}-${name}-${row}-${col}`,
    owner,
    name,
    rank: RANKS[name],
    row,
    col,
    alive: true,
  }));
}

/**
 * 查找某格上的存活棋子。
 *
 * @param {Array<object>} pieces - 棋子列表。
 * @param {number} row - 行号。
 * @param {number} col - 列号。
 * @returns {object|null} 该格棋子，空格返回 null。
 */
function pieceAt(pieces, row, col) {
  return pieces.find((item) => item.alive && item.row === row && item.col === col) || null;
}

/**
 * 按 id 查找存活棋子。
 *
 * @param {Array<object>} pieces - 棋子列表。
 * @param {string} pieceId - 棋子 id。
 * @returns {object|null} 棋子或 null。
 */
function pieceById(pieces, pieceId) {
  return pieces.find((item) => item.alive && item.id === pieceId) || null;
}

/**
 * 统计某阵营存活棋子数。
 *
 * @param {Array<object>} pieces - 棋子列表。
 * @param {string} side - 阵营。
 * @returns {number} 存活数量。
 */
function aliveCount(pieces, side) {
  return pieces.filter((item) => item.alive && item.owner === side).length;
}

/**
 * 吃子判定（等级比较 + 鼠象特例 + 陷阱降级）。
 *
 * @param {object} attacker - 攻击方棋子（需含 owner/name/rank）。
 * @param {object} defender - 防守方棋子（需含 owner/name/rank）。
 * @param {number} row - 目标格行号（用于陷阱判定）。
 * @param {number} col - 目标格列号。
 * @returns {boolean} true 表示可以吃掉对方。
 */
function canCapture(attacker, defender, row, col) {
  // 1. 己方棋子永远不能吃。
  if (attacker.owner === defender.owner) return false;
  // 2. 鼠吃象特例：唯一允许低等级吃高等级的路径。
  if (attacker.name === "鼠" && defender.name === "象") return true;
  // 3. 象不能吃鼠。
  if (attacker.name === "象" && defender.name === "鼠") return false;
  // 4. 站在敌方陷阱里的棋子等级按 0 计算，任何棋子都能吃它。
  const effectiveRank = isTrapFor(attacker.owner, row, col) ? 0 : defender.rank;
  return attacker.rank >= effectiveRank;
}

/**
 * 计算单个方向的一步走法。
 *
 * @param {Array<object>} pieces - 棋子列表。
 * @param {object} piece - 待移动棋子。
 * @param {number} dr - 行方向增量。
 * @param {number} dc - 列方向增量。
 * @returns {{row: number, col: number}|null} 可走目标，非法返回 null。
 */
function stepTarget(pieces, piece, dr, dc) {
  const row = piece.row + dr;
  const col = piece.col + dc;
  // 1. 越界与己方兽穴：不能进入。
  if (!inBounds(row, col)) return null;
  if (isOwnDen(piece.owner, row, col)) return null;
  // 2. 河流：只有鼠能进入。
  if (terrainAt(row, col) === "river" && piece.name !== RIVER_SWIMMER) return null;
  // 3. 落点占用时按吃子规则判定。
  const occupant = pieceAt(pieces, row, col);
  if (!occupant) return { row, col };
  if (!canCapture(piece, occupant, row, col)) return null;
  return { row, col };
}

/**
 * 计算单个方向的跳河走法（仅虎/狮）。
 *
 * 规则：起点相邻格必须是河，沿该方向一路跳过连续河面，途中任意一格有鼠则禁止起跳，
 * 落点必须是河对岸的第一格（且不能是己方兽穴），落点有敌子时按吃子规则判定。
 *
 * @param {Array<object>} pieces - 棋子列表。
 * @param {object} piece - 待移动棋子。
 * @param {number} dr - 行方向增量。
 * @param {number} dc - 列方向增量。
 * @returns {{row: number, col: number}|null} 可跳目标，非法返回 null。
 */
function jumpTarget(pieces, piece, dr, dc) {
  // 1. 只有虎/狮能跳河。
  if (!RIVER_JUMPERS.includes(piece.name)) return null;
  let row = piece.row + dr;
  let col = piece.col + dc;
  // 2. 相邻格不是河就没有跳河这条走法。
  if (!inBounds(row, col) || terrainAt(row, col) !== "river") return null;
  // 3. 沿方向扫过整片河面：河里有鼠（任意一方）就挡住，不能跳。
  while (inBounds(row, col) && terrainAt(row, col) === "river") {
    if (pieceAt(pieces, row, col)?.name === RIVER_SWIMMER) return null;
    row += dr;
    col += dc;
  }
  // 4. 落点校验：必须还在棋盘内且不是己方兽穴。
  if (!inBounds(row, col)) return null;
  if (isOwnDen(piece.owner, row, col)) return null;
  const occupant = pieceAt(pieces, row, col);
  if (!occupant) return { row, col };
  if (!canCapture(piece, occupant, row, col)) return null;
  return { row, col };
}

/**
 * 计算某棋子的全部合法落点（去重）。
 *
 * @param {Array<object>} pieces - 棋子列表。
 * @param {object} piece - 待移动棋子。
 * @returns {Array<{row: number, col: number}>} 合法目标列表。
 */
function legalTargets(pieces, piece) {
  const result = [];
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const step = stepTarget(pieces, piece, dr, dc);
    if (step) result.push(step);
    const jump = jumpTarget(pieces, piece, dr, dc);
    if (jump) result.push(jump);
  }
  return result.filter((item, index, list) => list.findIndex((other) => other.row === item.row && other.col === item.col) === index);
}

/** 走法校验失败原因（服务端据此映射错误码与中文提示）。 */
const MoveRejection = Object.freeze({
  /** 游戏尚未开始。 */
  NOT_STARTED: "NOT_STARTED",
  /** 游戏已经结束。 */
  FINISHED: "FINISHED",
  /** 不是该玩家的回合。 */
  NOT_YOUR_TURN: "NOT_YOUR_TURN",
  /** 起点坐标非法。 */
  BAD_FROM: "BAD_FROM",
  /** 终点坐标非法。 */
  BAD_TO: "BAD_TO",
  /** 起点没有该玩家的棋子。 */
  NOT_YOUR_PIECE: "NOT_YOUR_PIECE",
  /** 目标不是这颗棋子的合法落点。 */
  ILLEGAL_TARGET: "ILLEGAL_TARGET",
});

/**
 * 走法校验（服务端最终裁决，纯函数）。
 *
 * @param {Array<object>} pieces - 当前棋子列表。
 * @param {object} params - {side, from, to, started, over, turn}。
 *   side: 发起方阵营（服务端按座位推导，不可由客户端声明）；
 *   from/to: 起终点坐标；
 *   started/over: 对局状态；turn: 当前该走的阵营。
 * @returns {{ok: true, piece: object, target: object, captured: object|null}}
 *          校验通过时返回移动棋子、目标格与被吃棋子（无吃子为 null）。
 * @returns {{ok: false, reason: string}} 校验失败时返回 MoveRejection 之一。
 */
function validateMove(pieces, params) {
  const { side, started, over, turn } = params;
  // 1. 对局状态。
  if (!started) return { ok: false, reason: MoveRejection.NOT_STARTED };
  if (over) return { ok: false, reason: MoveRejection.FINISHED };
  if (turn !== side) return { ok: false, reason: MoveRejection.NOT_YOUR_TURN };
  // 2. 坐标合法性（单独区分起点/终点，便于前端给准确提示）。
  const from = normalizePoint(params.from);
  if (!from) return { ok: false, reason: MoveRejection.BAD_FROM };
  const to = normalizePoint(params.to);
  if (!to) return { ok: false, reason: MoveRejection.BAD_TO };
  // 3. 起点必须是自己的棋子。
  const piece = pieceAt(pieces, from.row, from.col);
  if (!piece || piece.owner !== side) return { ok: false, reason: MoveRejection.NOT_YOUR_PIECE };
  // 4. 终点必须在合法落点集合里（涵盖吃子、河流、兽穴、陷阱等全部规则）。
  const legal = legalTargets(pieces, piece).some((item) => item.row === to.row && item.col === to.col);
  if (!legal) return { ok: false, reason: MoveRejection.ILLEGAL_TARGET };
  return { ok: true, piece, target: to, captured: pieceAt(pieces, to.row, to.col) };
}

/**
 * 胜负判定（在服务端执行完一次移动后调用）。
 *
 * 两条胜利条件与改造前本地实现一致：
 * 1. 进入敌方兽穴直接获胜；
 * 2. 吃光对方全部棋子获胜。
 *
 * @param {Array<object>} pieces - 移动后的棋子列表。
 * @param {string} moverSide - 本次移动方阵营。
 * @param {{row: number, col: number}} to - 落点。
 * @returns {{over: boolean, winner: string, reason: string}} winner 为 "" 表示未分胜负。
 */
function evaluateOutcome(pieces, moverSide, to) {
  // 1. 进入敌方兽穴。
  if (terrainAt(to.row, to.col) === `${moverSide === "red" ? "blue" : "red"}-den`) {
    return { over: true, winner: moverSide, reason: "den" };
  }
  // 2. 吃光对手。
  const opponent = moverSide === "red" ? "blue" : "red";
  if (aliveCount(pieces, opponent) === 0) {
    return { over: true, winner: moverSide, reason: "wipeout" };
  }
  return { over: false, winner: "", reason: "" };
}

/**
 * 坐标展示文案（与改造前 animal-chess.js 的 coordText 一致：字母为行、数字为列+1）。
 *
 * @param {number} row - 行号。
 * @param {number} col - 列号。
 * @returns {string} 形如 A1 的坐标文本。
 */
function coordText(row, col) {
  return `${String.fromCharCode(65 + row)}${col + 1}`;
}

/**
 * 阵营中文名。
 *
 * @param {string} side - 阵营标识。
 * @returns {string} "红方" / "蓝方"。
 */
function sideLabel(side) {
  return side === "red" ? "红方" : "蓝方";
}

/** 规则模块对外导出面（服务端 require 与浏览器全局共用同一份）。 */
const ANIMAL_CHESS_RULES = {
  RANKS,
  PIECE_NAMES,
  ROWS,
  COLS,
  SIDES,
  INITIAL_LAYOUT,
  MoveRejection,
  inBounds,
  normalizePoint,
  terrainAt,
  isOwnDen,
  isTrapFor,
  createInitialPieces,
  pieceAt,
  pieceById,
  aliveCount,
  canCapture,
  legalTargets,
  validateMove,
  evaluateOutcome,
  coordText,
  sideLabel,
};

// 1. Node 侧（服务端最终裁决者）。
if (typeof module !== "undefined" && module.exports) {
  module.exports = ANIMAL_CHESS_RULES;
}
// 2. 浏览器侧（只用于可走位置提示等展示逻辑，不参与裁决）。
if (typeof window !== "undefined") {
  window.AnimalChessRules = ANIMAL_CHESS_RULES;
}
