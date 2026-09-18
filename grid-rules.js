/**
 * 棋盘类小游戏的纯规则模块（服务端唯一裁决者，浏览器只用于展示与提示）。
 *
 * 覆盖三款棋子共用 8x8/3x3/6x7 网格的完全信息棋类：
 * - tictactoe 井字棋：3x3 连三；
 * - reversi  黑白棋：8x8 夹吃翻转，双方都无子可下时按子数结算；
 * - connect4 四子棋：6x7 按列下落，连四获胜。
 *
 * 设计约束：
 * - 本文件没有任何 I/O、DOM 依赖与随机性，同样的 (state, input) 永远得到同样的结果；
 * - 同时被 Node（require）与浏览器（<script> 同路径加载）使用，服务端裁决与客户端
 *   "可落子位置"提示共用同一份实现，避免规则实现漂移成两份；
 * - 规则口径与改造前 grid-game.js 的客户端本地实现逐条对齐，不新增/删减玩法。
 */
"use strict";

/** 格子取值：0 空 / 1 先手（黑/红） / 2 后手（白/黄）。 */
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

/** 八方向偏移（黑白棋夹吃与连线判定共用）。 */
const DIRECTIONS = Object.freeze([
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
  [-1, 0],
  [0, -1],
  [-1, -1],
  [-1, 1],
]);

/**
 * 三款游戏的棋型配置表（尺寸、连线长度、连四是否按列下落）。
 *
 * 这份配置是服务端与客户端共同的唯一来源：客户端渲染的棋盘尺寸、
 * 服务端校验的行列范围都从这里取，避免两边各写一份常量后失配。
 */
const GRID_GAMES = Object.freeze({
  tictactoe: Object.freeze({ key: "tictactoe", rows: 3, cols: 3, winLength: 3, gravity: false, prefix: "JZ" }),
  reversi: Object.freeze({ key: "reversi", rows: 8, cols: 8, winLength: 0, gravity: false, prefix: "HB" }),
  connect4: Object.freeze({ key: "connect4", rows: 6, cols: 7, winLength: 4, gravity: true, prefix: "SZ" }),
});

/** 对手颜色。
 * @param {number} color - BLACK 或 WHITE。
 * @returns {number} 另一方的颜色值。
 */
function opposite(color) {
  return color === BLACK ? WHITE : BLACK;
}

/**
 * 取棋型配置。
 *
 * @param {string} gameKey - 游戏标识（tictactoe / reversi / connect4）。
 * @returns {object|null} 配置对象；未注册的游戏返回 null。
 */
function configOf(gameKey) {
  return Object.prototype.hasOwnProperty.call(GRID_GAMES, gameKey) ? GRID_GAMES[gameKey] : null;
}

/**
 * 生成空棋盘。
 *
 * @param {object} config - 棋型配置。
 * @returns {number[][]} rows × cols 的全 0 二维数组。
 */
function createBoard(config) {
  return Array.from({ length: config.rows }, () => Array(config.cols).fill(EMPTY));
}

/**
 * 生成某一棋型的开局棋盘（黑白棋为四子交叉摆法，其余为空盘）。
 *
 * @param {object} config - 棋型配置。
 * @returns {number[][]} 开局棋盘。
 */
function createInitialBoard(config) {
  const board = createBoard(config);
  // 1. 只有黑白棋有初始摆子：中心四格黑白交叉。
  if (config.key !== "reversi") return board;
  const midR = config.rows / 2 - 1;
  const midC = config.cols / 2 - 1;
  board[midR][midC] = WHITE;
  board[midR][midC + 1] = BLACK;
  board[midR + 1][midC] = BLACK;
  board[midR + 1][midC + 1] = WHITE;
  return board;
}

/**
 * 坐标是否在棋盘内。
 *
 * @param {object} config - 棋型配置。
 * @param {number} row - 行号。
 * @param {number} col - 列号。
 * @returns {boolean} true 表示坐标合法。
 */
function inBounds(config, row, col) {
  return Number.isInteger(row) && Number.isInteger(col) && row >= 0 && col >= 0 && row < config.rows && col < config.cols;
}

/**
 * 归一化坐标输入。
 *
 * @param {object} config - 棋型配置。
 * @param {*} point - 形如 {row, col} 的任意输入。
 * @returns {{row:number,col:number}|null} 合法坐标或 null。
 */
function normalizePoint(config, point) {
  if (!point || typeof point !== "object") return null;
  const row = Number(point.row);
  const col = Number(point.col);
  if (!inBounds(config, row, col)) return null;
  return { row, col };
}

/**
 * 黑白棋：计算在 (row, col) 落 color 会被翻转的全部格子。
 *
 * @param {object} config - 棋型配置。
 * @param {number[][]} board - 当前棋盘。
 * @param {number} row - 落子行。
 * @param {number} col - 落子列。
 * @param {number} color - 落子方颜色。
 * @returns {Array<[number, number]>} 被翻转坐标列表；不合法时为空数组。
 */
