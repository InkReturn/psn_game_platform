# 部署资产留档（demo.game.e-du.cn）

本目录是 LinkPlay 小游戏平台**生产部署配置的仓库留档**。

## 为什么放在仓库里

服务器上的 `/etc/systemd/system/psn-game-platform.service` 与
`/xp/panel/vhost/nginx/demo.game.e-du.cn.conf` 是**运行真源**；这两个文件如果不入仓，
服务器一旦重装或需要重建，配置就只能靠记忆复原。同时留档也让「线上到底跑的是什么」
可以被逐字节核对，而不是靠口头描述。

留档口径：**本目录内容必须与线上文件逐字节一致**（用 sha256 核对，见下文）。
两边不一致时，以线上为准，改完线上后把文件重新取回本目录。

## 文件清单

| 本目录文件 | 线上真实路径 |
|---|---|
| `psn-game-platform.service` | `/etc/systemd/system/psn-game-platform.service` |
| `nginx/demo.game.e-du.cn.conf` | `/xp/panel/vhost/nginx/demo.game.e-du.cn.conf` |

关键参数（改任何一项都要同步核对本文档）：

| 项 | 值 |
|---|---|
| 代码目录 | `/opt/psn-game-platform` |
| 监听 | `127.0.0.1:48230`（只回环，不对外） |
| Node | `/opt/node-v24.17.0-linux-x64/bin/node`（服务器 PATH 里没有 node，unit 必须写绝对路径） |
| 证书 | `/xp/panel/vhost/ssl/demo.game.e-du.cn/{fullchain,privkey}.pem`（acme.sh webroot 模式，ec-256） |
| acme webroot | `/xp/www/demo.game.e-du.cn`（**80/443 段的 `/.well-known/` 都不能动**，动了续期就断） |
| 日志 | `/xp/wwwlogs/demo.game.e-du.cn{,.error}.log` |

## 上线步骤

```bash
# 1. 代码（任选其一）
git clone https://github.com/InkReturn/psn_game_platform.git /opt/psn-game-platform
#   或本地打包上传（GitHub 不可达时）：
#   tar -czf psn.tar.gz --exclude=./node_modules --exclude=./outputs --exclude=./.git -C <repo> .
#   scp psn.tar.gz root@<host>:/opt/ && tar -xzf /opt/psn.tar.gz -C /opt/psn-game-platform

# 2. 运行期依赖（只需 express + ws，无原生模块）
cd /opt/psn-game-platform
export PATH=/opt/node-v24.17.0-linux-x64/bin:$PATH   # 不 export 时 npm 报 /usr/bin/env: 'node': No such file or directory
npm install --omit=dev --no-audit --no-fund

# 3. systemd
cp deploy/psn-game-platform.service /etc/systemd/system/psn-game-platform.service
systemctl daemon-reload && systemctl enable --now psn-game-platform
systemctl status psn-game-platform --no-pager
curl -s http://127.0.0.1:48230/health

# 4. 证书（首次；已有证书时跳过）
mkdir -p /xp/www/demo.game.e-du.cn
/root/.acme.sh/acme.sh --issue -d demo.game.e-du.cn -w /xp/www/demo.game.e-du.cn --keylength ec-256
/root/.acme.sh/acme.sh --install-cert -d demo.game.e-du.cn --ecc \
  --key-file       /xp/panel/vhost/ssl/demo.game.e-du.cn/privkey.pem \
  --fullchain-file /xp/panel/vhost/ssl/demo.game.e-du.cn/fullchain.pem \
  --reloadcmd      "/xp/server/nginx/sbin/nginx -s reload"

# 5. Nginx（改前必备份，测试通过才 reload）
cp -p /xp/panel/vhost/nginx/demo.game.e-du.cn.conf /xp/panel/vhost/nginx/demo.game.e-du.cn.conf.bak.$(date +%Y%m%d-%H%M%S)
cp deploy/nginx/demo.game.e-du.cn.conf /xp/panel/vhost/nginx/demo.game.e-du.cn.conf
/xp/server/nginx/sbin/nginx -t && /xp/server/nginx/sbin/nginx -s reload
```

首次签发证书时 Nginx 必须先有该域名的 80 段（否则 HTTP-01 校验拿不到 challenge 文件）：
先只放 80 段 → `nginx -t && reload` → 签证书 → 再追加 443 段。

## 一致性核对

```bash
# 线上
ssh root@<host> 'sha256sum /etc/systemd/system/psn-game-platform.service /xp/panel/vhost/nginx/demo.game.e-du.cn.conf'
# 本地（在本目录）
sha256sum psn-game-platform.service nginx/demo.game.e-du.cn.conf
```

2026-09-18 部署时的基线哈希：

```
5539c55c9169c5f1dd1c87527c7f32ce8863022acdacea8ebaef75d939e0c67f  psn-game-platform.service
24a88ffd0f612cae0cc6e11253a5895b4800220c8157619a306d4bab331e635e  nginx/demo.game.e-du.cn.conf
```

另建议顺手体检换行符：部署文件必须是 LF，混入 CRLF 会让 systemd / nginx 解析异常。

```bash
ssh root@<host> 'grep -c $"\r" /etc/systemd/system/psn-game-platform.service'   # 期望 0
```

## 回滚

```bash
# 1) 停服并禁用（不影响同机其他站点）
systemctl disable --now psn-game-platform

# 2) 摘掉 vhost（改名保留，不删除）
mv /xp/panel/vhost/nginx/demo.game.e-du.cn.conf \
   /xp/panel/vhost/nginx/demo.game.e-du.cn.conf.disabled-$(date +%Y%m%d)
/xp/server/nginx/sbin/nginx -t && /xp/server/nginx/sbin/nginx -s reload

# 3) 移除 unit，目录整体挪走（留档不删）
rm -f /etc/systemd/system/psn-game-platform.service && systemctl daemon-reload
mv /opt/psn-game-platform /opt/psn-game-platform.disabled-$(date +%Y%m%d)

# 4) 证书（仅当确定不再使用该域名）
rm -rf /xp/panel/vhost/ssl/demo.game.e-du.cn
/root/.acme.sh/acme.sh --remove -d demo.game.e-du.cn --ecc
#   /xp/www/demo.game.e-du.cn 可保留，无副作用
```

## 注意

- 房间与对局状态**只存进程内存**，重启即全部丢失（客户端会自动识别 `ROOM_NOT_FOUND` 并回到大厅）。
- `location /ws` 的 `Upgrade` / `Connection $connection_upgrade` / `proxy_read_timeout 3600s` 是长连接存活的关键，不要顺手优化掉。
- 本服务与 pangbao 各业务线（Java 48080 / Go 48082 / 社区 49180、48092）无任何耦合，不共用数据库、不共用进程。
