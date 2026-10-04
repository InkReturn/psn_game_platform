/* 修改说明：LinkPlay 本机试玩配置；原版代码为 MPL-2.0，见上层 LICENSE。 */
define([], questLocalConfig);

/**
 * 生成同主机试玩配置，不使用远程公共游戏服务。
 * @returns {Object} 开发及构建环境共享的端点配置。
 */
function questLocalConfig() {
    // 1. 由同源部署声明选择拓扑，不按 hostname 猜测；声明缺失时默认同源，不能退回暴露内部端口。
    var proxy = window.LINKPLAY_ARCADE_PROXY !== false;
    var endpoint = { host: window.location.hostname, port: proxy ? (window.location.port || (window.location.protocol === "https:" ? 443 : 80)) : 8093, dispatcher: false };
    // 2. 三种配置统一指向同一服务，避免原版 localhost:8000 默认值覆盖。
    return { dev: endpoint, local: endpoint, build: endpoint };
}
