"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

/**
 * 执行实际发布 bundle 的端点表达式，验证公网声明与开发覆盖的优先级。
 * @returns {void} 8 个 HTTP/HTTPS、缺失声明和查询覆盖场景通过；缺表达式或错误端点直接失败。
 */
function main() {
  // 1. 从固定实际产物提取唯一端点表达式，不读取或模拟另一份业务实现。
  const bundle = fs.readFileSync("vendor/tanks/assets/index-D53ro3Xc.js", "utf8");
  const matches = [...bundle.matchAll(/const o=(window\.LINKPLAY_ARCADE_PROXY[\s\S]*?);this\.network=new [\w$]+\(o\),this\.healthFill=/g)];
  assert.equal(matches.length, 1);
  const expression = matches[0][1];
  const cases = [
    [true, "http:", "?server=ws://unapproved.example:2567", "ws://release.test:8881/tanks"],
    [undefined, "http:", "?server=ws://unapproved.example:2567", "ws://release.test:8881/tanks"],
    [false, "http:", "?server=ws://dev.test:2567", "ws://dev.test:2567"],
    [false, "http:", "", "ws://release.test:2567"],
    [true, "http:", "", "ws://release.test:8881/tanks"],
    [undefined, "http:", "", "ws://release.test:8881/tanks"],
    [true, "https:", "?server=ws://unapproved.example:2567", "wss://release.test:8881/tanks"],
    [undefined, "https:", "?server=ws://unapproved.example:2567", "wss://release.test:8881/tanks"],
  ];
  // 2. 在无网络、无 DOM 的隔离上下文运行产物代码，不允许查询参数突破公网声明。
  for (const [proxy, protocol, search, expected] of cases) {
    const window = { LINKPLAY_ARCADE_PROXY: proxy, location: { protocol, search, host: "release.test:8881", hostname: "release.test" } };
    assert.equal(vm.runInNewContext(`(${expression})`, { window, URLSearchParams }), expected);
  }
  assert.equal(cases.length, 8);
  console.log("8/8 arcade endpoint priority cases passed (actual bundle, no network)");
}
main();
