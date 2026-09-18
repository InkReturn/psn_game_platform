/**
 * 大富翁（环球地产简化版）纯规则模块（服务端唯一裁决者，浏览器只用于展示）。
 *
 * 规则口径与改造前 monopoly.js 的客户端本地实现逐条对齐，不新增/删减玩法
 * （保持简化版：无房屋升级操作、无抵押、无拍卖、无监狱保释金，破产即终局）：
 * - 40 格环形地图，2-4 人，起始 $1500，起点为 0 号格；
 * - 掷骰 1-6 前进，经过/落到起点（old+dice >= 40）得 $200；
 * - 落到"进监狱"角格：回到 10 号格并停一回合；
 * - 落到税格支付固定税金；落到机会格获得 +$120 或 -$80（服务器随机）；
 * - 落到无主且买得起的地块：进入"待购买"状态，由该玩家决定买/跳过；
 *   买入后地块记 1 所"房"（租金 +$25 的口径来源），租金 = 基础租金 + 房数 × 25；
 * - 落到他人地块支付租金；落到自己地块无事；
 * - 任意玩家现金 < 0 即破产，对局立即结束（无胜者字段，沿用旧口径）。
 *
 * 设计约束：
 * - 本文件没有任何 I/O、DOM 依赖与随机性（骰子与机会事件由服务器房间层用
 *   crypto 生成后作为参数注入），同样的 (state, input) 永远得到同样的结果；
 * - 同时被 Node（require）与浏览器（<script> 加载，暴露 window.MonopolyRules）使用。
 */
"use strict";

/** 地图配置（40 格，与旧 monopolyCells 逐条一致）。 */
const CELLS = Object.freeze([
  { name: "起点", type: "corner", action: "start", flag: "GO" },
  { name: "巴西", type: "property", price: 120, rent: 30, group: "teal", code: "BR" },
  { name: "机会", type: "chance", flag: "?" },
  { name: "阿根廷", type: "property", price: 140, rent: 35, group: "teal", code: "AR" },
  { name: "关税", type: "tax", fee: 100, flag: "$" },
  { name: "南美航线", type: "station", price: 200, rent: 45, flag: "AIR" },
  { name: "埃及", type: "property", price: 180, rent: 45, group: "pink", code: "EG" },
  { name: "命运", type: "chance", flag: "*" },
  { name: "南非", type: "property", price: 200, rent: 55, group: "pink", code: "ZA" },
  { name: "摩洛哥", type: "property", price: 220, rent: 60, group: "pink", code: "MA" },
  { name: "探监", type: "corner", action: "visit", flag: "IN" },
  { name: "西班牙", type: "property", price: 240, rent: 70, group: "blue", code: "ES" },
  { name: "电力公司", type: "utility", price: 160, rent: 50, flag: "ELE" },
  { name: "法国", type: "property", price: 260, rent: 75, group: "blue", code: "FR" },
  { name: "德国", type: "property", price: 280, rent: 80, group: "blue", code: "DE" },
  { name: "欧洲航线", type: "station", price: 200, rent: 45, flag: "AIR" },
  { name: "意大利", type: "property", price: 300, rent: 90, group: "orange", code: "IT" },
  { name: "机会", type: "chance", flag: "?" },
  { name: "英国", type: "property", price: 320, rent: 95, group: "orange", code: "GB" },
  { name: "瑞士", type: "property", price: 340, rent: 100, group: "orange", code: "CH" },
  { name: "免费停车", type: "corner", action: "parking", flag: "P" },
  { name: "土耳其", type: "property", price: 360, rent: 110, group: "green", code: "TR" },
  { name: "命运", type: "chance", flag: "*" },
  { name: "印度", type: "property", price: 380, rent: 115, group: "green", code: "IN" },
  { name: "新加坡", type: "property", price: 400, rent: 125, group: "green", code: "SG" },
  { name: "亚洲航线", type: "station", price: 200, rent: 45, flag: "AIR" },
  { name: "韩国", type: "property", price: 420, rent: 135, group: "gold", code: "KR" },
  { name: "水务公司", type: "utility", price: 160, rent: 50, flag: "WTR" },
  { name: "日本", type: "property", price: 440, rent: 145, group: "gold", code: "JP" },
  { name: "中国", type: "property", price: 460, rent: 155, group: "gold", code: "CN" },
  { name: "进监狱", type: "corner", action: "jail", flag: "J" },
  { name: "澳大利亚", type: "property", price: 480, rent: 165, group: "red", code: "AU" },
  { name: "新西兰", type: "property", price: 500, rent: 175, group: "red", code: "NZ" },
  { name: "机会", type: "chance", flag: "?" },
  { name: "加拿大", type: "property", price: 520, rent: 185, group: "red", code: "CA" },
  { name: "北美航线", type: "station", price: 200, rent: 45, flag: "AIR" },
  { name: "美国", type: "property", price: 560, rent: 200, group: "black", code: "US" },
  { name: "奢侈税", type: "tax", fee: 160, flag: "$" },
  { name: "墨西哥", type: "property", price: 580, rent: 220, group: "black", code: "MX" },
  { name: "世界银行", type: "property", price: 600, rent: 240, group: "black", flag: "BANK" },
].map((cell) => Object.freeze(cell)));

