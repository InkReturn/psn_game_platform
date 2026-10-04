"use strict";
/** 创建跨浏览器与服务器共用的唯一物理规则；无外部副作用。@returns {object} 规则接口。 */
(function publish() {
  // 1. 建立固定单位：坐标为逻辑像素，速度为像素/秒，时间为毫秒。
  const MIN_PLAYERS = 2, MAX_PLAYERS = 6, DEFAULT_DURATION_SECONDS = 90;
  const MIN_DURATION_SECONDS = 10, MAX_DURATION_SECONDS = 600, WIDTH = 960, HEIGHT = 620;
  const EXTEND_SPEED = 300, RETURN_SPEED = 360, SWING_PERIOD_MS = 4000, MAX_ANGLE = 1.15;
  const KINDS = Object.freeze({ gold: Object.freeze({radius:24,value:250,weight:2}), diamond: Object.freeze({radius:14,value:600,weight:1}), rock: Object.freeze({radius:28,value:30,weight:4}) });
  /** 深拷贝纯可序列化状态。@param {object} value - 无连接的规则状态。@returns {object} 独立副本；不修改输入。 */
  function clone(value) {
    // 1. 复制全部嵌套数据。
    return JSON.parse(JSON.stringify(value));
  }
  /** 严格校验配置。@param {object} options - 默认空对象；mode 为 shared/independent，缺省shared；durationSeconds 为整数秒10–600，缺省90。@returns {object} 配置。@throws {RangeError} 配置非法。 */
  function configuration(options = {}) {
    // 1. 只对缺省字段采用默认值，不进行字符串或空值转换。
    const mode = options.mode === undefined ? "shared" : options.mode;
    const durationSeconds = options.durationSeconds === undefined ? DEFAULT_DURATION_SECONDS : options.durationSeconds;
    if (!["shared", "independent"].includes(mode) || !Number.isInteger(durationSeconds) || durationSeconds < MIN_DURATION_SECONDS || durationSeconds > MAX_DURATION_SECONDS) throw new RangeError("invalid configuration");
    return {mode,durationSeconds};
  }
  /** 生成服务器决定的左右镜像矿石模板。
   * @param {number} seed - 本局服务器种子，默认0；仅控制安全锚点附近的12像素扰动，不用于身份或安全随机。
   * @returns {object} 独立矿场对象，非重叠、可触达；镜像保持两侧价值平衡。
   */
  function createField(seed = 0) {
    // 1. 在已验证的安全锚点附近扰动，让下一局布局变化而不破坏边界和可触达性。
    const rows = [[180,250,"gold"],[300,350,"diamond"],[110,450,"rock"],[400,490,"gold"],[260,550,"rock"]];
    const minerals = [];
    let state = seed >>> 0;
    for (const [anchorX,anchorY,kind] of rows) {
      state = (Math.imul(state,1664525)+1013904223) >>> 0;
      const x = anchorX + state % 25 - 12;
      state = (Math.imul(state,1664525)+1013904223) >>> 0;
      const y = anchorY + state % 25 - 12;
      // 2. 同一对矿石共享种类和纵坐标，水平严格镜像，所有规则取自唯一种类表。
      for (const px of [x, WIDTH-x]) minerals.push({id:`m${minerals.length+1}`,kind,x:px,y,...KINDS[kind],status:"available",claimedBy:null});
    }
    return {minerals};
  }
  /** 建立等待态。@param {object} options - 严格配置，允许缺省。@returns {object} 新状态。@throws {RangeError} 配置非法。 */
  function createGame(options = {}) {
    // 1. 初始化公共字段以及仅供权威推进的时间游标。
    return {round:0,phase:"waiting",...configuration(options),serverNow:0,startedAt:null,endsAt:null,fields:{},miners:[],rankings:[],message:"等待房主开始",_time:0};
  }
  /** 冻结开局名单。@param {object} game - 等待态或已结算状态；正在比赛不能重开。@param {object[]} participants - 2–6名在线身份，含playerId/nickname/seat。@param {number} nowMs - 服务器毫秒。@param {object} options - 缺省采用等待态配置。@returns {object} 新对局。@throws {RangeError} 状态、人数或配置非法。 */
  function start(game, participants, nowMs, options = {}) {
    // 1. 校验后一次性构造对局，不修改原状态。
    const config = configuration({...configuration(game),...options});
    if (!["waiting","finished"].includes(game.phase) || participants.length < MIN_PLAYERS || participants.length > MAX_PLAYERS) throw new RangeError("cannot start");
    const result = createGame(config), template = createField(Math.floor(nowMs) + (game.round + 1) * 7919);
    Object.assign(result,{round:game.round+1,phase:"playing",serverNow:nowMs,startedAt:nowMs+3000,endsAt:nowMs+3000+config.durationSeconds*1000,_time:nowMs,message:"准备开始"});
    // 2. 共享横向原点；独立使用同一中心原点并深拷贝唯一模板。
    for (let i=0;i<participants.length;i+=1) {
      const p=participants[i], origin={x:config.mode==="shared" ? 160+i*640/(participants.length-1) : WIDTH/2,y:90};
      result.miners.push({playerId:p.playerId,nickname:p.nickname,seat:p.seat===undefined?i:p.seat,score:0,collectedCount:0,departed:false,hook:{phase:"idle",origin,angle:0,length:0,motionAt:result.startedAt,motionLength:0,speed:0,targetId:null}});
      if (config.mode==="independent") result.fields[p.playerId]=clone(template);
    }
    if (config.mode==="shared") result.fields.shared=template;
    return result;
  }
  /** 计算钩子只读姿态。@param {object} miner - 带hook的矿工。@param {object} game - 对局计时状态。@param {number} timeMs - 服务器时间毫秒。@returns {{origin:object,tip:object,angle:number,length:number}} 弧度角从竖直向下向右为正；坐标/长度为像素。 */
  function hookPose(miner,game,timeMs) {
    // 1. 空闲自动摆动，运动钩按冻结角度及分段速度推导。
    const h=miner.hook, t=Math.min(timeMs,game.endsAt===null?timeMs:game.endsAt);
    const angle=h.phase==="idle" ? MAX_ANGLE*Math.sin(Math.max(0,t-(game.startedAt||t))*2*Math.PI/SWING_PERIOD_MS) : h.angle;
    const length=h.phase==="idle"?0:Math.max(0,h.motionLength+(t-h.motionAt)*h.speed/1000);
    return {origin:{...h.origin},tip:{x:h.origin.x+Math.sin(angle)*length,y:h.origin.y+Math.cos(angle)*length},angle,length};
  }
  /** 获得矿工所属矿场。@param {object} game - 对局。@param {object} miner - 参赛矿工。@returns {object} 权威矿场引用，仅内部使用。 */
  function fieldFor(game,miner) {
    // 1. 按模式选择唯一矿场。
    return game.fields[game.mode==="shared"?"shared":miner.playerId];
  }
  /** 钩射线到边界的距离。@param {object} hook - 包含origin与冻结弧度angle。@returns {number} 最大延伸像素。 */
  function boundary(hook) {
    // 1. 求前进射线最先触及的下边界或侧边界。
    const dx=Math.sin(hook.angle),dy=Math.cos(hook.angle);
    return Math.min((HEIGHT-hook.origin.y)/dy,dx>0?(WIDTH-hook.origin.x)/dx:dx<0?-hook.origin.x/dx:Infinity);
  }
  /** 求连续射线首次接触矿石的长度。@param {object} hook - 冻结角度与原点。@param {object} mineral - 中心/半径像素。@returns {number} 首次接触长度，不相交为Infinity。 */
  function contactLength(hook,mineral) {
    // 1. 用射线圆相交的近端根避免离散整帧跳过碰撞。
    const x=mineral.x-hook.origin.x,y=mineral.y-hook.origin.y;
    const along=x*Math.sin(hook.angle)+y*Math.cos(hook.angle), perpendicular=x*x+y*y-along*along;
    if (along<0 || perpendicular>mineral.radius*mineral.radius) return Infinity;
    return Math.max(0,along-Math.sqrt(Math.max(0,mineral.radius*mineral.radius-perpendicular)));
  }
  /** 构造金额排名。@param {object} game - 含冻结矿工名单。@returns {object[]} 退出者保留金额但rank为null，不具获胜资格；同分1,1,3。 */
  function rankings(game) {
    // 1. 活跃者金额降序、座位稳定，退出者放末尾。
    const list=game.miners.slice().sort(compareMiners), result=[];
    let active=0,lastScore=null,lastRank=0;
    for (const m of list) {
      if (!m.departed) { active+=1; if (m.score!==lastScore) lastRank=active; lastScore=m.score; }
      result.push({playerId:m.playerId,nickname:m.nickname,score:m.score,rank:m.departed?null:lastRank,departed:m.departed});
    }
    return result;
  }
  /** 稳定比较排名。@param {object} a - 前矿工。@param {object} b - 后矿工。@returns {number} 排序差。 */
  function compareMiners(a,b) {
    // 1. 退出无资格，再按金额与座位。
    return Number(a.departed)-Number(b.departed)||b.score-a.score||a.seat-b.seat;
  }
  /** 比较全体物理事件。@param {object} a - 候选事件。@param {object} b - 候选事件。@returns {number} 连续时间优先，同刻座位优先。 */
  function compareEvents(a,b) {
    // 1. 不按玩家整帧顺序裁决，精确时间排序。
    return a.at-b.at||a.miner.seat-b.miner.seat;
  }
  /** 纯推进任意时间跨度。@param {object} game - 权威状态，不修改。@param {number} nowMs - 单调服务器时间毫秒。@returns {object} 新状态；截止前完成才计分，终局幂等。 */
  function advance(game,nowMs) {
    // 1. 克隆并限制截止时间，已终局仅更新服务器展示时间。
    const g=clone(game);
    // 1.1 墙钟短暂回拨不能倒退运动段或展示时间，游标仍是唯一物理时间源。
    const currentTime = Math.max(g._time, g.serverNow, nowMs);
    g.serverNow=currentTime;
    if (g.phase!=="playing") return g;
    const cutoff=Math.min(currentTime,g.endsAt);
    // 2. 每次重新求全体下一事件，释放/认领后重算，覆盖大时间跳跃。
    for (;;) {
      const events=[];
      for (const m of g.miners) {
        const h=m.hook;
        if (m.departed || h.phase==="idle") continue;
        if (h.phase==="retracting") { events.push({at:h.motionAt+h.motionLength/(-h.speed)*1000,miner:m,type:"return"}); continue; }
        let length=boundary(h),target=null;
        for (const mineral of fieldFor(g,m).minerals) {
          if (mineral.status!=="available") continue;
          const hit=contactLength(h,mineral),current=hookPose(m,g,g._time).length;
          if (hit+1e-9<current || hit>=length) continue;
          length=hit;target=mineral;
        }
        events.push({at:h.motionAt+(length-h.motionLength)/h.speed*1000,miner:m,type:"contact",length,target});
      }
      events.sort(compareEvents);
      const event=events[0];
      if (!event || event.at>cutoff) break;
      g._time=event.at;
      const h=event.miner.hook;
      if (event.type==="contact") {
        h.phase="retracting";h.motionAt=event.at;h.motionLength=event.length;h.length=event.length;
        h.speed=-RETURN_SPEED/(event.target?event.target.weight:1);h.targetId=event.target?event.target.id:null;
        if (event.target) { event.target.status="claimed";event.target.claimedBy=event.miner.playerId; }
      } else {
        const mineral=fieldFor(g,event.miner).minerals.find(findTarget.bind(null,h.targetId));
        if (mineral && mineral.status === "claimed" && mineral.claimedBy === event.miner.playerId && event.at<g.endsAt) { mineral.status="collected";event.miner.score+=mineral.value;event.miner.collectedCount+=1; }
        h.phase="idle";h.length=0;h.motionLength=0;h.motionAt=event.at;h.speed=0;h.targetId=null;
      }
    }
    // 3. 固化展示长度，截止后不再推进或额外计分。
    g._time=Math.max(g._time,cutoff);
    for (const m of g.miners) m.hook.length=hookPose(m,g,cutoff).length;
    if (currentTime>=g.endsAt) { g.phase="finished";g.message="本局结束"; }
    g.rankings=rankings(g);
    return g;
  }
  /** 匹配钩上矿石。@param {string|null} id - 目标矿石ID。@param {object} mineral - 候选矿石。@returns {boolean} 是否匹配。 */
  function findTarget(id,mineral) {
    // 1. 使用矿场内唯一ID匹配。
    return mineral.id===id;
  }
  /** 执行下钩意图。@param {object} game - 权威状态。@param {string} playerId - 连接认证身份。@param {number} nowMs - 服务器毫秒。@returns {object} {ok,game,reason}；失败不改变输入，角度只由服务器冻结。 */
  function drop(game,playerId,nowMs) {
    // 1. 校验名单、倒计时、截止及钩状态，失败无副作用。
    nowMs = Math.max(nowMs, game._time, game.serverNow);
    const m=game.miners.find(findMiner.bind(null,playerId));
    if (!m || m.departed) return {ok:false,game,reason:"UNAUTHORIZED_PLAYER"};
    if (game.phase==="finished" || nowMs>=game.endsAt) return {ok:false,game,reason:"GAME_ALREADY_FINISHED"};
    if (game.phase!=="playing" || nowMs<game.startedAt) return {ok:false,game,reason:"GAME_NOT_STARTED"};
    const g=advance(game,nowMs),miner=g.miners.find(findMiner.bind(null,playerId));
    if (miner.hook.phase!=="idle") return {ok:false,game,reason:"INVALID_ACTION"};
    // 2. 仅将当前服务器摆动角固定为运动段起点。
    const pose=hookPose(miner,g,nowMs);
    Object.assign(miner.hook,{phase:"extending",angle:pose.angle,length:0,motionLength:0,motionAt:nowMs,speed:EXTEND_SPEED,targetId:null});
    return {ok:true,game:g};
  }
  /** 匹配冻结身份。@param {string} id - 认证身份。@param {object} miner - 候选矿工。@returns {boolean} 是否匹配。 */
  function findMiner(id,miner) {
    // 1. 比较服务端身份。
    return miner.playerId===id;
  }
  /** 退出并冻结金额。@param {object} game - 权威状态。@param {string} playerId - 退出身份。@param {number} nowMs - 服务器毫秒，先推进再冻结。@returns {object} 新状态，释放未回收矿石，不修改其他金额。 */
  function depart(game,playerId,nowMs) {
    // 1. 补齐退出前物理事件，再标记退出并释放钩上矿石。
    const g=advance(game,nowMs),m=g.miners.find(findMiner.bind(null,playerId));
    if (!m || m.departed) return g;
    m.departed=true;
    for (const mineral of fieldFor(g,m).minerals) if (mineral.status==="claimed" && mineral.claimedBy===playerId) { mineral.status="available";mineral.claimedBy=null; }
    Object.assign(m.hook,{phase:"idle",length:0,motionLength:0,speed:0,targetId:null});
    g.rankings=rankings(g);return g;
  }
  /** 导出无内部游标快照。@param {object} game - 权威状态。@param {number} nowMs - 展示服务器毫秒，不隐式推进。@returns {object} 完全深拷贝公共状态。 */
  function snapshot(game,nowMs) {
    // 1. 剔除内部游标并深拷贝公开字段。
    const result=clone(game);delete result._time;result.serverNow=Math.max(nowMs,game.serverNow,game._time);return result;
  }
  // 2. 同一接口同时供CommonJS服务器与浏览器使用。
  const api={MIN_PLAYERS,MAX_PLAYERS,DEFAULT_DURATION_SECONDS,MIN_DURATION_SECONDS,MAX_DURATION_SECONDS,WIDTH,HEIGHT,EXTEND_SPEED,RETURN_SPEED,SWING_PERIOD_MS,MAX_ANGLE,KINDS,configuration,createField,createGame,start,hookPose,advance,drop,depart,snapshot,rankings,contactLength,boundary};
  if (typeof module!=="undefined" && module.exports) module.exports=api;
  if (typeof window!=="undefined") window.GoldMinerRules=api;
})();
