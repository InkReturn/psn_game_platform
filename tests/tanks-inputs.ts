import assert from "node:assert/strict";
import { BattleRoom } from "../vendor/tanks-service/src/rooms/BattleRoom";
import { BattleState, TankState } from "../vendor/tanks-service/src/schema/BattleState";

/**
 * 用无网络、无时钟的接收器执行真实输入处理器，不创建游戏服务器或真实房间。
 * @returns {void} 30 个合法、非法和身份边界均通过；失败抛断言错误。
 */
function main(): void {
  // 1. 只复用真实 onCreate 的纯内存初始化，阻止定时器和网络启动。
  const handlers = new Map<string, Function>();
  const receiver: any = {
    state: new BattleState(), blocks: [], pickSpawns: [],
    /** @param name 原版消息名。 @param handler 实际处理器。 @returns 无返回值；仅保存纯本地回调。 */
    onMessage(name: string, handler: Function) { // 1. 记录，不接收网络。
      handlers.set(name, handler);
    },
    /** @param _callback 不执行的模拟回调。 @param interval 原版毫秒间隔。 @returns 无返回值；不创建时钟。 */
    setSimulationInterval(_callback: Function, interval: number) { // 1. 只核对节拍。
      assert.equal(interval, 50);
    },
  };
  BattleRoom.prototype.onCreate.call(receiver);
  assert.equal(handlers.size, 4);
  const tank = new TankState();
  receiver.state.tanks.set("qa", tank);
  const client = { sessionId: "qa" };
  let passed = 0;
  // 2. 合法方向保留原值；非有限、超范围和非数值都不能修改方向。
  for (const vector of [{ x: 1, y: 0 }, { x: -0.5, y: 1 }, { x: 0, y: 0 }]) {
    handlers.get("move")!(client, vector);
    assert.equal(tank.dirX, vector.x); assert.equal(tank.dirY, vector.y); passed++;
  }
  for (const vector of [null, undefined, { x: NaN, y: 0 }, { x: 1, y: Infinity }, { x: 2, y: 0 }, { x: -2, y: 0 }, { x: "1", y: 0 }, { x: 0, y: null }, { x: 0 }, {}, { x: 0, y: -Infinity }]) {
    tank.dirX = 0; tank.dirY = 0; handlers.get("move")!(client, vector);
    assert.equal(tank.dirX, 0); assert.equal(tank.dirY, 0); passed++;
  }
  // 3. 原版归一化角度可用，非法角度不污染 Schema。
  for (const angle of [0, 90, 359, 359.5]) { handlers.get("target")!(client, angle); assert.equal(tank.angle, angle); passed++; }
  for (const angle of [NaN, Infinity, -Infinity, 360, -1, 1e12, "90", null, undefined, {}]) {
    tank.angle = 90; handlers.get("target")!(client, angle); assert.equal(tank.angle, 90); passed++;
  }
  // 4. 不存在的连接和已删除坦克仍无法修改状态。
  handlers.get("move")!({ sessionId: "other" }, { x: 1, y: 1 }); assert.equal(tank.dirX, 0); passed++;
  tank.deleted = true; handlers.get("target")!(client, 180); assert.equal(tank.angle, 90); passed++;
  assert.equal(passed, 30);
  console.log(`${passed}/30 tank input boundary cases passed (no network, no timers)`);
}
main();