/** 玩家颜色（按座位顺序分配）。 */
const PLAYER_COLORS = Object.freeze(["red", "blue", "green", "gold"]);
/** 起始资金。 */
const START_MONEY = 1500;
/** 经过起点获得的奖励。 */
const GO_BONUS = 200;
/** 机会格的正/负金额。 */
const CHANCE_BONUS = 120;
const CHANCE_PENALTY = -80;
/** 每所"房"增加的租金。 */
const HOUSE_RENT = 25;
/** 监狱格下标。 */
const JAIL_INDEX = 10;
/** 允许的玩家数范围。 */
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;

/** 操作拒绝原因（服务端据此映射错误码）。 */
const Rejection = Object.freeze({
  NOT_STARTED: "NOT_STARTED",
  FINISHED: "FINISHED",
  NOT_YOUR_TURN: "NOT_YOUR_TURN",
  PURCHASE_PENDING: "PURCHASE_PENDING",
  NO_PURCHASE: "NO_PURCHASE",
  NOT_YOUR_PURCHASE: "NOT_YOUR_PURCHASE",
});

/**
 * 生成开局玩家。
 *
 * @param {number} count - 玩家数（2..4）。
 * @returns {Array<object>} 初始玩家数组（昵称为占位名，房间层会覆盖为真实昵称）。
 */
function createPlayers(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `玩家 ${String.fromCharCode(65 + index)}`,
    pos: 0,
    money: START_MONEY,
    color: PLAYER_COLORS[index],
    properties: [],
    jailed: 0,
  }));
}

/**
 * 生成开局地块状态（与 CELLS 下标对齐）。
 *
 * @returns {Array<{owner: number|null, houses: number}>} 地块状态数组。
 */
function createCellStates() {
  return CELLS.map(() => ({ owner: null, houses: 0 }));
}

/**
 * 掷骰推进（纯函数：返回新状态，不修改入参）。
 *
 * @param {object} params - 推进入参。
 * @param {Array<object>} params.players - 玩家数组。
 * @param {Array<object>} params.cells - 地块状态数组。
 * @param {number} params.turn - 当前玩家下标。
 * @param {number} params.dice - 骰子点数（1..6，由服务器注入）。
 * @param {number} params.chanceBonus - 机会事件金额（+$120 / -$80，由服务器注入）。
 * @returns {{players: Array<object>, cells: Array<object>, turn: number, pendingPurchase: object|null, over: boolean, status: string}} 推进结果。
 */
