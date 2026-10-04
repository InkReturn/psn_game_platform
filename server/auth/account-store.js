/**
 * 账号存储（JSON 文件 + scrypt 密码哈希 + 会话令牌）。
 *
 * 设计约定：
 * - 账号数据持久化在单个 JSON 文件（默认 data/accounts.json，可用
 *   LINKPLAY_AUTH_FILE 环境变量或构造参数覆盖），写入走「临时文件 + rename」原子替换，
 *   避免进程中途被杀留下半截文件；
 * - 密码绝不落明文：scrypt(N=16384,r=8,p=1,keyLen=32) + 每账号独立 16 字节盐，
 *   校验使用 timingSafeEqual 防时序侧信道；
 * - 会话令牌为 32 字节随机 hex，每账号同一时刻只保留一个有效 token（新登录顶替旧设备），
 *   token 持久化在账号文件里，服务重启后仍有效；
 * - 单线程 Node 内同步顺序调用，不需要锁；文件写入频率极低（注册/登录/登出），
 *   采用同步 IO 换实现简单。
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/** scrypt 参数（与 OpenSSL 默认强度同级，登录频率低不影响体验）。 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
/** scrypt 输出密钥长度（字节）。 */
const SCRYPT_KEY_LEN = 32;
/** 每账号密码盐长度（字节）。 */
const SALT_BYTES = 16;
/** 会话令牌长度（字节，hex 编码后 64 字符）。 */
const AUTH_TOKEN_BYTES = 32;
/** 用户名规则：2-16 位，允许字母/数字/下划线/短横线/中文。 */
const USERNAME_PATTERN = /^[A-Za-z0-9_\-\u4e00-\u9fa5]{2,16}$/;
/** 昵称最大长度（字符数，与房间昵称上限保持一致）。 */
const NICKNAME_MAX_LENGTH = 16;
/** 密码长度限制（字符数）。 */
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 64;

/** auth 域错误码（HTTP API 与测试断言共用）。 */
const AuthErrorCodes = Object.freeze({
  AUTH_USERNAME_INVALID: "AUTH_USERNAME_INVALID",
  AUTH_PASSWORD_INVALID: "AUTH_PASSWORD_INVALID",
  AUTH_NICKNAME_INVALID: "AUTH_NICKNAME_INVALID",
  AUTH_USERNAME_TAKEN: "AUTH_USERNAME_TAKEN",
  AUTH_INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS",
  AUTH_INVALID_TOKEN: "AUTH_INVALID_TOKEN",
  AUTH_STORE_ERROR: "AUTH_STORE_ERROR",
});

/** auth 域错误码 → 中文文案。 */
const AUTH_ERROR_MESSAGES = Object.freeze({
  AUTH_USERNAME_INVALID: "用户名需为 2-16 位字母、数字、下划线或中文",
  AUTH_PASSWORD_INVALID: `密码长度需在 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位之间`,
  AUTH_NICKNAME_INVALID: `昵称需为 1-${NICKNAME_MAX_LENGTH} 个字符`,
  AUTH_USERNAME_TAKEN: "这个用户名已经被注册了",
  AUTH_INVALID_CREDENTIALS: "用户名或密码不正确",
  AUTH_INVALID_TOKEN: "登录状态已失效，请重新登录",
  AUTH_STORE_ERROR: "账号存储读写失败，请联系管理员",
});

/**
 * 构造一个 auth 失败结果对象。
 *
 * @param {string} code - AuthErrorCodes 中的错误码。
 * @returns {{ok: false, code: string, message: string}} 失败结果。
 */
function authFail(code) {
  return { ok: false, code, message: AUTH_ERROR_MESSAGES[code] || "操作失败" };
}

/**
 * 创建账号存储实例。
 *
 * @param {object} [options]
 * @param {string} [options.dataFile] - 账号 JSON 文件路径；缺省读环境变量
 *   LINKPLAY_AUTH_FILE，再缺省为仓库根下 data/accounts.json。
 * @param {Function} [options.log] - 日志函数（可注入静音）。
 * @returns {object} 账号存储 API：register/login/verifyToken/revokeToken/accountCount/flush。
 */
