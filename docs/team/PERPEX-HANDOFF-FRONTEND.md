# Perpex 前端与上线交接完成记录

2026-10-12，product_delivery。任务依据：`work/branding/TEST-HANDOFF-TASK.md`。

## 本轮改动

- `client/App.tsx`：唯一可见页眉文字 `PerpDock` 改为 `Perpex`。
- `client/index.html`：页面 title 改为 `Perpex · 存入 Hyperliquid`。
- 新建 `docs/DEPLOYMENT-HANDOFF.md`，作为实际域名/服务器管理员的简明入口，链接既有精确部署、运维和资金验收手册。

未改钱包、订单、路由、localStorage key、请求数据、测试逻辑、服务端配置、Compose 项目/卷名；未加入主站链接或其他新数据。两处品牌改动均通过精确 patch 完成，没有全局替换。

## 交接要点已覆盖

建议 `deposit.perpex.ai` 但明确尚未确认/配置；外部团队先提供暂停的 HTTPS 环境，目标服务器验证后再安排用户本人小额签名，最后才判断市场开放。单跳 Caddy 与已有 Nginx/CDN 拓扑不能混用；内部 `perpdock-public` 持久化标识保留。桌面 TronLink 为已实现路径，真实资金闭环仍待验证；手机布局验收不代替手机钱包能力。开发/运维不代签，用户不在开发电脑登录钱包。

旧 `PUBLIC-DEPLOYMENT.md` 仍保留 rc3 的“未选域名/需购买”背景，本轮未越权修改该文件；新交接入口明确此次已确认 `perpex.ai`，现有管理员只需确认实际服务器与子域名。`ACCEPTANCE.md` 的本机钱包操作入口由主控更新成当前 HTTPS 交接路径，以免与用户最新要求冲突。

## 验证分工与边界

本组运行一次只读 Python 校验：两个改动文件分别恰有一处 `Perpex`，均无旧可见名称；新交接文档全部本地链接目标文件存在。检查通过。不重复构建、全量测试或真实联调；主控统一执行必要回归与最终打包，结果以最新 `ACCEPTANCE.md` 为准。未读取真实 `.env` 或运行数据，未发外部消息，未改 DNS 或创建资源，未连接钱包、签名或广播。
