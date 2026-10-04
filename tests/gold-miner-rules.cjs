"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),vm=require("node:vm"),fs=require("node:fs");
const r=require("../gold-miner-rules");
/** 建立确定性两人局。@param {string} mode - shared/independent，默认independent。@param {number} durationSeconds - 整数秒10–600，默认90。@returns {object} 从0毫秒开始、3000毫秒可下钩的局。 */
function game(mode="independent",durationSeconds=90){
  // 1. 冻结固定身份及座位。
  return r.start(r.createGame(),[{playerId:"a",nickname:"甲",seat:0},{playerId:"b",nickname:"乙",seat:1}],0,{mode,durationSeconds});
}
/** 设置便于精确验证连续物理的矿场。@param {object} g - 测试状态。@param {number} weight - 正数重量，默认1；只用于隔离回收速度的fixture。@returns {object} 状态引用；仅修改fixture，不涉及生产。 */
function target(g,weight=1){
  // 1. 固定中心钩、单枚矿石及物理段，使首次接触在3500毫秒。
  for(const m of g.miners)m.hook.origin={x:480,y:90};
  for(const field of Object.values(g.fields))field.minerals=[{id:"one",kind:"gold",x:480,y:250,radius:10,value:250,weight,status:"available",claimedBy:null}];
  return g;
}
/** 执行独立规则用例。@param {string} name - 场景名称。@returns {void} 断言失败抛错，无外部写入。 */
function run(name){
  // 1. 每例使用独立状态；覆盖严格配置、布局、快照与连续物理。
  let g=game();
  switch(name){
    case "默认配置与导出":assert.equal(r.DEFAULT_DURATION_SECONDS,90);assert.equal(r.WIDTH,960);assert.equal(r.HEIGHT,620);assert.equal(r.createGame().mode,"shared");break;
    case "浏览器导出":{const context={window:{}};vm.runInNewContext(fs.readFileSync(require.resolve("../gold-miner-rules"),"utf8"),context);assert.equal(context.window.GoldMinerRules.MAX_PLAYERS,6);break;}
    case "非法时长":for(const durationSeconds of [NaN,Infinity,"90",null,9,601,10.5])assert.throws(r.configuration.bind(null,{durationSeconds}),RangeError);break;
    case "时长边界":for(const durationSeconds of [10,600])assert.equal(r.configuration({durationSeconds}).durationSeconds,durationSeconds);break;
    case "非法模式":for(const mode of [null,"solo",0])assert.throws(r.configuration.bind(null,{mode}),RangeError);break;
    case "开局人数":for(const count of [0,1,7])assert.throws(r.start.bind(null,r.createGame(),Array(count).fill({playerId:"x"}),0),RangeError);break;
    case "三秒统一倒计时":assert.equal(g.startedAt,3000);assert.equal(g.endsAt,93000);assert.equal(r.drop(g,"a",2999).reason,"GAME_NOT_STARTED");assert.equal(r.drop(g,"a",3000).ok,true);break;
    case "独立同布局无共享引用":assert.deepEqual(g.fields.a,g.fields.b);assert.notEqual(g.fields.a.minerals[0],g.fields.b.minerals[0]);assert.deepEqual(g.miners[0].hook.origin,g.miners[1].hook.origin);g.fields.a.minerals[0].value=0;assert.notEqual(g.fields.b.minerals[0].value,0);break;
    case "共享原点分布":g=game("shared");assert.deepEqual(Object.keys(g.fields),["shared"]);assert.notEqual(g.miners[0].hook.origin.x,g.miners[1].hook.origin.x);break;
    case "矿石边界不重叠平衡可达":{const minerals=r.createField().minerals;assert.equal(new Set(minerals.map(idOf)).size,minerals.length);let left=0,right=0;for(const m of minerals){assert(m.x-m.radius>0&&m.x+m.radius<r.WIDTH&&m.y+m.radius<r.HEIGHT);assert(Math.abs(Math.atan2(m.x-480,m.y-90))<r.MAX_ANGLE);if(m.x<480)left+=m.value;else right+=m.value;for(const n of minerals)if(m!==n)assert(Math.hypot(m.x-n.x,m.y-n.y)>m.radius+n.radius);}assert.equal(left,right);break;}
    case "摆动自动且冻结":target(g);const d=r.drop(g,"a",3500);assert.equal(d.game.miners[0].hook.angle,r.hookPose(g.miners[0],g,3500).angle);assert.equal(r.hookPose(d.game.miners[0],d.game,4000).angle,d.game.miners[0].hook.angle);assert.notEqual(r.hookPose(g.miners[0],g,3500).angle,r.hookPose(g.miners[0],g,4500).angle);break;
    case "回到原点才计分":g=r.drop(target(g),"a",3000).game;g=r.advance(g,3600);assert.equal(g.miners[0].score,0);assert.equal(g.fields.a.minerals[0].status,"claimed");g=r.advance(g,4000);assert.equal(g.miners[0].score,250);assert.equal(g.miners[0].collectedCount,1);assert.equal(g.fields.a.minerals[0].status,"collected");break;
    case "重量影响速度":{const light=r.advance(r.drop(target(game(),1),"a",3000).game,4000),heavy=r.advance(r.drop(target(game(),4),"a",3000).game,4000);assert.equal(light.miners[0].score,250);assert.equal(heavy.miners[0].score,0);break;}
    case "空钩触边回收":g.fields.a.minerals=[];g=r.drop(g,"a",3000).game;g=r.advance(g,10000);assert.equal(g.miners[0].hook.phase,"idle");assert.equal(g.miners[0].score,0);break;
    case "巨大跳跃不漏收集":g=r.advance(r.drop(target(g),"a",3000).game,1000000);assert.equal(g.miners[0].score,250);assert.equal(g.phase,"finished");break;
    case "截止严格未回收不计分":g=target(game("independent",10),100);g=r.advance(r.drop(g,"a",3000).game,13000);assert.equal(g.miners[0].score,0);assert.equal(g.phase,"finished");assert.equal(r.advance(g,999999).miners[0].score,0);break;
    case "恰好截止回收不计分":g=target(game("independent",10),1);g=r.drop(g,"a",3000).game;g.miners[0].hook={...g.miners[0].hook,phase:"retracting",motionAt:12000,motionLength:360,speed:-360,targetId:"one"};g.fields.a.minerals[0].status="claimed";g.fields.a.minerals[0].claimedBy="a";assert.equal(r.advance(g,13000).miners[0].score,0);break;
    case "全局接触时间先到先得":g=target(game("shared"));g=r.drop(g,"a",3000).game;g=r.drop(g,"b",3000).game;g.miners[0].hook.motionAt=3200;g=r.advance(g,5000);assert.equal(g.miners[0].score,0);assert.equal(g.miners[1].score,250);break;
    case "同刻座位稳定独占":g=target(game("shared"));g=r.drop(g,"a",3000).game;g=r.drop(g,"b",3000).game;g.miners.reverse();g=r.advance(g,5000);assert.equal(g.fields.shared.minerals[0].claimedBy,"a");assert.equal(g.miners.find(isA).score,250);break;
    case "退出先推进冻结释放":g=target(game("shared"));g=r.drop(g,"a",3000).game;g=r.depart(g,"a",3600);assert.equal(g.fields.shared.minerals[0].status,"available");assert.equal(g.miners[0].departed,true);assert.equal(r.advance(g,9000).miners[0].score,0);break;
    case "退出完成金额保留":g=r.depart(r.drop(target(g),"a",3000).game,"a",5000);assert.equal(g.miners[0].score,250);assert.equal(g.rankings[1].rank,null);break;
    case "非法下钩无副作用":target(g);const before=JSON.stringify(g);assert.equal(r.drop(g,"fake",3000).ok,false);assert.equal(r.drop(g,"a",2999).ok,false);assert.equal(JSON.stringify(g),before);g=r.drop(g,"a",3000).game;const after=JSON.stringify(g);assert.equal(r.drop(g,"a",3001).ok,false);assert.equal(JSON.stringify(g),after);break;
    case "纯推进与快照深拷贝":const original=JSON.stringify(g);r.advance(g,5000);assert.equal(JSON.stringify(g),original);const s=r.snapshot(g,5000);assert.equal(s._time,undefined);s.miners[0].hook.origin.x=0;assert.equal(g.miners[0].hook.origin.x,480);break;
    case "同分竞赛排名":g.miners.push({...g.miners[1],playerId:"c",seat:2,score:10});g.miners[0].score=20;g.miners[1].score=20;assert.deepEqual(r.rankings(g).map(rankOf),[1,1,3]);break;
    case "分段推进与整段完全等价":{g=target(game("shared"));g=r.drop(g,"a",3000).game;g=r.drop(g,"b",3000).game;const whole=r.advance(g,100000);let split=g;for(const t of [3100,3400,3500,3600,3900,5000,100000])split=r.advance(split,t);assert.deepEqual(split,whole);break;}
    case "亚毫秒先到不被座位覆盖":g=target(game("shared"));g=r.drop(g,"a",3000).game;g=r.drop(g,"b",3000).game;g.miners[0].hook.motionAt+=0.001;g=r.advance(g,5000);assert.equal(g.miners[1].score,250);assert.equal(g.miners[0].score,0);break;
    case "斜向扫掠大跳跃命中":g=target(game());g=r.drop(g,"a",3500).game;{const h=g.miners[0].hook;g.fields.a.minerals[0].x=h.origin.x+Math.sin(h.angle)*200;g.fields.a.minerals[0].y=h.origin.y+Math.cos(h.angle)*200;}g=r.advance(g,100000);assert.equal(g.miners[0].score,250);break;
    case "释放后其他矿工继续竞争":g=target(game("shared"));g=r.drop(g,"a",3000).game;g=r.drop(g,"b",3000).game;g.miners[1].hook.motionAt=3400;g=r.depart(g,"a",3600);g=r.advance(g,5000);assert.equal(g.miners[0].score,0);assert.equal(g.miners[1].score,250);break;
    case "终局禁止下钩但允许新局":{g=r.advance(g,g.endsAt);assert.equal(r.drop(g,"a",g.endsAt).ok,false);const next=r.start(g,g.miners,100000,{mode:"shared",durationSeconds:65});assert.equal(next.round,2);assert.equal(next.endsAt-next.startedAt,65000);assert.equal(next.miners[0].score,0);assert.notDeepEqual(next.fields.shared.minerals,g.fields.a.minerals);assert.throws(r.start.bind(null,next,next.miners,100001),RangeError);break;}
    case "多种子布局始终安全":for(let seed=0;seed<1000;seed+=1){const minerals=r.createField(seed).minerals;for(const m of minerals){assert(m.x-m.radius>0&&m.x+m.radius<r.WIDTH&&m.y+m.radius<r.HEIGHT);assert(Math.abs(Math.atan2(m.x-480,m.y-90))<r.MAX_ANGLE);for(const n of minerals)if(m!==n)assert(Math.hypot(m.x-n.x,m.y-n.y)>m.radius+n.radius);}}break;
    case "已收集矿石不能重复入账":g=r.advance(r.drop(target(g),"a",3000).game,4000);g.miners[0].hook={...g.miners[0].hook,phase:"retracting",motionAt:4000,motionLength:10,speed:-360,targetId:"one"};g=r.advance(g,5000);assert.equal(g.miners[0].score,250);assert.equal(g.miners[0].collectedCount,1);break;
    case "墙钟回拨不倒退物理与快照":{g=r.advance(r.drop(target(g,4),"a",3000).game,4000);const back=r.advance(g,3500);assert.equal(back._time,g._time);assert.equal(back.miners[0].hook.length,g.miners[0].hook.length);assert.equal(r.snapshot(back,3500).serverNow,4000);g=r.advance(g,10000);const dropped=r.drop(g,"a",9000);assert.equal(dropped.ok,true);assert.equal(dropped.game.miners[0].hook.motionAt,10000);break;}
    case "四种自定义时长真正控制截止":for(const seconds of [10,65,120,600]){const configured=game("shared",seconds);assert.equal(r.advance(configured,configured.endsAt-1).phase,"playing");assert.equal(r.advance(configured,configured.endsAt).phase,"finished");assert.equal(configured.endsAt-configured.startedAt,seconds*1000);}break;
    case "矿场挖空不提前结束":g.fields.a.minerals=[];g.fields.b.minerals=[];{const deadline=g.endsAt;g=r.advance(g,9000);assert.equal(g.phase,"playing");assert.equal(g.endsAt,deadline);assert.equal(g.miners[0].score,0);}break;
    case "空场提示只镜像不提前结算（渲染fixture）":verifyEmptyNotice();break;
    default:throw new Error(name);
  }
}
/** 提取矿石身份。@param {object} m - 矿石。@returns {string} 唯一ID。 */
function idOf(m){/* 1. 返回标识。 */return m.id;}
/** 匹配甲。@param {object} m - 矿工。@returns {boolean} 是否甲。 */
function isA(m){/* 1. 返回匹配结果。 */return m.playerId==="a";}
/** 提取排名。@param {object} m - 排名条目。@returns {number|null} 名次。 */
function rankOf(m){/* 1. 返回名次。 */return m.rank;}
/** 返回注入渲染fixture的指定值；不是服务器传输或浏览器操作证据。
 * @param {*} value - 已建立的独立状态、矿工或原始常量，允许布尔值和null。
 * @returns {*} 原值；无副作用，不计算或改变规则。
 */