function legalReversiFlips(config, board, row, col, color) {
  // 1. 目标格必须为空且在盘内。
  if (!inBounds(config, row, col) || board[row][col] !== EMPTY) return [];
  const opponent = opposite(color);
  const flips = [];
  // 2. 沿八方向收集"连续对方子后接自己子"的夹层。
  DIRECTIONS.forEach(([dr, dc]) => {
    const line = [];
    let r = row + dr;
    let c = col + dc;
    while (inBounds(config, r, c) && board[r][c] === opponent) {
      line.push([r, c]);
      r += dr;
      c += dc;
    }
    if (line.length && inBounds(config, r, c) && board[r][c] === color) flips.push(...line);
  });
  return flips;
}

/**
 * 当前局面下某一方的全部合法落子点。
 *
 * @param {object} config - 棋型配置。
 * @param {number[][]} board - 当前棋盘。
 * @param {number} color - 待判定的颜色。
 * @returns {Array<{row:number,col:number}>} 可落子坐标列表（非黑白棋返回空数组）。
 */
function legalMoves(config, board, color) {
  if (config.key !== "reversi") return [];
  const moves = [];
  for (let row = 0; row < config.rows; row += 1) {
    for (let col = 0; col < config.cols; col += 1) {
      if (legalReversiFlips(config, board, row, col, color).length) moves.push({ row, col });
    }
  }
  return moves;
}

/**
 * 连子判定：在 (row, col) 落 color 后是否达到连线长度。
 *
 * @param {object} config - 棋型配置。
 * @param {number[][]} board - 落子后的棋盘。
 * @param {number} row - 落子行。
 * @param {number} col - 落子列。
 * @param {number} color - 落子颜色。
 * @returns {boolean} 是否成线。
 */
function checkLineWin(config, board, row, col, color) {
  // 1. 只检查四个轴向（正反双向各自累计，避免重复算同一轴）。
  return [[0, 1], [1, 0], [1, 1], [1, -1]].some(([dr, dc]) => {
    let count = 1;
    for (const dir of [1, -1]) {
      let r = row + dr * dir;
      let c = col + dc * dir;
      while (inBounds(config, r, c) && board[r][c] === color) {
        count += 1;
        r += dr * dir;
        c += dc * dir;
      }
    }
    return count >= config.winLength;
  });
}

/**
 * 棋盘是否已满。
 *
 * @param {number[][]} board - 棋盘。
 * @returns {boolean} true 表示无空位。
 */
function isBoardFull(board) {
  return board.every((row) => row.every((cell) => cell !== EMPTY));
}

/**
 * 统计双方棋子数（黑白棋结算用）。
 *
 * @param {number[][]} board - 棋盘。
 * @returns {{black:number,white:number}} 双方子数。
 */
function countPieces(board) {
  return board.flat().reduce(
    (acc, cell) => {
      if (cell === BLACK) acc.black += 1;
      if (cell === WHITE) acc.white += 1;
      return acc;
    },
    { black: 0, white: 0 },
  );
}

/**
 * 四子棋：某一列落子后实际落点行。
 *
 * @param {object} config - 棋型配置。
 * @param {number[][]} board - 当前棋盘。
 * @param {number} col - 列号。
 * @returns {number} 落点行号；该列已满或列号非法返回 -1。
 */
function dropRow(config, board, col) {
  if (!Number.isInteger(col) || col < 0 || col >= config.cols) return -1;
  for (let row = config.rows - 1; row >= 0; row -= 1) {
    if (board[row][col] === EMPTY) return row;
  }
  return -1;
}

/**
 * 走子校验的拒绝原因（服务端据此映射协议错误码，客户端不直接展示）。
 */
const MoveRejection = Object.freeze({
  NOT_STARTED: "not-started",
  FINISHED: "finished",
  NOT_YOUR_TURN: "not-your-turn",
  BAD_CELL: "bad-cell",
  CELL_OCCUPIED: "cell-occupied",
  COLUMN_FULL: "column-full",
  ILLEGAL_TARGET: "illegal-target",
});

/**
 * 校验一步落子（井字棋/四子棋/黑白棋共用的入口）。
 *
 * 只做判定、不修改任何状态：调用方（服务端房间）拿到 verdict 后再决定是否推进权威状态。
 *
 * @param {object} config - 棋型配置。
 * @param {object} params - 校验入参。
 * @param {number[][]} params.board - 当前棋盘。
 * @param {number} params.color - 操作方颜色。
 * @param {{row:number,col:number}} params.cell - 落子意图坐标。
 * @param {boolean} params.started - 对局是否已开始。
 * @param {boolean} params.over - 对局是否已结束。
 * @param {number} params.turn - 当前轮次颜色。
 * @returns {{ok:true,row:number,col:number,flips:Array<[number,number]>}|{ok:false,reason:string}}
 *   ok 为 true 时给出实际落点与实际翻转列表（四子棋的行由服务器按列推导）。
 */
