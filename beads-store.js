/** 浏览器本地事务存档：HTTP IP 也可使用，整库比较与写入属于同一 IndexedDB 事务。 */
"use strict";
/** 创建页面唯一存储 API。@returns {object} 读取与原子比较写入，不依赖安全上下文或服务端数据库。 */
window.BeadStore = (function createStore() {
  // 1. 只保留一个存档 owner；原 localStorage 只作为一次性迁移来源，不删除原文。
  const DATABASE = "linkplay.beads", STORE = "archives", KEY = "linkplay.beads.v1";
  let opening = null;
  /** 打开本地库。@returns {Promise<IDBDatabase>} 打开失败拒绝；升级只创建唯一对象库。 */
  async function database() {
    // 1. 同页复用连接，同步拒绝也必须清除失败缓存，让用户明确重试。
    if (opening) return opening;
    const pending = new Promise(openDatabase); opening = pending;
    try { return await pending; }
    catch (error) { if (opening === pending) opening = null; throw error; }
  }
  /** 装配打开请求。@param {Function} resolve 就绪回调。@param {Function} reject 错误回调。@returns {void} 新建或打开数据库。 */
  function openDatabase(resolve, reject) {
    // 1. 同步策略拒绝和异步打开失败都不得伪装为空库。
    let request;
    try { request = indexedDB.open(DATABASE, 1); } catch (error) { opening = null; reject(error); return; }
    request.onupgradeneeded = upgrade; request.onsuccess = opened; request.onerror = failed; request.onblocked = blocked;
    /** 创建唯一整库对象库。@returns {void} 仅首次升级时有 schema 副作用。 */
    function upgrade() { // 1. 不定义任何服务器数据库或用户账户。
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    }
    /** 接收数据库连接。@returns {void} 版本变化时关闭旧页连接。 */
    function opened() { // 1. 释放升级阻塞，不隐藏版本变化。
      const db = request.result; db.onversionchange = close; resolve(db);
      /** 关闭当前连接。@returns {void} 下次操作重新打开。 */
      function close() { // 1. 仅清理本页面连接。
        db.close(); opening = null;
      }
    }
    /** 报告打开错误。@returns {void} 清除失败连接缓存。 */
    function failed() { // 1. 把浏览器真实错误交给 UI。
      opening = null; reject(request.error || new Error("本地数据库无法打开"));
    }
    /** 报告被其他页面阻塞。@returns {void} 不静默覆盖或删除数据。 */
    function blocked() { // 1. 需要用户关闭旧页面后重试。
      opening = null; reject(new Error("本地数据库被其他页面占用"));
    }
  }
  /** 读取唯一整库原文。@returns {Promise<string|null>} 无记录为 null；失败拒绝，不当成空库。 */
  async function read() {
    // 1. 只读事务完成后返回，保留损坏原文给上层校验。
    const db = await database(); return new Promise(readTransaction);
    /** 执行只读事务。@param {Function} resolve 完成回调。@param {Function} reject 失败回调。@returns {void} 读取键值。 */
    function readTransaction(resolve, reject) {
      let transaction, value = null;
      try { transaction = db.transaction(STORE, "readonly"); const request = transaction.objectStore(STORE).get(KEY); request.onsuccess = received; }
      catch (error) { reject(error); return; }
      transaction.oncomplete = completed; transaction.onabort = failed; transaction.onerror = failed;
      /** 接收原文。@param {Event} event 请求结果事件。@returns {void} 暂存读取值。 */
      function received(event) { // 1. 区分不存在和损坏的现有值。
        value = event.target.result === undefined ? null : event.target.result;
      }
      /** 返回已完成读取。@returns {void} 不写数据。 */
      function completed() { // 1. 只有事务完成才报告成功。
        resolve(value);
      }
      /** 返回读取错误。@returns {void} 不吞掉存储策略异常。 */
      function failed() { // 1. 保留错误信号。
        reject(transaction.error || new Error("本地读取失败"));
      }
    }
  }
  /** 原子比较并写入。@param {string|null} expected 上次读取原文，null 表示不存在。@param {string} next 已经由模型验证的新整库 JSON。@returns {Promise<boolean>} 成功写入 true，基线变化 false；写失败拒绝。 */
  async function compareAndSet(expected, next) {
    // 1. readwrite 事务跨标签页串行；不存在读后写的竞争窗口。
    const db = await database(); return new Promise(writeTransaction);
    /** 执行原子事务。@param {Function} resolve 完成回调。@param {Function} reject 失败回调。@returns {void} 只有同一事务内原文一致才写入。 */
    function writeTransaction(resolve, reject) {
      let transaction, changed = false;
      try {
        transaction = db.transaction(STORE, "readwrite");
        const store = transaction.objectStore(STORE), request = store.get(KEY); request.onsuccess = received;
        /** 比较基线并写入。@param {Event} event 读取请求结果。@returns {void} 不匹配时无写入；同步写失败中止事务。 */
        function received(event) {
          // 1. 比较完整原文，包含删除、篡改与其他标签页保存。
          const actual = event.target.result === undefined ? null : event.target.result;
          if (actual !== expected) return;
          // 2. 同步 API 异常中止事务，不报告假成功。
          try { store.put(next, KEY); changed = true; }
          catch (error) { transaction.abort(); reject(error); }
        }
      } catch (error) { reject(error); return; }
      transaction.oncomplete = completed; transaction.onabort = failed; transaction.onerror = failed;
      /** 返回持久化完成结果。@returns {void} 写入请求成功不等于事务提交成功。 */
      function completed() { // 1. 以整个事务提交作为成功边界。
        resolve(changed);
      }
      /** 返回写入失败。@returns {void} 配额或策略失败均向上报告。 */
      function failed() { // 1. 内存内容由控制器保留，数据库不部分覆盖。
        reject(transaction.error || new Error("本地保存失败"));
      }
    }
  }
  // 2. 仅导出原子接口，不提供无保护的覆盖入口。
  return { read, compareAndSet, DATABASE, STORE, KEY };
})();
