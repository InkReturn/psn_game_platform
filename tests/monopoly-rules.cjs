/**
 * 大富翁规则模块单测（纯函数，无需服务器与浏览器）。
 *
 * 覆盖 monopoly-rules.js：开局配置、移动与经过起点奖励、监狱、税格、
 * 机会格（注入金额）、待购买、买入/跳过、租金支付、破产终局与纯函数性。
 * 规则模块是服务端权威的唯一裁决依据，因此必须能脱离网络单独验证。
 *
 * 运行方式：node tests/monopoly-rules.cjs
 */
"use strict";

const rules = require("../monopoly-rules");

/** 用例结果收集。 */
const results = [];

/**
 * 记录一条用例结果。
 *
 * @param {string} name - 用例名。
 * @param {boolean} pass - 是否通过。
 */
function record(name, pass) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
}

/**
 * 断言相等（JSON 比较）。
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
 * 执行一条用例并捕获异常。
 *
 * @param {string} name - 用例名。
 * @param {Function} fn - 用例函数。
 */
function check(name, fn) {
  try {
    fn();
    record(name, true);
  } catch (err) {
    record(name, false);
    console.error(`    ${err.message}`);
  }
}

check("地图配置：40 格，与旧实现一致的关键格", () => {
  assertEq(rules.CELLS.length, 40, "格子总数");
  assertEq(rules.CELLS[0].name, "起点", "起点格");
  assertEq(rules.CELLS[30].action, "jail", "进监狱角格");
  assertEq(rules.CELLS[4].fee, 100, "关税");
  assertEq(rules.CELLS[39].price, 600, "世界银行");
});

check("开局：玩家 $1500 在起点，地块全部无主", () => {
  const players = rules.createPlayers(3);
  assertEq(players.length, 3, "三人局");
  players.forEach((p) => {
    assertEq(p.pos, 0, "起点");
    assertEq(p.money, rules.START_MONEY, "起始资金");
    assertEq(p.jailed, 0, "不在监狱");
  });
  const cells = rules.createCellStates();
  assertEq(cells.length, 40, "地块状态数");
  assert(cells.every((c) => c.owner === null && c.houses === 0), "全部无主");
});

check("移动与经过起点：越过 40 格得 $200", () => {
  const players = rules.createPlayers(2);
  const cells = rules.createCellStates();
  // 1. 玩家 0 在 38，掷 4：落到 (38+4)%40=2（机会格，不触发购买），经过起点 +200。
  players[0].pos = 38;
  const applied = rules.applyRoll({ players, cells, turn: 0, dice: 4, chanceBonus: rules.CHANCE_BONUS });
  assertEq(applied.players[0].pos, 2, "新位置");
  assertEq(applied.players[0].money, rules.START_MONEY + rules.GO_BONUS + rules.CHANCE_BONUS, "经过起点奖励 + 机会金额");
  assertEq(applied.turn, 1, "轮次推进");
  assertEq(applied.over, false, "未终局");
});

check("监狱：落到进监狱格回到 10 号格并停一回合", () => {
  const players = rules.createPlayers(2);
  const cells = rules.createCellStates();
  // 1. 玩家 0 在 28，掷 2：落到 30（进监狱）。
  players[0].pos = 28;
  const applied = rules.applyRoll({ players, cells, turn: 0, dice: 2, chanceBonus: rules.CHANCE_BONUS });
  assertEq(applied.players[0].pos, rules.JAIL_INDEX, "回到监狱格");
  assertEq(applied.players[0].jailed, 1, "标记停一回合");
  // 2. 下一回合：不移动，只消耗停回合。
  const next = rules.applyRoll({ players: applied.players, cells: applied.cells, turn: 0, dice: 5, chanceBonus: rules.CHANCE_BONUS });
  assertEq(next.players[0].pos, rules.JAIL_INDEX, "仍在监狱格");
  assertEq(next.players[0].jailed, 0, "停回合已消耗");
  assertEq(next.turn, 1, "轮次推进");
});

check("税格与机会格：按注入金额结算", () => {
  const players = rules.createPlayers(2);
  const cells = rules.createCellStates();
  // 1. 玩家 0 在 3，掷 1：落到 4（关税 $100）。
  players[0].pos = 3;
  const taxed = rules.applyRoll({ players, cells, turn: 0, dice: 1, chanceBonus: rules.CHANCE_BONUS });
  assertEq(taxed.players[0].money, rules.START_MONEY - 100, "支付关税");
  // 2. 玩家 0 在 1，掷 1：落到 2（机会），注入 -$80。
  players[0].pos = 1;
  const chanced = rules.applyRoll({ players, cells, turn: 0, dice: 1, chanceBonus: rules.CHANCE_PENALTY });
  assertEq(chanced.players[0].money, rules.START_MONEY - 80, "机会支出");
  // 3. 同样位置注入 +$120。
  const rewarded = rules.applyRoll({ players, cells, turn: 0, dice: 1, chanceBonus: rules.CHANCE_BONUS });
  assertEq(rewarded.players[0].money, rules.START_MONEY + 120, "机会奖励");
});