function validateMove(config, params) {
  const { board, color, cell, started, over, turn } = params;
  // 1. 状态校验：未开局 / 已结束 / 非本方回合一律拒绝。
  if (!started) return { ok: false, reason: MoveRejection.NOT_STARTED };
  if (over) return { ok: false, reason: MoveRejection.FINISHED };
  if (turn !== color) return { ok: false, reason: MoveRejection.NOT_YOUR_TURN };
  // 2. 坐标校验。
  const point = normalizePoint(config, cell);
  if (!point) return { ok: false, reason: MoveRejection.BAD_CELL };
  // 3. 按棋型分派落点推导。
  if (config.gravity) {
    // 3.1 四子棋：列满即拒绝，行号由服务器按重力推导，忽略客户端传来的行。
    const row = dropRow(config, board, point.col);
    if (row < 0) return { ok: false, reason: MoveRejection.COLUMN_FULL };
    return { ok: true, row, col: point.col, flips: [] };
  }
  if (config.key === "reversi") {
    // 3.2 黑白棋：必须夹吃至少一子。
    const flips = legalReversiFlips(config, board, point.row, point.col, color);
    if (!flips.length) return { ok: false, reason: MoveRejection.ILLEGAL_TARGET };
    return { ok: true, row: point.row, col: point.col, flips };
  }
  // 3.3 井字棋：目标格必须为空。
  if (board[point.row][point.col] !== EMPTY) return { ok: false, reason: MoveRejection.CELL_OCCUPIED };
  return { ok: true, row: point.row, col: point.col, flips: [] };
}

/**
 * 落子后的结果判定（胜负 / 平局 / 是否继续）。
 *
 * @param {object} config - 棋型配置。
 * @param {number[][]} board - 已落子的棋盘。
 * @param {{row:number,col:number}} cell - 实际落点。
 * @param {number} color - 落子方颜色。
 * @returns {{over:boolean,winner:number,draw:boolean,nextTurn:number}}
 *   over 为 true 时 winner 为获胜颜色（平局为 EMPTY），nextTurn 为下一手颜色。
 */
function evaluateGridOutcome(config, board, cell, color) {
  const opponent = opposite(color);
  // 1. 井字棋 / 四子棋：先判连线，再判平局，否则换手。
  if (config.winLength) {
    if (checkLineWin(config, board, cell.row, cell.col, color)) {
      return { over: true, winner: color, draw: false, nextTurn: opponent };
    }
    if (isBoardFull(board)) return { over: true, winner: EMPTY, draw: true, nextTurn: opponent };
    return { over: false, winner: EMPTY, draw: false, nextTurn: opponent };
  }
  // 2. 黑白棋：对手无子可下时本方继续；双方都无子可下时按子数结算。
  if (legalMoves(config, board, opponent).length) return { over: false, winner: EMPTY, draw: false, nextTurn: opponent };
  if (legalMoves(config, board, color).length) return { over: false, winner: EMPTY, draw: false, nextTurn: color };
  const pieces = countPieces(board);
  if (pieces.black > pieces.white) return { over: true, winner: BLACK, draw: false, nextTurn: opponent };
  if (pieces.white > pieces.black) return { over: true, winner: WHITE, draw: false, nextTurn: opponent };
  return { over: true, winner: EMPTY, draw: true, nextTurn: opponent };
}

/**
 * 颜色中文名（服务端拼装用户可读提示用）。
 *
 * @param {object} config - 棋型配置。
 * @param {number} color - BLACK 或 WHITE。
 * @returns {string} 展示名。
 */
function colorLabel(config, color) {
  if (config.key === "reversi") return color === BLACK ? "黑棋" : "白棋";
  if (config.key === "connect4") return color === BLACK ? "红方" : "黄方";
  return color === BLACK ? "先手" : "后手";
}

const api = {
  EMPTY,
  BLACK,
  WHITE,
  DIRECTIONS,
  GRID_GAMES,
  MoveRejection,
  opposite,
  configOf,
  createBoard,
  createInitialBoard,
  inBounds,
  normalizePoint,
  legalReversiFlips,
  legalMoves,
  checkLineWin,
  isBoardFull,
  countPieces,
  dropRow,
  validateMove,
  evaluateGridOutcome,
  colorLabel,
};

// 1. Node 侧：作为 CommonJS 模块导出，供 server/games/* 使用。
if (typeof module !== "undefined" && module.exports) module.exports = api;
// 2. 浏览器侧：挂到 window 上，供渲染层读取尺寸与可落子提示。
if (typeof window !== "undefined") window.GridRules = api;
