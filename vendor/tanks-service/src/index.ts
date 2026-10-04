// LinkPlay 本机试玩入口；规则来自 MIT 授权的 Realtime Tanks Demo，见 ../LICENSE。
import { defineRoom, defineServer } from "colyseus";
import type { Express, Request, Response } from "express";
import { BattleRoom } from "./rooms/BattleRoom";

/**
 * 返回只读健康标识，不暴露原版管理面板。
 * @param _request 本机健康检查请求，无业务参数。
 * @param response 健康检查响应，不含玩家状态。
 */
function health(_request: Request, response: Response) {
  // 1. 返回启动器与验收使用的服务标识。
  response.json({ status: "ok", game: "tanks" });
}

/**
 * 注册本机健康接口，匹配及游戏路由仍由 Colyseus 提供。
 * @param app Colyseus 创建的 Express 实例。
 */
function configureHttp(app: Express) {
  // 1. 不加载公开管理面板，试玩只暴露健康与游戏协议。
  app.get("/health", health);
}

/** 记录成功监听，无用户数据或凭据。 */
function started() {
  // 1. 汇报准确的回环监听地址。
  console.log("[tanks] listening on http://127.0.0.1:2567");
}

/**
 * 监听失败时退出，防止启动器将端口冲突视作成功。
 * @param error 监听或初始化异常。
 */
function failed(error: Error) {
  // 1. 明确记录错误并退出。
  console.error("[tanks] startup failed:", error.message);
  process.exit(1);
}

const server = defineServer({ rooms: { battle: defineRoom(BattleRoom) }, express: configureHttp });
server.listen(2567, "127.0.0.1").then(started).catch(failed);
