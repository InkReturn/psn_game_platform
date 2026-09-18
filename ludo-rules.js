/**
 * 飞行棋纯规则模块（服务端唯一裁决者，浏览器只用于展示与提示）。
 *
 * 规则口径与改造前 ludo.js 的客户端本地实现逐条对齐，不新增/删减玩法
 * （保持简化版：无吃子、无安全区、无额外回合）：
 * - 2-4 支队伍，每队 2 架飞机，位置用航道下标表示：-1 = 待起飞，0..24 = 航道，
 *   24（TRACK_LENGTH-1）= 到达终点；
 * - 起飞需要掷出 6；掷非 6 时选择待起飞的飞机会消耗该回合（沿用旧口径：
 *   旧客户端点"待起飞"飞机 + 非 6 点数 -> 提示"只有掷到 6 才能起飞"并换手）；
 * - 移动 = 当前位置 + 骰子点数，超过终点则钳制到终点；
 * - 胜利 = 该队全部飞机到达终点。
 *
 * 设计约束：
 * - 本文件没有任何 I/O、DOM 依赖与随机性（骰子由服务器房间层用 crypto 生成），
 *   同样的 (state, input) 永远得到同样的结果；
 * - 同时被 Node（require）与浏览器（<script> 加载，暴露 window.LudoRules）使用，
 *   服务端裁决与客户端提示共用同一份实现，避免规则实现漂移成两份。
 */
"use strict";

/** 航道长度（与渲染层 ludoTrack 的 25 格一致；终点下标 = TRACK_LENGTH-1）。 */
const TRACK_LENGTH = 25;
/** 每队飞机数。 */
const PIECES_PER_TEAM = 2;
/** 允许的队伍数范围。 */
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
/** 起飞所需点数。 */
const LAUNCH_DICE = 6;

/** 队伍颜色（按座位顺序分配）。 */
const TEAM_COLORS = Object.freeze(["red", "blue", "green", "gold"]);
/** 颜色的中文展示名（与颜色表一一对应）。 */
const TEAM_NAMES = Object.freeze({ red: "红方", blue: "蓝方", green: "绿方", gold: "黄方" });

/** 走法校验失败原因（服务端据此映射错误码）。 */
const MoveRejection = Object.freeze({
  NOT_STARTED: "NOT_STARTED",
  FINISHED: "FINISHED",
  NOT_YOUR_TURN: "NOT_YOUR_TURN",
  DICE_NOT_ROLLED: "DICE_NOT_ROLLED",
  BAD_PIECE: "BAD_PIECE",
});

/**
 * 生成开局队伍。
 *
 * @param {number} count - 队伍数（2..4）。
 * @returns {Array<{name: string, color: string, pieces: number[]}>} 初始队伍数组。
 */
function createTeams(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: TEAM_NAMES[TEAM_COLORS[index]],
    color: TEAM_COLORS[index],
    pieces: Array(PIECES_PER_TEAM).fill(-1),
  }));
}

/**
 * 某队是否已全部到达终点。
 *
 * @param {object} team - 队伍（含 pieces 数组）。
 * @returns {boolean} true 表示全部到达。
 */
function teamFinished(team) {
  return team.pieces.every((pos) => pos >= TRACK_LENGTH - 1);
}

/**
 * 走法校验（状态、轮次、骰子、棋子下标一次性判定）。
 *
 * 注意：选择"待起飞的飞机 + 骰子非 6"不是拒绝项——旧玩法里这会消耗该回合，
 * 属于合法操作（applyMove 会原样消耗回合，飞机原地不动）。
 *
 * @param {object} params - 校验入参。
 * @param {Array<object>} params.teams - 队伍数组。
 * @param {number} params.turn - 当前轮到的队伍下标。
 * @param {number} params.moverIndex - 发起操作的队伍下标。
 * @param {number} params.pieceIndex - 要移动的飞机下标（0..PIECES_PER_TEAM-1）。
 * @param {number} params.dice - 当前骰子点数（0 表示尚未掷骰）。
 * @param {boolean} params.started - 对局是否已开始。
 * @param {boolean} params.over - 对局是否已结束。
 * @returns {{ok: true}|{ok: false, reason: string}} 校验结果。
 */
function validateMove({ teams, turn, moverIndex, pieceIndex, dice, started, over }) {
  // 1. 状态校验。
  if (!started) return { ok: false, reason: MoveRejection.NOT_STARTED };
  if (over) return { ok: false, reason: MoveRejection.FINISHED };
  // 2. 轮次校验。
  if (moverIndex !== turn) return { ok: false, reason: MoveRejection.NOT_YOUR_TURN };
  // 3. 骰子校验：必须先掷骰（1..6）。
  if (!Number.isInteger(dice) || dice < 1 || dice > 6) return { ok: false, reason: MoveRejection.DICE_NOT_ROLLED };
  // 4. 棋子下标校验。
  if (!Number.isInteger(pieceIndex) || pieceIndex < 0 || pieceIndex >= PIECES_PER_TEAM) {
    return { ok: false, reason: MoveRejection.BAD_PIECE };
  }
  void teams;
  return { ok: true };
}

/**
 * 应用一步移动（纯函数：返回新队伍数组，不修改入参）。
 *
 * 前置条件：调用方已通过 validateMove 校验。
 *
 * @param {Array<object>} teams - 队伍数组。
 * @param {number} turn - 当前队伍下标。
 * @param {number} pieceIndex - 要移动的飞机下标。
 * @param {number} dice - 本次骰子点数（1..6）。
 * @returns {{teams: Array<object>, won: boolean, nextTurn: number, launched: boolean, consumed: boolean}} 推进结果。
 *   launched = 待起飞飞机成功起飞；consumed = 航道飞机实际位移（两者互斥；
 *   待起飞 + 非 6 时既不 launched 也不 consumed，但仍消耗回合）。
 */
function applyMove(teams, turn, pieceIndex, dice) {
  // 1. 复制队伍数组，只允许改当前队伍。
  const next = teams.map((team, index) => (index === turn ? { ...team, pieces: [...team.pieces] } : team));
  const team = next[turn];
  const pos = team.pieces[pieceIndex];
  let launched = false;
  let consumed = false;
  // 2. 待起飞：掷 6 起飞，否则原地不动（回合仍被消耗）。
  if (pos < 0) {
    if (dice === LAUNCH_DICE) {
      team.pieces[pieceIndex] = 0;
      launched = true;
    }
  } else {
    // 3. 航道移动：钳制到终点。
    const target = Math.min(TRACK_LENGTH - 1, pos + dice);
    consumed = target !== pos;
    team.pieces[pieceIndex] = target;
  }
  // 4. 胜负与轮次：未分胜负时严格换手；获胜后轮次停在获胜队伍。
  const won = teamFinished(team);
  const nextTurn = won ? turn : (turn + 1) % next.length;
  return { teams: next, won, nextTurn, launched, consumed };
}

/** 导出 API（Node 与浏览器共用）。 */
const api = {
  TRACK_LENGTH,
  PIECES_PER_TEAM,
  MIN_PLAYERS,
  MAX_PLAYERS,
  LAUNCH_DICE,
  TEAM_COLORS,
  TEAM_NAMES,
  MoveRejection,
  createTeams,
  teamFinished,
  validateMove,
  applyMove,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.LudoRules = api;
