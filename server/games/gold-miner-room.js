"use strict";
const {RoomBase}=require("../rooms/room-base");
const {ErrorCodes}=require("../protocol/errors");
const {makeMessage}=require("../protocol/messages");
const {DISCONNECT_GRACE_MS}=require("../config");
const rules=require("../../gold-miner-rules");

class GoldMinerRoom extends RoomBase {
  /** 建立黄金矿工房间，比赛配置仅在start意图中严格校验。
   * @param {string} roomId - 八位房间码。
   * @param {object} payload - 建房负载；不采纳比赛模式、时长或客户端游戏状态。
   * @param {object} options - 可注入now毫秒钟及set/clearInterval、set/clearTimeout；默认真实计时。
   * @returns {GoldMinerRoom} 等待态房间，未启动比赛资源；建房配置不产生规则异常。
   */
  constructor(roomId,payload={},options={}) {
    // 1. 建立成员管理并注入可确定性测试的时钟与资源管理器。
    super(roomId,"gold-miner");
    this.maxPlayers=rules.MAX_PLAYERS;this.status="waiting";this.seats=[];
    this._clock=options.now||Date.now;this._lastNow=0;this.now=this.readServerTime.bind(this);
    this.scheduleInterval=options.setInterval||setInterval;this.cancelInterval=options.clearInterval||clearInterval;
    this.scheduleTimeout=options.setTimeout||setTimeout;this.cancelTimeout=options.clearTimeout||clearTimeout;
    // 2. 建房只建立默认等待态，客户端夹带非法配置不能使房间构造抛错。
    void payload;
    this.game=rules.createGame();this._advanceTimer=null;
  }
  /** 读取房间唯一的业务与公开时间，高水位覆盖尚未推进时导出的快照。
   * @returns {number} 不小于此前任何读取的服务器毫秒；更新房间时钟高水位，不推进规则或广播。
   */
  readServerTime() {
    // 1. 同一时钟出口同时用于动作、推进和公开快照，墙钟回拨不能让展示倒退。
    this._lastNow = Math.max(this._lastNow, this._clock());
    return this._lastNow;
  }
  /** 分配稳定座位但不开局。@param {object} player - 已登记成员。@param {string} role - host/guest。@returns {void} 更新座位与角色，不重置对局。 */
  seatPlayer(player,role) {
    // 1. 找未占座位，晚加入仍只作为等待者。
    const occupied=new Set(this.seats.map(seatNumber));
    let seat=0;while(occupied.has(seat)) seat+=1;
    this.seats.push({playerId:player.playerId,nickname:player.nickname,seat});player.role=role;this.touch();
  }
  /** 获取身份座位。@param {string} playerId - 登记身份。@returns {number|null} 稳定座位，不存在为null。 */
  seatIndexOf(playerId) {
    // 1. 搜索座位，不依赖数组移除后下标。
    for(const seat of this.seats) if(seat.playerId===playerId) return seat.seat;
    return null;
  }
  /** 恢复在线连接。@param {string} playerId - 登记身份。@param {object} conn - 新连接。@returns {boolean} 是否恢复；清理宽限定时器但不重置矿场。 */
  attach(playerId,conn) {
    // 1. 取消注入的宽限资源，再由基类完成连接替换。
    const timer=this._graceTimers.get(playerId);
    if(timer!==undefined){this.cancelTimeout(timer);this._graceTimers.delete(playerId);}
    this.tick();return super.attach(playerId,conn);
  }
  /** 断线保留90秒座位。@param {string} playerId - 登记身份。@returns {boolean} 是否保留；不暂停已经下钩的回收。 */
  detach(playerId) {
    // 1. 标记离线但保留比赛身份和推进timer。
    const p=this.players.get(playerId);if(!p)return false;
    p.conn=null;p.connected=false;p.disconnectedAt=this.now();this.touch();
    // 2. 使用注入调度器，宽限到期真正移除。
    if(!this._graceTimers.has(playerId)) {
      /** 到期冻结退出成绩。@returns {void} 清理宽限并广播退出快照。 */
      const expire=()=>{
        // 1. 删除定时器登记后执行权威退出。
        this._graceTimers.delete(playerId);this.removePlayer(playerId,"grace-expired");
      };
      const timer=this.scheduleTimeout(expire,DISCONNECT_GRACE_MS);if(timer&&timer.unref)timer.unref();this._graceTimers.set(playerId,timer);
    }
    return true;
  }
  /** 移除前先推进权威时间。@param {string} playerId - 离开身份。@param {string} reason - leave/grace-expired等。@returns {object|null} 被移除成员；释放宽限资源。 */
  removePlayer(playerId,reason) {
    // 1. 冻结离开前全部物理事件，清理注入的宽限资源。
    if(!this.players.has(playerId))return null;
    const now = this.now();
    // 1.1 一次退出只取一次业务时间，防止tick和depart跨截止形成两个终局owner。
    this.tick(now);this.game=rules.depart(this.game,playerId,now);
    const timer=this._graceTimers.get(playerId);if(timer!==undefined){this.cancelTimeout(timer);this._graceTimers.delete(playerId);}
    return super.removePlayer(playerId,reason);
  }
  /** 处理成员离开。@param {object} player - 被移除成员。@param {string} reason - 离开原因。@returns {void} 转移host/role、回收空房timer并广播生命周期。 */
  onPlayerRemoved(player,reason) {
    // 1. 释放成员座位，不移除冻结的比赛结果。
    this.seats=this.seats.filter(keepSeat.bind(null,player.playerId));
    // 2. 房主交接优先在线，再按稳定座位。
    if(player.host){const remaining=[...this.players.values()].sort(this.compareHosts.bind(this));if(remaining[0]){remaining[0].host=true;remaining[0].role="host";}}
    if(this.isEmpty())this.releaseTimer();
    this.broadcastEventWithSnapshot("room.player_left",{playerId:player.playerId,nickname:player.nickname,reason});
  }
  /** 比较房主继任资格。@param {object} a - 候选成员。@param {object} b - 候选成员。@returns {number} 在线优先、座位优先。 */
  compareHosts(a,b) {
    // 1. 优先在线，随后采用固定座位。
    return Number(b.connected)-Number(a.connected)||this.seatIndexOf(a.playerId)-this.seatIndexOf(b.playerId);
  }
  /** 广播断线生命周期。@param {object} player - 离线成员。@returns {void} 保座位并推送公共快照。 */
  onPlayerDisconnected(player) {
    // 1. 当前物理状态照常推进，不冻结离线成绩。
    this.tick();this.broadcastEventWithSnapshot("room.player_disconnected",{playerId:player.playerId,nickname:player.nickname,connected:false});
  }
  /** 生成公开快照。@returns {object} 深拷贝room/game，不泄漏连接或重连凭据。 */
  snapshot() {
    // 1. 快照不推进物理，避免广播递归和非法动作产生副作用。
    return {room:this.describe(),game:this.gameSnapshot()};
  }
  /** 导出公共游戏状态。@returns {object} 深拷贝、服务器时间为毫秒。 */
  gameSnapshot() {
    // 1. 只通过规则拥有者导出状态。
    return rules.snapshot(this.game,this.now());
  }
  /** 下发当前状态响应。@param {object|null} ctx - playerId/requestId关联，缺省为广播。@returns {void} 仅请求者保留原requestId。 */
  broadcastGame(ctx=null) {
    // 1. 为所有在线连接发送同一权威快照。
    const snapshot=this.snapshot();
    for(const p of this.players.values())if(p.connected&&p.conn)p.conn.send(makeMessage("game.updated",{snapshot},ctx&&ctx.playerId===p.playerId?ctx.requestId:null));
  }
  /** 推进服务器时间，是比赛终局同步与资源释放的唯一出口。
   * @param {number} nowMs - 本次操作捕获的服务器毫秒时间，缺省只读取一次当前时钟。
   * @returns {void} 广播物理推进；终局幂等且释放资源。
   */
  tick(nowMs = this.now()) {
    // 1. 等待和终局无物理推进，一次推进只使用同一个业务时间。
    if(this.game.phase!=="playing")return;
    const before=this.game.phase;this.game=rules.advance(this.game,nowMs);this.status=this.game.phase;this.broadcastGame();
    // 2. 终局仅推送一次生命周期事件。
    if(before!==this.game.phase){this.releaseTimer();this.broadcastSnapshot({event:"game_finished"});}
  }
  /** 释放推进timer。@returns {void} 幂等资源回收，不影响宽限重连。 */
  releaseTimer() {
    // 1. 对注入的资源释放器只调用一次。
    if(this._advanceTimer!==null){this.cancelInterval(this._advanceTimer);this._advanceTimer=null;}
  }
  /** 处理唯一允许的意图。@param {object} player - 从连接绑定取得的当前成员对象，必须仍登记且online。@param {object} action - 仅start配置或drop；其他字段全部忽略。@param {string|null} requestId - 原请求标识。@returns {object} ok/code，非法请求不修改状态或广播。 */
  handleAction(player,action,requestId=null) {
    // 1. 防止伪造对象、已退出对象和离线成员发送操作。
    if(!player||this.players.get(player.playerId)!==player||!player.connected||!player.conn)return {ok:false,code:ErrorCodes.UNAUTHORIZED_PLAYER};
    if(!action||typeof action!=="object")return {ok:false,code:ErrorCodes.INVALID_ACTION};
    const now=this.now(),ctx={playerId:player.playerId,requestId};
    // 2. start只允许等待或结算态房主；先完整校验，失败不清空上一局分数。
    if(action.action==="start"){
      if(!player.host)return {ok:false,code:ErrorCodes.INVALID_ACTION};
      if(!["waiting","finished"].includes(this.game.phase))return {ok:false,code:ErrorCodes.INVALID_ACTION};
      const participants=[];for(const s of this.seats){const p=this.players.get(s.playerId);if(p&&p.connected)participants.push({...s});}
      try{this.game=rules.start(this.game,participants,now,{mode:action.mode===undefined?this.game.mode:action.mode,durationSeconds:action.durationSeconds===undefined?this.game.durationSeconds:action.durationSeconds});}
      catch(error){if(error instanceof RangeError)return {ok:false,code:ErrorCodes.INVALID_ACTION};throw error;}
      this.status="playing";this._advanceTimer=this.scheduleInterval(this.tick.bind(this),50);if(this._advanceTimer&&this._advanceTimer.unref)this._advanceTimer.unref();
      this.broadcastGame(ctx);this.broadcastSnapshot({event:"game_started"});return {ok:true};
    }
    // 3. drop完全忽略客户端的angle/score/target/playerId/time/minerals等。
    if(action.action==="drop"){
      const result=rules.drop(this.game,player.playerId,now);
      // 3.1 合法房间成员可能是晚加入等待者，不把不能参赛误报为身份失效。
      if(!result.ok)return {ok:false,code:result.reason==="UNAUTHORIZED_PLAYER"?ErrorCodes.INVALID_ACTION:result.reason};
      this.game=result.game;this.broadcastGame(ctx);return {ok:true};
    }
    return {ok:false,code:ErrorCodes.INVALID_ACTION};
  }
}
/** 读取稳定座位。@param {object} seat - 登记座位。@returns {number} 座位编号。 */
function seatNumber(seat){
  // 1. 提取编号以检测占用。
  return seat.seat;
}
/** 保留其他成员座位。@param {string} id - 离开身份。@param {object} seat - 座位。@returns {boolean} 是否保留。 */
function keepSeat(id,seat){
  // 1. 仅回收目标成员的座位。
  return seat.playerId!==id;
}
module.exports={GoldMinerRoom};