function fixtureValue(value){
  // 1. 通过命名函数绑定数据，给实际渲染函数提供只读接口。
  return value;
}
/** 接收无需验证的视图调用，限定于空场文案的纯渲染fixture。
 * @returns {void} 无操作；不生成分数、终局或真实联机证据。
 */
function fixtureNoop(){
  // 1. 当前fixture只观察空场文案，其他展示调用无需模拟实现。
}
/** 建立空场文案fixture需要的一个UI写入接收器。
 * @param {string} key - 实际updateUi读取的元素名，不为空。
 * @returns {Array} 元素名与独立属性接收对象；不访问真实DOM。
 */
function uiEntry(key){
  // 1. 提供属性及classList/文本节点写入接口，不实现游戏行为。
  return [key,{firstChild:{textContent:""},classList:{toggle:fixtureNoop},replaceChildren:fixtureNoop,append:fixtureNoop,querySelector:fixtureValue.bind(null,{textContent:""})}];
}
/** 以实际页面函数验证挖空提示、只读金额与不提前终局。
 * @returns {void} 成功无返回；源码函数未匹配或文案/状态断言失败会抛错。这是纯渲染fixture，非浏览器/WS证据。
 */
function verifyEmptyNotice(){
  // 1. 用真实规则建立仍在比赛的空场，固定业务时间而不推进到截止。
  const g=game();g.fields.a.minerals=[];g.fields.b.minerals=[];
  const before=JSON.stringify(g),source=fs.readFileSync(require.resolve("../gold-miner.js"),"utf8");
  const ui=Object.fromEntries(["goldStart","goldMode","goldDuration","goldDrop","goldModeLabel","goldModeHint","goldRoundLabel","goldMyScore","goldRankTitle","goldClockLabel","goldClock","goldOverlay","goldMessage"].map(uiEntry));
  const context={ui,snapshot:{game:g,room:{players:[{connected:true},{connected:true}]}},roomState:{online:"online",playerId:"a"},actionInFlight:false,rules:r,isHost:fixtureValue.bind(null,true),serverTime:fixtureValue.bind(null,9000),renderRankings:fixtureNoop,document:{createTextNode:fixtureValue.bind(null,{}),createElement:fixtureValue.bind(null,{})}};
  // 2. 直接提取实际函数，避免在测试中复制文案或终局分支实现。
  const canDrop=source.match(/function canDrop\(\) \{[\s\S]*?\n  \}/)[0];
  const update=source.match(/function updateUi\(\) \{[\s\S]*?\n  \}/)[0];
  vm.runInNewContext(`${canDrop}\n${update}\nupdateUi();`,context);
  // 3. 挖空只显示等待提示，原截止、金额与phase均不能被渲染函数修改。
  assert.equal(ui.goldMessage.textContent,"矿场已空 · 等待比赛截止");assert.equal(JSON.stringify(g),before);assert.equal(g.phase,"playing");assert.equal(g.endsAt,93000);
}
// 1. 显式登记真实用例，由Node报告数量及退出码。
for(const name of ["默认配置与导出","浏览器导出","非法时长","时长边界","非法模式","开局人数","三秒统一倒计时","独立同布局无共享引用","共享原点分布","矿石边界不重叠平衡可达","摆动自动且冻结","回到原点才计分","重量影响速度","空钩触边回收","巨大跳跃不漏收集","截止严格未回收不计分","恰好截止回收不计分","全局接触时间先到先得","同刻座位稳定独占","退出先推进冻结释放","退出完成金额保留","非法下钩无副作用","纯推进与快照深拷贝","同分竞赛排名","分段推进与整段完全等价","亚毫秒先到不被座位覆盖","斜向扫掠大跳跃命中","释放后其他矿工继续竞争","终局禁止下钩但允许新局","多种子布局始终安全","已收集矿石不能重复入账","墙钟回拨不倒退物理与快照","四种自定义时长真正控制截止","矿场挖空不提前结束","空场提示只镜像不提前结算（渲染fixture）"])test(name,run.bind(null,name));
