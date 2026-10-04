/**
 * LinkPlay 共享账号客户端（浏览器端）。
 *
 * 职责：封装 /api/auth 四个 HTTP 端点（注册/登录/登出/当前账号），
 * 管理会话令牌的 localStorage 存取；登录成功后把账号昵称同步到
 * "linkplay-name"（各游戏页房间面板的共享昵称键），实现"登录一次、
 * 全平台带昵称进房"。
 *
 * 所有方法失败时 reject {code, message}，message 为可直接展示的中文文案。
 */
(function () {
  "use strict";

  /** 会话令牌在 localStorage 的键名。 */
  const TOKEN_KEY = "linkplay-auth-token";
  /** 全平台共享昵称键（与 authoritative-room.js / gomoku-net.js 约定一致）。 */
  const NAME_KEY = "linkplay-name";

  /**
   * 读取当前会话令牌。
   *
   * @returns {string} 令牌（未登录返回空串）。
   */
  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  }

  /**
   * 写入会话令牌。
   *
   * @param {string} token - 登录/注册返回的令牌。
   */
  function setToken(token) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* 隐私模式等场景静默降级：仅本次会话内不记忆登录态 */
    }
  }

  /**
   * 把昵称同步到全平台共享键（登录/游客改名时调用）。
   *
   * @param {string} nickname - 昵称（1-16 字符）。
   */
  function applyNickname(nickname) {
    // 1. 空昵称不写入（各游戏页自有随机昵称兜底）。
    if (!nickname || !nickname.trim()) return;
    try {
      localStorage.setItem(NAME_KEY, nickname.trim().slice(0, 16));
    } catch {
      /* 存储不可用时静默降级 */
    }
  }

  /**
   * 调用 auth API 并归一化响应。
   *
   * @param {string} path - 端点路径（如 /api/auth/login）。
   * @param {object} [body] - JSON 请求体（GET 时省略）。
   * @param {string} [method] - HTTP 方法，默认 POST。
   * @returns {Promise<{ok: boolean, account?: object, token?: string, code?: string, message?: string}>}
   *   归一化结果；网络异常 reject。
   */
  async function callApi(path, body, method) {
    const headers = { "Content-Type": "application/json" };
    // 1. 已有令牌时自动携带（logout / me 都需要）。
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    // 2. 发起请求；网络层异常（服务器不可达）转为 reject。
    const res = await fetch(path, {
      method: method || "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // 3. 解析响应体（服务器约定返回 JSON；坏网关时退化为通用错误）。
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = { ok: false, code: "NETWORK", message: "服务器暂时无法访问" };
    }
    return data;
  }

  /**
   * 注册新账号并自动登录。
   *
   * @param {object} input - {username, password, nickname?}。
   * @returns {Promise<object>} 成功 {ok:true, account, token}；失败 {ok:false, code, message}。
   */
  async function register(input) {
    const data = await callApi("/api/auth/register", input);
    if (data.ok) {
      // 1. 注册即登录：保存令牌并同步昵称。
      setToken(data.token);
      applyNickname(data.account?.nickname);
    }
    return data;
  }

  /**
   * 账号登录。
   *
   * @param {object} input - {username, password}。
   * @returns {Promise<object>} 同 register。
   */
  async function login(input) {
    const data = await callApi("/api/auth/login", input);
    if (data.ok) {
      // 1. 登录成功：保存令牌并同步昵称。
      setToken(data.token);
      applyNickname(data.account?.nickname);
    }
    return data;
  }

  /**
   * 登出：吊销服务器令牌并清理本地状态。
   *
   * @returns {Promise<void>} 完成后 resolve（任何失败也视为已登出）。
   */
  async function logout() {
    // 1. 尽力通知服务器吊销；失败不阻塞本地清理。
    try {
      await callApi("/api/auth/logout", {});
    } catch {
      /* 服务器不可达时仍继续本地登出 */
    }
    // 2. 本地令牌清除，昵称保留（退回游客身份沿用原昵称）。
    setToken("");
  }

  /**
   * 查询当前登录账号（静默探测：任何失败都视为未登录，不抛错）。
   *
   * @returns {Promise<{username: string, nickname: string, createdAt: number}|null>}
   *   已登录返回账号视图，未登录/令牌失效返回 null。
   */
  async function me() {
    // 1. 无令牌直接短路，不打无效请求。
    if (!getToken()) return null;
    try {
      const data = await callApi("/api/auth/me", undefined, "GET");
      // 2. 令牌失效时清掉本地残留，避免每次请求都白发一次。
      if (!data.ok) {
        setToken("");
        return null;
      }
      return data.account || null;
    } catch {
      return null;
    }
  }

  /** 导出：大厅与游戏页共用。 */
  window.LinkPlayAuth = {
    getToken,
    setToken,
    applyNickname,
    register,
    login,
    logout,
    me,
  };
})();
