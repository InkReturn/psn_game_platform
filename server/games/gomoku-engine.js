/**
 * 五子棋纯规则引擎（无 IO、无网络，可独立单测）。
 *
 * 只负责棋盘状态推进与胜负判定；房间成员、广播、断线等由 gomoku-room.js 管理。
 * 状态字段与原浏览器端实现保持一致，便于客户端渲染层零成本迁移。
 */
"use strict";

/** 棋盘规格：15x15。 */
const BOARD_SIZE = 15;

/** 棋子常量：0 空 / 1 黑 / 2 白。 */
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

/** 生成一局的初始棋盘。
 * @returns {number[][]} 15x15 全 0 二维数组。
 */
function createBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY));
}

/** 颜色中文名（用于服务端拼装用户可读的 message 字段）。
 * @param {number} color - BLACK 或 WHITE。
 * @returns {string} "黑棋" / "白棋"。
 */
function colorName(color) {
  return color === BLACK ? "黑棋" : "白棋";
}

/**
 * 从某个点出发沿指定方向统计连续同色棋子数。
 *
 * @param {number[][]} board - 棋盘二维数组。
 * @param {number} row - 起始行（0 基）。
 * @param {number} col - 起始列（0 基）。
 * @param {number} dr - 行方向步长（-1/0/1）。
 * @param {number} dc - 列方向步长（-1/0/1）。
 * @param {number} color - 目标颜色。
 * @returns {number} 该方向上连续同色棋子数（不含起点）。
 */
function countDirection(board, row, col, dr, dc, color) {
  let count = 0;
  let r = row + dr;
  let c = col + dc;
  while (r >= 0 && c >= 0 && r < BOARD_SIZE && c < BOARD_SIZE && board[r][c] === color) {
    count += 1;
    r += dr;
    c += dc;
  }
  return count;
}

/**
 * 判断在 (row, col) 落 color 后是否连成五子或以上。
 *
 * @param {number[][]} board - 落子后的棋盘。
 * @param {number} row - 落子行。
 * @param {number} col - 落子列。
 * @param {number} color - 落子颜色。
 * @returns {boolean} 是否形成五连。
 */
function checkWinner(board, row, col, color) {
  return (
    countDirection(board, row, col, 0, 1, color) + countDirection(board, row, col, 0, -1, color) + 1 >= 5 ||
    countDirection(board, row, col, 1, 0, color) + countDirection(board, row, col, -1, 0, color) + 1 >= 5 ||
    countDirection(board, row, col, 1, 1, color) + countDirection(board, row, col, -1, -1, color) + 1 >= 5 ||
    countDirection(board, row, col, 1, -1, color) + countDirection(board, row, col, -1, 1, color) + 1 >= 5
  );
}

module.exports = { BOARD_SIZE, EMPTY, BLACK, WHITE, createBoard, colorName, countDirection, checkWinner };
