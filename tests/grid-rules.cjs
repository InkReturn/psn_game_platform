/**
 * 棋类规则模块单测（纯函数，无需服务器与浏览器）。
 *
 * 覆盖 grid-rules.js（井字棋 / 黑白棋 / 四子棋）与 gomoku-engine.js：
 * 这类模块是服务端权威的唯一裁决依据，因此必须能脱离网络单独验证。
 *
 * 运行方式：node tests/grid-rules.cjs
 */
"use strict";

const rules = require("../grid-rules");
const gomoku = require("../server/games/gomoku-engine");

/** 用例结果收集。 */
const results = [];

/**
 * 记录一条用例结果。
 *
 * @param {string} name - 用例名。
 * @param {boolean} pass - 是否通过。
 * @param {string} [detail] - 失败详情。
 */
function record(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail && !pass ? ` — ${detail}` : ""}`);
}

/**
 * 执行一段用例并记录结果（失败不中断后续用例）。
 *
 * @param {string} name - 用例名。
 * @param {Function} fn - 同步用例体。
 */
function testCase(name, fn) {
  try {
    fn();
    record(name, true);
  } catch (err) {
    record(name, false, err.message);
  }
}

/**
 * 断言相等（JSON 比较，报错可读）。
 *
 * @param {*} actual - 实际值。
 * @param {*} expected - 期望值。
 * @param {string} label - 描述。
 */
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/**
 * 断言为真。
 *
 * @param {*} condition - 断言表达式结果。
 * @param {string} label - 描述。
 */
function assert(condition, label) {
  if (!condition) throw new Error(label);
}

/**
 * 通过规则模块在本地棋盘上模拟一步（仅用于构造测试局面）。
 *
 * @param {object} config - 棋型配置。
 * @param {number[][]} board - 棋盘（原地推进）。
 * @param {number} row - 行号。
 * @param {number} col - 列号。
 * @param {number} color - 落子颜色。
 * @returns {{ok:boolean,row:number,col:number,flips:Array}} 校验结果。
 */
function applyMove(config, board, row, col, color) {
  const verdict = rules.validateMove(config, { board, color, cell: { row, col }, started: true, over: false, turn: color });
  if (!verdict.ok) return verdict;
  board[verdict.row][verdict.col] = color;
  verdict.flips.forEach(([r, c]) => {
    board[r][c] = color;
  });
  return verdict;
}

const { BLACK, WHITE, EMPTY } = rules;

// ── 井字棋 ─────────────────────────────────────────────────────
const tt = rules.configOf("tictactoe");

testCase("井字棋：初始棋盘为 3x3 空盘", () => {
  const board = rules.createInitialBoard(tt);
  assertEq(board.length, 3, "行数");
  assertEq(board.every((row) => row.length === 3 && row.every((cell) => cell === EMPTY)), true, "全空");
});

testCase("井字棋：横线连三判胜", () => {
  const board = rules.createInitialBoard(tt);
  applyMove(tt, board, 0, 0, BLACK);
  applyMove(tt, board, 1, 0, WHITE);
  applyMove(tt, board, 0, 1, BLACK);
  applyMove(tt, board, 1, 1, WHITE);
  const last = applyMove(tt, board, 0, 2, BLACK);
  const outcome = rules.evaluateGridOutcome(tt, board, last, BLACK);
  assertEq(outcome.over, true, "对局结束");
  assertEq(outcome.winner, BLACK, "黑方获胜");
});

testCase("井字棋：非本方回合落子被拒（NOT_YOUR_TURN）", () => {
  const board = rules.createInitialBoard(tt);
  const verdict = rules.validateMove(tt, { board, color: WHITE, cell: { row: 0, col: 0 }, started: true, over: false, turn: BLACK });
  assertEq(verdict.ok, false, "应被拒绝");
  assertEq(verdict.reason, rules.MoveRejection.NOT_YOUR_TURN, "拒绝原因");
});

testCase("井字棋：已占格落子被拒（CELL_OCCUPIED）", () => {
  const board = rules.createInitialBoard(tt);
  board[1][1] = BLACK;
  const verdict = rules.validateMove(tt, { board, color: BLACK, cell: { row: 1, col: 1 }, started: true, over: false, turn: BLACK });
  assertEq(verdict.reason, rules.MoveRejection.CELL_OCCUPIED, "拒绝原因");
});

testCase("井字棋：越界坐标被拒（BAD_CELL）", () => {
  const board = rules.createInitialBoard(tt);
  const verdict = rules.validateMove(tt, { board, color: BLACK, cell: { row: 3, col: 0 }, started: true, over: false, turn: BLACK });
  assertEq(verdict.reason, rules.MoveRejection.BAD_CELL, "拒绝原因");
});

testCase("井字棋：未开局/已结束被拒", () => {
  const board = rules.createInitialBoard(tt);
  const notStarted = rules.validateMove(tt, { board, color: BLACK, cell: { row: 0, col: 0 }, started: false, over: false, turn: BLACK });
  assertEq(notStarted.reason, rules.MoveRejection.NOT_STARTED, "未开局");
  const finished = rules.validateMove(tt, { board, color: BLACK, cell: { row: 0, col: 0 }, started: true, over: true, turn: BLACK });
  assertEq(finished.reason, rules.MoveRejection.FINISHED, "已结束");
});

testCase("井字棋：棋盘下满判平局", () => {
  const board = [
    [BLACK, WHITE, BLACK],
    [BLACK, WHITE, WHITE],
    [WHITE, BLACK, BLACK],
  ];
  const outcome = rules.evaluateGridOutcome(tt, board, { row: 2, col: 2 }, BLACK);
  assertEq(outcome.over, true, "对局结束");
  assertEq(outcome.draw, true, "平局");
  assertEq(outcome.winner, EMPTY, "无胜者");
});

// ── 四子棋 ─────────────────────────────────────────────────────
const c4 = rules.configOf("connect4");

testCase("四子棋：行号由服务器按列推导（忽略客户端行）", () => {
  const board = rules.createInitialBoard(c4);
  const first = rules.validateMove(c4, { board, color: BLACK, cell: { row: 0, col: 3 }, started: true, over: false, turn: BLACK });
  assertEq(first.row, 5, "首子落在最后一行");
  board[5][3] = BLACK;
  const second = rules.validateMove(c4, { board, color: WHITE, cell: { row: 0, col: 3 }, started: true, over: false, turn: WHITE });
  assertEq(second.row, 4, "第二子落在倒数第二行");
});

testCase("四子棋：列满被拒（COLUMN_FULL）", () => {
  const board = rules.createInitialBoard(c4);
  for (let row = 0; row < c4.rows; row += 1) board[row][0] = BLACK;
  const verdict = rules.validateMove(c4, { board, color: BLACK, cell: { row: 0, col: 0 }, started: true, over: false, turn: BLACK });
  assertEq(verdict.reason, rules.MoveRejection.COLUMN_FULL, "拒绝原因");
});

testCase("四子棋：竖直连四判胜", () => {
  const board = rules.createInitialBoard(c4);
  applyMove(c4, board, 0, 2, BLACK);
  applyMove(c4, board, 0, 3, WHITE);
  applyMove(c4, board, 0, 2, BLACK);
  applyMove(c4, board, 0, 3, WHITE);
  applyMove(c4, board, 0, 2, BLACK);
  applyMove(c4, board, 0, 3, WHITE);
  const last = applyMove(c4, board, 0, 2, BLACK);
  const outcome = rules.evaluateGridOutcome(c4, board, last, BLACK);
  assertEq(outcome.over, true, "对局结束");
  assertEq(outcome.winner, BLACK, "黑方获胜");
});

testCase("四子棋：斜向连四判胜", () => {
  const board = rules.createInitialBoard(c4);
  // 依次在 0/1/2/3 列错开堆叠，让黑棋在第 2..5 列形成对角四连。
  const script = [
    [0, BLACK],
    [1, WHITE],
    [1, BLACK],
    [2, WHITE],
    [2, WHITE],
    [2, BLACK],
    [3, WHITE],
    [3, WHITE],
    [3, WHITE],
    [3, BLACK],
  ];
  let last = null;
  script.forEach(([col, color]) => {
    last = applyMove(c4, board, 0, col, color);
    if (!last.ok) throw new Error(`构造局面失败：col=${col} reason=${last.reason}`);
  });
  const outcome = rules.evaluateGridOutcome(c4, board, last, BLACK);
  assertEq(outcome.over, true, "对局结束");
  assertEq(outcome.winner, BLACK, "黑方斜向四连获胜");
});

// ── 黑白棋 ─────────────────────────────────────────────────────
const rv = rules.configOf("reversi");

testCase("黑白棋：初始四子交叉摆法", () => {
  const board = rules.createInitialBoard(rv);
  assertEq(board[3][3], WHITE, "(3,3) 白");
  assertEq(board[3][4], BLACK, "(3,4) 黑");
  assertEq(board[4][3], BLACK, "(4,3) 黑");
  assertEq(board[4][4], WHITE, "(4,4) 白");
  assertEq(rules.countPieces(board), { black: 2, white: 2 }, "双方各 2 子");
});

testCase("黑白棋：黑白双方开局各有两个合法点", () => {
  const board = rules.createInitialBoard(rv);
  assertEq(rules.legalMoves(rv, board, BLACK).length, 4, "先手合法点数量");
  assertEq(rules.legalMoves(rv, board, WHITE).length, 4, "后手合法点数量");
});

testCase("黑白棋：无夹吃的落点被拒（ILLEGAL_TARGET）", () => {
  const board = rules.createInitialBoard(rv);
  const verdict = rules.validateMove(rv, { board, color: BLACK, cell: { row: 0, col: 0 }, started: true, over: false, turn: BLACK });
  assertEq(verdict.reason, rules.MoveRejection.ILLEGAL_TARGET, "拒绝原因");
});

testCase("黑白棋：合法落子翻转被夹住的对方子", () => {
  const board = rules.createInitialBoard(rv);
  const verdict = applyMove(rv, board, 2, 3, BLACK);
  assertEq(verdict.ok, true, "落子合法");
  assertEq(verdict.flips.length, 1, "翻转 1 子");
  assertEq(board[3][3], BLACK, "被夹白子翻成黑");
  assertEq(rules.countPieces(board), { black: 4, white: 1 }, "翻转后子数");
});

testCase("黑白棋：对手无子可下时本方继续", () => {
  // 构造一个白方无合法点、黑方仍有合法点的局面。
  const board = Array.from({ length: 8 }, () => Array(8).fill(EMPTY));
  board[0][0] = BLACK;
  board[0][1] = WHITE;
  board[0][2] = WHITE;
  board[0][3] = WHITE;
  board[0][4] = WHITE;
  board[0][5] = WHITE;
  board[0][6] = WHITE;
  board[0][7] = WHITE;
  board[1][1] = BLACK;
  board[1][2] = BLACK;
  board[1][3] = BLACK;
  board[1][4] = BLACK;
  board[1][5] = BLACK;
  board[1][6] = BLACK;
  board[1][7] = BLACK;
  board[2][2] = BLACK;
  board[2][3] = BLACK;
  board[2][4] = BLACK;
  board[2][5] = BLACK;
  board[2][6] = BLACK;
  board[2][7] = BLACK;
  board[3][3] = BLACK;
  board[3][4] = BLACK;
  board[3][5] = BLACK;
  board[3][6] = BLACK;
  board[3][7] = BLACK;
  board[4][4] = BLACK;
  board[4][5] = BLACK;
  board[4][6] = BLACK;
  board[4][7] = BLACK;
  board[5][5] = BLACK;
  board[5][6] = BLACK;
  board[5][7] = BLACK;
  board[6][6] = BLACK;
  board[6][7] = BLACK;
  board[7][7] = WHITE;
  const outcome = rules.evaluateGridOutcome(rv, board, { row: 7, col: 7 }, WHITE);
  assertEq(outcome.over, false, "对局未结束");
  assertEq(outcome.nextTurn, WHITE, "白方无子可下时继续由白方落子");
});

testCase("黑白棋：双方都无子可下时按子数结算", () => {
  const board = Array.from({ length: 8 }, () => Array(8).fill(BLACK));
  board[7][7] = WHITE;
  board[7][6] = WHITE;
  const outcome = rules.evaluateGridOutcome(rv, board, { row: 7, col: 7 }, WHITE);
  assertEq(outcome.over, true, "对局结束");
  assertEq(outcome.winner, BLACK, "黑子多者获胜");
});

// ── 五子棋引擎（回归：确保未被本轮改动影响） ──────────────────────
testCase("五子棋引擎：横线连五判胜", () => {
  const board = gomoku.createBoard();
  for (let col = 3; col <= 7; col += 1) board[7][col] = gomoku.BLACK;
  assertEq(gomoku.checkWinner(board, 7, 7, gomoku.BLACK), true, "五连成立");
  assertEq(gomoku.checkWinner(board, 7, 7, gomoku.WHITE), false, "白棋不成立");
});

testCase("五子棋引擎：四子不算胜", () => {
  const board = gomoku.createBoard();
  for (let col = 3; col <= 6; col += 1) board[7][col] = gomoku.BLACK;
  assertEq(gomoku.checkWinner(board, 7, 6, gomoku.BLACK), false, "四连不算胜");
});

// ── 汇总 ───────────────────────────────────────────────────────
const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