function applyRoll({ players, cells, turn, dice, chanceBonus }) {
  // 1. 深拷贝可变状态。
  const nextPlayers = players.map((p) => ({ ...p, properties: [...p.properties] }));
  const nextCells = cells.map((c) => ({ ...c }));
  const player = nextPlayers[turn];
  let pendingPurchase = null;
  let over = false;
  let status = "";
  // 2. 监狱停留：消耗一回合，不移动。
  if (player.jailed > 0) {
    player.jailed -= 1;
    status = `${player.name} 本回合停留监狱`;
    return { players: nextPlayers, cells: nextCells, turn: (turn + 1) % nextPlayers.length, pendingPurchase, over, status };
  }
  // 3. 移动与经过起点奖励。
  const old = player.pos;
  player.pos = (player.pos + dice) % CELLS.length;
  if (old + dice >= CELLS.length) player.money += GO_BONUS;
  // 4. 结算落点。
  const cellIndex = player.pos;
  const cell = CELLS[cellIndex];
  const cellState = nextCells[cellIndex];
  if (cell.action === "jail") {
    // 4.1 进监狱：回到监狱格并停一回合。
    player.pos = JAIL_INDEX;
    player.jailed = 1;
    status = `${player.name} 进入监狱`;
  } else if (cell.type === "tax") {
    // 4.2 税格。
    player.money -= cell.fee;
    status = `${player.name} 支付 ${cell.name} $${cell.fee}`;
  } else if (cell.type === "chance") {
    // 4.3 机会格（金额由服务器注入）。
    player.money += chanceBonus;
    status = `${player.name}${chanceBonus > 0 ? " 获得 " : " 支出 "}$${Math.abs(chanceBonus)}`;
  } else if (cell.price) {
    if (cellState.owner === null && player.money >= cell.price) {
      // 4.4 无主且买得起：进入待购买状态，轮次不推进。
      pendingPurchase = { playerIndex: turn, cellIndex };
      status = `${player.name} 正在决定是否购买 ${cell.name}`;
      return { players: nextPlayers, cells: nextCells, turn, pendingPurchase, over, status };
    }
    if (cellState.owner !== null && cellState.owner !== turn) {
      // 4.5 他人地块：支付租金（基础租金 + 房数 × 25）。
      const rent = cell.rent + cellState.houses * HOUSE_RENT;
      player.money -= rent;
      nextPlayers[cellState.owner].money += rent;
      status = `${player.name} 向 ${nextPlayers[cellState.owner].name} 支付 $${rent}`;
    } else {
      // 4.6 自己地块或买不起的空地：无事。
      status = `${player.name} 停在 ${cell.name}`;
    }
  } else {
    // 4.7 角格/其他：安全停留。
    status = `${player.name} 停在 ${cell.name}`;
  }
  // 5. 破产判定：现金 < 0 立即终局；否则轮次推进。
  if (player.money < 0) {
    over = true;
    status = `${player.name} 破产，游戏结束`;
    return { players: nextPlayers, cells: nextCells, turn, pendingPurchase, over, status };
  }
  return { players: nextPlayers, cells: nextCells, turn: (turn + 1) % nextPlayers.length, pendingPurchase, over, status };
}

/**
 * 处理购买决定（纯函数：返回新状态，不修改入参）。
 *
 * @param {object} params - 入参。
 * @param {Array<object>} params.players - 玩家数组。
 * @param {Array<object>} params.cells - 地块状态数组。
 * @param {object} params.pendingPurchase - 待购买描述 {playerIndex, cellIndex}。
 * @param {boolean} params.buy - true 买入 / false 跳过。
 * @returns {{players: Array<object>, cells: Array<object>, turn: number, status: string}} 推进结果（购买后轮次推进）。
 */
function applyPurchase({ players, cells, pendingPurchase, buy }) {
  // 1. 深拷贝可变状态。
  const nextPlayers = players.map((p) => ({ ...p, properties: [...p.properties] }));
  const nextCells = cells.map((c) => ({ ...c }));
  const { playerIndex, cellIndex } = pendingPurchase;
  const player = nextPlayers[playerIndex];
  const cell = CELLS[cellIndex];
  const cellState = nextCells[cellIndex];
  let status = "";
  // 2. 买入：地块归属 + 记 1 所房 + 扣款 + 房产清单（沿用旧口径）。
  if (buy && cellState.owner === null && player.money >= cell.price) {
    cellState.owner = playerIndex;
    cellState.houses = 1;
    player.money -= cell.price;
    if (!player.properties.includes(cell.name)) player.properties.push(cell.name);
    status = `${player.name} 买下 ${cell.name}`;
  } else {
    status = `${player.name} 放弃购买 ${cell.name}`;
  }
  // 3. 轮次推进。
  return { players: nextPlayers, cells: nextCells, turn: (playerIndex + 1) % nextPlayers.length, status };
}

/** 导出 API（Node 与浏览器共用）。 */
const api = {
  CELLS,
  PLAYER_COLORS,
  START_MONEY,
  GO_BONUS,
  CHANCE_BONUS,
  CHANCE_PENALTY,
  HOUSE_RENT,
  JAIL_INDEX,
  MIN_PLAYERS,
  MAX_PLAYERS,
  Rejection,
  createPlayers,
  createCellStates,
  applyRoll,
  applyPurchase,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.MonopolyRules = api;
