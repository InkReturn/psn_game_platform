"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {GoldMinerRoom}=require("../server/games/gold-miner-room");
/** 构造无真实timer/网络的权威fixture。@param {number} count - 成员数1–6，默认2。@returns {object} room/players/messages/timers及可控毫秒钟。 */
function fixture(count=2){
  // 1. 注入服务器时钟及可观察资源登记。
  const f={time:0,timers:new Map(),next:1,players:[],messages:[]};
  const room=new GoldMinerRoom("GMABC123",{}, {now:clock.bind(null,f),setInterval:schedule.bind(null,f,"interval"),clearInterval:cancel.bind(null,f),setTimeout:schedule.bind(null,f,"timeout"),clearTimeout:cancel.bind(null,f)});f.room=room;
  // 2. 登记固定可观察连接，首名为房主。
  for(let i=0;i<count;i+=1)add(f,i);
  return f;
}
/** 读取fixture时钟。@param {object} f - fixture。@returns {number} 毫秒时间。 */
function clock(f){/* 1. 返回当前毫秒，跨截止fixture可以让每次读取推进一毫秒。 */return f.advanceOnRead?advancingClock(f):f.time;}
/** 登记注入timer。@param {object} f - fixture。@param {string} type - interval/timeout。@param {Function} callback - 到期回调。@param {number} delay - 毫秒延迟。@returns {number} timer ID；不启动真实资源。 */
function schedule(f,type,callback,delay){/* 1. 登记回调便于确定性触发。 */const id=f.next++;f.timers.set(id,{type,callback,delay});return id;}
/** 回收注入timer。@param {object} f - fixture。@param {number} id - timer ID。@returns {void} 删除资源。 */
function cancel(f,id){/* 1. 移除登记资源。 */f.timers.delete(id);}
/** 收集协议广播。@param {object[]} messages - 当前成员消息列表。@param {object} message - 信封。@returns {void} 记录消息。 */
function receive(messages,message){/* 1. 保存协议消息。 */messages.push(message);}
/** 增加fixture成员。@param {object} f - fixture。@param {number} i - 昵称序号，0为房主。@returns {object} 登记成员对象，入座不自动开局。 */
function add(f,i){
  // 1. 创建连接及成员，调用实际房间入座与绑定。
  const messages=[],p=f.room.createPlayer(`玩家${i}`,{host:i===0});f.room.seatPlayer(p,i===0?"host":"guest");f.room.attach(p.playerId,{send:receive.bind(null,messages)});f.players.push(p);f.messages.push(messages);return p;
}
/** 发送fixture意图。@param {object} f - fixture。@param {number} index - 成员序号。@param {object} action - 客户端意图。@returns {object} 权威结果。 */
function act(f,index,action){/* 1. 使用登记对象执行实际权限入口。 */return f.room.handleAction(f.players[index],action,"req1");}
/** 执行权威场景。@param {string} name - 场景名称。@returns {void} 断言失败抛错；无真实网络或timer。 */
function run(name){
  // 1. 构造完全隔离的fixture。
  const f=fixture(),room=f.room;
  switch(name){
    case "入座不开局":assert.equal(room.game.phase,"waiting");assert.equal(room._advanceTimer,null);break;
    case "仅房主开局":assert.equal(act(f,1,{action:"start"}).code,"INVALID_ACTION");assert.equal(act(f,0,{action:"start"}).ok,true);break;
    case "不足在线人数":room.detach(f.players[1].playerId);assert.equal(act(f,0,{action:"start"}).ok,false);assert.equal(room.game.phase,"waiting");break;
    case "六人开局":{const six=fixture(6);assert.equal(act(six,0,{action:"start"}).ok,true);assert.equal(six.room.game.miners.length,6);break;}
    case "配置严格无副作用":{const before=JSON.stringify(room.game);for(const durationSeconds of [NaN,Infinity,"10",null,9,601,1.5])assert.equal(act(f,0,{action:"start",durationSeconds}).ok,false);assert.equal(JSON.stringify(room.game),before);assert.equal(f.timers.size,0);break;}
    case "合法配置冻结":assert.equal(act(f,0,{action:"start",mode:"independent",durationSeconds:10}).ok,true);assert.equal(room.game.mode,"independent");assert.equal(room.game.endsAt,13000);const before=JSON.stringify(room.game);assert.equal(act(f,0,{action:"start",durationSeconds:600}).ok,false);assert.equal(act(f,0,{action:"restart"}).ok,false);assert.equal(JSON.stringify(room.game),before);break;
    case "原请求响应与生命周期":act(f,0,{action:"start"});assert(f.messages[0].some(requestResponse));assert(f.messages[1].some(unassociatedResponse));assert(f.messages[0].some(startedSnapshot));break;
    case "伪造对象离线拒绝":act(f,0,{action:"start"});f.time=3000;assert.equal(room.handleAction({...f.players[0]},{action:"drop"}).ok,false);room.detach(f.players[0].playerId);assert.equal(act(f,0,{action:"drop"}).ok,false);break;
    case "伪造所有物理状态忽略":act(f,0,{action:"start"});f.time=3000;assert.equal(act(f,0,{action:"drop",angle:99,score:999999,target:"mine",playerId:f.players[1].playerId,time:999999,winner:"me",minerals:[]}).ok,true);assert.equal(room.game.miners[0].hook.angle,0);assert.equal(room.game.miners[0].score,0);assert.equal(room.game.miners[1].hook.phase,"idle");assert(room.game.fields.shared.minerals.length>0);break;
    case "未知及倒计时操作无副作用":act(f,0,{action:"start"});const original=JSON.stringify(room.game),messages=f.messages[0].length;for(const action of [{action:"drop"},{action:"score"},null])assert.equal(act(f,0,action).ok,false);assert.equal(JSON.stringify(room.game),original);assert.equal(f.messages[0].length,messages);break;
    case "晚加入等待不得下钩":act(f,0,{action:"start"});add(f,2);f.time=3000;assert.equal(act(f,2,{action:"drop"}).code,"INVALID_ACTION");assert.equal(room.game.miners.length,2);break;
    case "刷新替换连接不重置":act(f,0,{action:"start"});f.time=3000;act(f,0,{action:"drop"});const p=f.players[0],old=p.conn,token=p.reconnectToken;assert.equal(room.verifyReconnect(p.playerId,token),p);room.attach(p.playerId,{send:receive.bind(null,[])});assert.equal(room.isCurrentConn(p.playerId,old),false);assert.equal(room.game.round,1);assert.equal(room.game.miners[0].hook.phase,"extending");break;
    case "断线宽限90秒与恢复":act(f,0,{action:"start"});room.detach(f.players[0].playerId);const timer=[...f.timers.values()].find(timeoutTimer);assert.equal(timer.delay,90000);room.attach(f.players[0].playerId,{send:receive.bind(null,[])});assert.equal([...f.timers.values()].filter(timeoutTimer).length,0);assert.equal(room.game.miners[0].departed,false);break;
    case "expired保留结果并拒绝身份":act(f,0,{action:"start"});room.detach(f.players[0].playerId);f.time=90000;const expiredTimer=[...f.timers.values()].find(timeoutTimer);expiredTimer.callback();assert.equal(room.players.has(f.players[0].playerId),false);assert.equal(room.game.miners[0].departed,true);assert.equal(room.verifyReconnect(f.players[0].playerId,f.players[0].reconnectToken),null);assert.equal(act(f,0,{action:"drop"}).ok,false);break;
    case "房主交接优先online且role":add(f,2);room.detach(f.players[1].playerId);room.removePlayer(f.players[0].playerId,"leave");assert.equal(f.players[2].host,true);assert.equal(f.players[2].role,"host");assert.equal(f.players[1].host,false);break;
    case "离线下钩继续回收":act(f,0,{action:"start",mode:"independent"});room.game.fields[f.players[0].playerId].minerals=[{id:"x",kind:"gold",x:480,y:250,radius:10,value:250,weight:1,status:"available",claimedBy:null}];f.time=3000;act(f,0,{action:"drop"});room.detach(f.players[0].playerId);f.time=5000;room.tick();assert.equal(room.game.miners[0].score,250);assert.equal(room.game.miners[0].departed,false);break;
    case "leave先推进冻结并释放认领":act(f,0,{action:"start",mode:"independent"});room.game.fields[f.players[0].playerId].minerals=[{id:"x",kind:"gold",x:480,y:250,radius:10,value:250,weight:4,status:"available",claimedBy:null}];f.time=3000;act(f,0,{action:"drop"});f.time=3600;room.removePlayer(f.players[0].playerId,"leave");assert.equal(room.game.miners[0].score,0);assert.equal(room.game.miners[0].departed,true);assert.equal(room.game.fields[f.players[0].playerId].minerals[0].status,"available");break;
    case "结束释放timer且生命周期幂等":act(f,0,{action:"start",durationSeconds:10});f.time=13000;room.tick();assert.equal(room.status,"finished");assert.equal(f.timers.size,0);const count=f.messages[1].filter(finishedSnapshot).length;room.tick();assert.equal(f.messages[1].filter(finishedSnapshot).length,count);assert.equal(count,1);break;
    case "空房释放所有资源":act(f,0,{action:"start"});for(const p of f.players)room.removePlayer(p.playerId,"leave");assert.equal(f.timers.size,0);assert.equal(room._advanceTimer,null);break;
    case "快照深拷贝无凭据":act(f,0,{action:"start"});const s=room.snapshot(),json=JSON.stringify(s);assert(!json.includes("reconnectToken"));assert(!json.includes('"conn"'));s.game.miners[0].hook.origin.x=0;assert.notEqual(room.game.miners[0].hook.origin.x,0);break;
    case "建房不采纳非法比赛配置":{const safe=new GoldMinerRoom("GMABC124",{mode:"fake",durationSeconds:"bad",score:999});assert.equal(safe.game.phase,"waiting");assert.equal(safe.game.durationSeconds,90);break;}
    case "结算重开与房主交接":{add(f,2);act(f,0,{action:"start",durationSeconds:10});room.game.miners[1].score=250;f.time=13000;room.tick();const before=JSON.stringify(room.game);assert.equal(act(f,1,{action:"start",durationSeconds:65}).ok,false);assert.equal(act(f,0,{action:"start",durationSeconds:9}).ok,false);assert.equal(JSON.stringify(room.game),before);room.removePlayer(f.players[0].playerId,"leave");assert.equal(act(f,1,{action:"start",mode:"independent",durationSeconds:65}).ok,true);assert.equal(room.game.round,2);assert.equal(room.game.miners.length,2);assert.equal(room.game.miners[0].score,0);assert.equal(room.game.endsAt-room.game.startedAt,65000);break;}
    case "退出跨截止统一终局资源":{add(f,2);act(f,0,{action:"start",durationSeconds:10});f.time=12999;f.advanceOnRead=true;room.removePlayer(f.players[0].playerId,"leave");room.tick();assert.equal(room.game.phase,"finished");assert.equal(room.status,"finished");assert.equal(room._advanceTimer,null);assert.equal(f.timers.size,0);assert.equal(f.messages[1].filter(finishedSnapshot).length,1);f.time=20000;assert.equal(act(f,1,{action:"start",durationSeconds:10}).ok,true);assert.equal(f.timers.size,1);for(const p of [...room.players.values()])room.removePlayer(p.playerId,"leave");assert.equal(f.timers.size,0);break;}
    case "公开快照时间高水位与回拨动作":{act(f,0,{action:"start",durationSeconds:10});f.time=5000;room.tick();f.time=6000;assert.equal(room.snapshot().game.serverNow,6000);f.time=5500;assert.equal(room.snapshot().game.serverNow,6000);assert.equal(act(f,0,{action:"drop"}).ok,true);assert.equal(room.game.miners[0].hook.motionAt,6000);f.time=5400;room.tick();assert.equal(room.game.serverNow,6000);assert.equal(room.snapshot().game.serverNow,6000);break;}
    default:throw new Error(name);
  }
  // 2. fixture仅有内存资源，显式收尾以检验资源幂等。
  room.releaseTimer();
}
/** 匹配请求响应。@param {object} m - 信封。@returns {boolean} 请求者关联。 */
function requestResponse(m){/* 1. 检查关联ID。 */return m.type==="game.updated"&&m.requestId==="req1";}
/** 匹配普通广播。@param {object} m - 信封。@returns {boolean} 非请求者无关联ID。 */
function unassociatedResponse(m){/* 1. 检查广播。 */return m.type==="game.updated"&&!m.requestId;}
/** 匹配开局快照。@param {object} m - 信封。@returns {boolean} 是否开局生命周期。 */
function startedSnapshot(m){/* 1. 检查生命周期。 */return m.type==="room.snapshot"&&m.payload.event==="game_started";}
/** 匹配结束快照。@param {object} m - 信封。@returns {boolean} 是否结束生命周期。 */
function finishedSnapshot(m){/* 1. 检查生命周期。 */return m.type==="room.snapshot"&&m.payload.event==="game_finished";}
/** 匹配宽限timer。@param {object} t - 定时器记录。@returns {boolean} 是否一次性超时资源。 */
function timeoutTimer(t){/* 1. 返回资源类型。 */return t.type==="timeout";}
/** 模拟一次操作内真实时钟不断前进。
 * @param {object} f - 可控fixture，每次读取推进一毫秒。
 * @returns {number} 读取前毫秒时间，副作用是f.time加一。
 */
function advancingClock(f){
  // 1. 用递增时间暴露退出跨截止的生命周期竞态。
  return f.time++;
}
// 1. 登记真实fixture用例，不启动服务、不依赖尚未完成的注册。
for(const name of ["入座不开局","仅房主开局","不足在线人数","六人开局","配置严格无副作用","合法配置冻结","原请求响应与生命周期","伪造对象离线拒绝","伪造所有物理状态忽略","未知及倒计时操作无副作用","晚加入等待不得下钩","刷新替换连接不重置","断线宽限90秒与恢复","expired保留结果并拒绝身份","房主交接优先online且role","离线下钩继续回收","leave先推进冻结并释放认领","结束释放timer且生命周期幂等","空房释放所有资源","快照深拷贝无凭据","建房不采纳非法比赛配置","结算重开与房主交接","退出跨截止统一终局资源","公开快照时间高水位与回拨动作"])test(name,run.bind(null,name));
