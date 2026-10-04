/* 修改说明：LinkPlay 本机试玩配置；原版代码为 MPL-2.0，见上层 LICENSE。 */
define([], questLocalConfig);

/**
 * 生成同主机试玩配置，不使用远程公共游戏服务。
 * @returns {Object} 开发及构建环境共享的端点配置。
 */
function questLocalConfig() {
    // 1. 端口固定为启动器拥有的回环端口，仅用于 HTTP 本机试玩。
    var endpoint = { host: window.location.hostname, port: 8093, dispatcher: false };
    // 2. 三种配置统一指向同一服务，避免原版 localhost:8000 默认值覆盖。
    return { dev: endpoint, local: endpoint, build: endpoint };
}
