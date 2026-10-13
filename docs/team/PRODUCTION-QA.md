# Node 24 生产运行验证（risk_security）
请新增 scripts/production-smoke.mjs 并执行，根不再改server。用 /Users/aegis/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node（v24）运行已构建 dist/server/index.js，必须先 npm run build 获得最新服务器。独立临时目录 mkdtemp，不用用户data；随机内存高熵token secret不打印。127.0.0.1:8788或独立端口，NODE_ENV=production、PUBLIC_ORIGIN本地origin。真实HTTP：health/static index+JS/CSP、真实路由与公开研究地址只读quote、创建unsigned订单/token隔离。停止进程重启同DB和secret，原token/订单可读，原幂等键恢复。用 scripts/backup.mjs VACUUM INTO 并恢复独立目录，再启动验证原订单。不得转账、不得输出accessToken/secret。测试完关闭自己启动的进程、删除自己创建的temp即可，保留脚本与md结果。可复用 scripts/live-smoke.ts 研究地址。HTTP loopback/network需工具escalation正常请求。生产依赖audit与容器仅root负责，不要混称Docker通过。全部实质结果写本MD。

## 执行结果：通过

完成时间：2026-10-12T19:26:56.183Z。实际运行时 **Node v24.19.0**，生产入口 `dist/server/index.js`，`NODE_ENV=production`。新增可重复执行脚本 `scripts/production-smoke.mjs`。

已执行命令：

```sh
npm run build
/Users/aegis/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/production-smoke.mjs
```

构建退出码0，生产验收脚本退出码0。构建有 Vite 主包大小提示（JS 541.93 kB / gzip 167.75 kB），无构建或类型错误。

本次真实检查：

| 项目 | 实际结果 |
|---|---|
| Node 24 生产启动、`/api/health` | 正常启动并返回 ok；使用独立随机 loopback 端口 |
| 静态 HTML / 构建 JS | HTML 与本轮 dist/client/index.html 一致；同源 JS 返回200及正确 MIME |
| 生产 CSP | 精确 self + TronGrid / TronStack / PublicNode 三个批准的 HTTPS RPC origin；无任意 https: 通配 |
| 真实 provider 路由 | `/api/config` 获取 Relay 真实配置，Tron→HyperCore available |
| 真实 HL 读取 | 公开研究地址 `/api/account` 成功，未用 fixture |
| 真实只读报价 | 100 USDT，expectedReceive=99.735823，minReceive=98.738465 USDC；通过正式 adapter 签名/订单/calldata 验证 |
| 未签名订单 | 创建 awaiting_signature，sourceTxHash 不存在；未调用 transaction 提交或广播接口 |
| 权限隔离 | 缺 token 返回401，错误 token 返回404，原 token 返回200；无 providerData / tokenHash 泄露 |
| 同库进程重启 | 干净 SIGTERM 退出0；同 DB+原稳定 secret 重启，原订单/原 token 可读，原幂等键恢复同订单和同 token |
| 在线备份 | 服务运行期间以 Node24 执行 `scripts/backup.mjs`，VACUUM INTO + integrity_check 返回 ok；快照权限0600 |
| 防覆盖 | 对既有备份路径重跑脚本明确失败，原快照未覆盖 |
| 独立目录恢复 | 停原服务，将快照复制到新临时 DATA_DIR；同 secret 启动后原订单、原 token、原幂等键均验证通过 |
| 清理 | 自己启动的全部子进程已关闭，自己创建的临时目录已删除；用户 data 未访问或修改 |

secret 为脚本内 `randomBytes(48)` 生成，仅内存与测试子进程环境使用；不写入磁盘，不输出 token、secret、幂等键。日志仅输出上述检查结论与报价数字。脚本不会读取 `.env`，若运行环境明确提供 provider API key 则可供子进程使用，本次未将任何凭据写入记录。

本轮证明的是 **Node 24 生产进程、真实只读 API、订单持久性和备份恢复**。没有运行 Docker，没有钱包签名，没有广播交易，没有真实资金闭环。本脚本的公网调用是读取主网配置/账本与获取报价；测试数据库中的订单全程未签名。