function createAccountStore(options = {}) {
  const log = options.log || ((...args) => console.log("[auth]", ...args));
  const rootDir = path.join(__dirname, "..", "..");
  const dataFile =
    options.dataFile ||
    process.env.LINKPLAY_AUTH_FILE ||
    path.join(rootDir, "data", "accounts.json");
  /** @type {object} usernameKey(小写) -> 账号记录。 */
  let accounts = {};
  /** @type {Map<string, string>} tokenValue -> usernameKey（内存索引）。 */
  const tokenIndex = new Map();

  /**
   * 从磁盘加载账号文件；损坏时备份原文件并重建空库。
   *
   * @returns {void}
   */
  function load() {
    // 1. 文件不存在：保持空库（首次运行）。
    if (!fs.existsSync(dataFile)) return;
    // 2. 解析失败：把损坏文件改名留证，重建空库而不是带着坏数据继续跑。
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    } catch (err) {
      const backup = `${dataFile}.corrupt-${Date.now()}`;
      fs.renameSync(dataFile, backup);
      log(`accounts file corrupted, moved to ${backup} (${err.message})`);
      accounts = {};
      return;
    }
    // 3. 结构校验后纳入内存。
    if (!raw || typeof raw !== "object" || raw.accounts === null || typeof raw.accounts !== "object") {
      accounts = {};
      return;
    }
    accounts = raw.accounts;
    // 4. 重建 token 索引。
    for (const [key, account] of Object.entries(accounts)) {
      if (account && account.token && account.token.value) {
        tokenIndex.set(account.token.value, key);
      }
    }
  }

  /**
   * 把当前账号表原子写回磁盘。
   *
   * @returns {boolean} 是否写成功。
   */
  function persist() {
    // 1. 先写同目录临时文件（同目录保证 rename 跨越的是同一文件系统）。
    const tmpFile = `${dataFile}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      fs.writeFileSync(tmpFile, JSON.stringify({ version: 1, accounts }, null, 2), "utf8");
      // 2. 原子替换正式文件。
      fs.renameSync(tmpFile, dataFile);
      return true;
    } catch (err) {
      log(`persist accounts failed: ${err.message}`);
      // 3. 清理失败的临时文件（存在才删）。
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {
        /* 清理失败不影响主流程 */
      }
      return false;
    }
  }

  /**
   * 生成密码哈希记录。
   *
   * @param {string} password - 明文密码（已通过长度校验）。
   * @returns {{salt: string, hash: string, params: object}} 盐/哈希（hex）与参数快照。
   */
  function hashPassword(password) {
    // 1. 每账号独立随机盐，防止彩虹表复用。
    const salt = crypto.randomBytes(SALT_BYTES).toString("hex");
    // 2. 参数随哈希一起存档，未来调参后老账号仍可校验。
    const hash = crypto.scryptSync(password, salt, SCRYPT_KEY_LEN, SCRYPT_PARAMS).toString("hex");
    return { salt, hash, params: { ...SCRYPT_PARAMS } };
  }

  /**
   * 校验明文密码是否匹配已存哈希。
   *
   * @param {string} password - 待校验明文。
   * @param {{salt: string, hash: string, params?: object}} record - 已存哈希记录。
   * @returns {boolean} true 表示密码正确。
   */
  function verifyPassword(password, record) {
    // 1. 记录缺失视为不匹配。
    if (!record || !record.salt || !record.hash) return false;
    // 2. 优先用存档参数派生（历史账号可验证），缺省回退当前参数。
    const params = record.params && record.params.N ? record.params : SCRYPT_PARAMS;
    const derived = crypto.scryptSync(password, record.salt, SCRYPT_KEY_LEN, params);
    // 3. 定长比较防时序侧信道。
    const expected = Buffer.from(record.hash, "hex");
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  }

  /**
   * 对外账号视图（绝不含哈希与 token）。
   *
   * @param {object} account - 内部账号记录。
   * @returns {{username: string, nickname: string, createdAt: number}} 安全视图。
   */
  function publicAccount(account) {
    return {
      username: account.username,
      nickname: account.nickname,
      createdAt: account.createdAt,
    };
  }

  /**
   * 为账号签发新会话令牌（顶替旧 token 并写盘）。
   *
   * @param {string} key - usernameKey。
   * @param {object} account - 内部账号记录。
   * @returns {{token: string, issuedAt: number}} 新令牌信息。
   */
  function issueToken(key, account) {
    // 1. 旧 token 先从索引摘除（单设备语义）。
    if (account.token && account.token.value) tokenIndex.delete(account.token.value);
    // 2. 签发新 token 并同步内存与磁盘。
    const issuedAt = Date.now();
    const token = crypto.randomBytes(AUTH_TOKEN_BYTES).toString("hex");
    account.token = { value: token, issuedAt };
    tokenIndex.set(token, key);
    persist();
    return { token, issuedAt };
  }

  /**
   * 注册新账号并立即登录。
   *
   * @param {object} input - {username, password, nickname?}。
   * @returns {Promise<{ok: boolean, code?: string, message?: string, account?: object, token?: string}>}
   *   成功返回 {ok:true, account, token}；失败返回 {ok:false, code, message}。
   */
  async function register(input) {
    // 1. 用户名规则校验。
    const username = typeof input.username === "string" ? input.username.trim() : "";
    if (!USERNAME_PATTERN.test(username)) return authFail(AuthErrorCodes.AUTH_USERNAME_INVALID);
    // 2. 密码长度校验。
    const password = typeof input.password === "string" ? input.password : "";
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      return authFail(AuthErrorCodes.AUTH_PASSWORD_INVALID);
    }
    // 3. 昵称缺省沿用用户名，长度校验与房间昵称一致。
    const nickname = typeof input.nickname === "string" && input.nickname.trim() ? input.nickname.trim() : username;
    if (!nickname || nickname.length > NICKNAME_MAX_LENGTH) return authFail(AuthErrorCodes.AUTH_NICKNAME_INVALID);
    // 4. 用户名唯一性（大小写不敏感，中文不受影响）。
    const key = username.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(accounts, key)) return authFail(AuthErrorCodes.AUTH_USERNAME_TAKEN);
    // 5. 建档 + 签发 token + 落盘。
    const account = {
      username,
      nickname,
      createdAt: Date.now(),
      passwordHash: hashPassword(password),
      token: null,
    };
    accounts[key] = account;
    const { token } = issueToken(key, account);
    log(`account registered: ${username}`);
    return { ok: true, account: publicAccount(account), token };
  }

  /**
   * 账号登录：校验凭据并刷新会话令牌。
   *
   * @param {object} input - {username, password}。
   * @returns {Promise<{ok: boolean, code?: string, message?: string, account?: object, token?: string}>}
   *   同 register。
   */
  async function login(input) {
    // 1. 用户名不存在与密码错误返回同一错误码，不暴露账号存在性。
    const key = typeof input.username === "string" ? input.username.trim().toLowerCase() : "";
    const account = Object.prototype.hasOwnProperty.call(accounts, key) ? accounts[key] : null;
    const password = typeof input.password === "string" ? input.password : "";
    if (!account || !verifyPassword(password, account.passwordHash)) {
      return authFail(AuthErrorCodes.AUTH_INVALID_CREDENTIALS);
    }
    // 2. 校验通过：签发新 token（顶替旧设备）。
    const { token } = issueToken(key, account);
    log(`account login: ${account.username}`);
    return { ok: true, account: publicAccount(account), token };
  }

  /**
   * 校验会话令牌，返回账号安全视图。
   *
   * @param {string} token - 会话令牌（hex）。
   * @returns {{username: string, nickname: string, createdAt: number}|null} 有效返回账号视图，无效返回 null。
   */
  function verifyToken(token) {
    // 1. 索引命中后才核对账号记录（防 token 残留）。
    if (!token || typeof token !== "string") return null;
    const key = tokenIndex.get(token);
    if (!key) return null;
    const account = accounts[key];
    // 2. 账号记录与 token 必须同时有效（不一致说明文件被回滚）。
    if (!account || !account.token || account.token.value !== token) {
      tokenIndex.delete(token);
      return null;
    }
    return publicAccount(account);
  }

  /**
   * 吊销会话令牌（登出）。
   *
   * @param {string} token - 会话令牌。
   * @returns {boolean} true 表示吊销成功。
   */
  function revokeToken(token) {
    // 1. 令牌无效视为幂等失败。
    const account = verifyToken(token);
    if (!account) return false;
    // 2. 从索引与账号记录中同时摘除并落盘。
    const key = tokenIndex.get(token);
    tokenIndex.delete(token);
    const record = accounts[key];
    if (record) record.token = null;
    persist();
    log(`account logout: ${account.username}`);
    return true;
  }

  /**
   * 当前账号数量（测试与 /health 观测用，不返回任何隐私数据）。
   *
   * @returns {number} 账号总数。
   */
  function accountCount() {
    return Object.keys(accounts).length;
  }

  /**
   * 强制把内存数据写回磁盘（优雅停机时调用）。
   *
   * @returns {boolean} 是否写成功。
   */
  function flush() {
    return persist();
  }

  // 1. 构造即加载既有账号文件。
  load();

  return {
    register,
    login,
    verifyToken,
    revokeToken,
    accountCount,
    flush,
    AuthErrorCodes,
  };
}

module.exports = { createAccountStore, AuthErrorCodes, AUTH_ERROR_MESSAGES };