check("待购买：落到无主且买得起的地块进入待购买，轮次不推进", () => {
  const players = rules.createPlayers(2);
  const cells = rules.createCellStates();
  // 1. 玩家 0 在 0，掷 1：落到 1（巴西 $120，无主且买得起）。
  const applied = rules.applyRoll({ players, cells, turn: 0, dice: 1, chanceBonus: rules.CHANCE_BONUS });
  assert(applied.pendingPurchase, "应进入待购买");
  assertEq(applied.pendingPurchase.playerIndex, 0, "待购买玩家");
  assertEq(applied.pendingPurchase.cellIndex, 1, "待购买地块");
  assertEq(applied.turn, 0, "轮次不推进");
});

check("买入：归属 + 1 所房 + 扣款 + 房产清单；跳过则无变化", () => {
  const players = rules.createPlayers(2);
  const cells = rules.createCellStates();
  const pending = { playerIndex: 0, cellIndex: 1 };
  // 1. 买入。
  const bought = rules.applyPurchase({ players, cells, pendingPurchase: pending, buy: true });
  assertEq(bought.cells[1].owner, 0, "地块归属");
  assertEq(bought.cells[1].houses, 1, "记 1 所房");
  assertEq(bought.players[0].money, rules.START_MONEY - 120, "扣款");
  assertEq(bought.players[0].properties, ["巴西"], "房产清单");
  assertEq(bought.turn, 1, "轮次推进");
  // 2. 跳过。
  const skipped = rules.applyPurchase({ players, cells, pendingPurchase: pending, buy: false });
  assertEq(skipped.cells[1].owner, null, "仍无主");
  assertEq(skipped.players[0].money, rules.START_MONEY, "不扣款");
  assertEq(skipped.players[0].properties, [], "无房产");
});

check("租金：落到他人地块支付 基础租金 + 房数×25", () => {
  const players = rules.createPlayers(2);
  const cells = rules.createCellStates();
  // 1. 玩家 1 拥有 1 号格（巴西，租金 30）且记 1 所房：租金 = 30 + 25 = 55。
  cells[1].owner = 1;
  cells[1].houses = 1;
  players[0].pos = 0;
  const applied = rules.applyRoll({ players, cells, turn: 0, dice: 1, chanceBonus: rules.CHANCE_BONUS });
  assertEq(applied.players[0].money, rules.START_MONEY - 55, "支付租金");
  assertEq(applied.players[1].money, rules.START_MONEY + 55, "房主收租");
  // 2. 落到自己地块：无事。
  cells[1].owner = 0;
  const own = rules.applyRoll({ players, cells, turn: 0, dice: 1, chanceBonus: rules.CHANCE_BONUS });
  assertEq(own.players[0].money, rules.START_MONEY, "自己地块不付租");
});

check("破产：现金 < 0 立即终局且轮次不推进", () => {
  const players = rules.createPlayers(2);
  const cells = rules.createCellStates();
  // 1. 玩家 0 只有 $50，落到 4 号关税格（$100）：现金 -50 < 0 破产。
  players[0].money = 50;
  players[0].pos = 3;
  const applied = rules.applyRoll({ players, cells, turn: 0, dice: 1, chanceBonus: rules.CHANCE_BONUS });
  assertEq(applied.players[0].money, -50, "现金为负");
  assertEq(applied.over, true, "立即终局");
  assertEq(applied.turn, 0, "轮次停在破产者");
  assert(applied.status.includes("破产"), `状态应含破产，实际 ${applied.status}`);
});

check("纯函数性：入参不被修改", () => {
  const players = rules.createPlayers(2);
  const cells = rules.createCellStates();
  players[0].pos = 38;
  const snapshot = JSON.stringify({ players, cells });
  rules.applyRoll({ players, cells, turn: 0, dice: 5, chanceBonus: rules.CHANCE_BONUS });
  rules.applyPurchase({ players, cells, pendingPurchase: { playerIndex: 0, cellIndex: 1 }, buy: true });
  assertEq(JSON.stringify({ players, cells }), snapshot, "入参未被修改");
});

(async () => {
  // 1. 汇总结果。
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
