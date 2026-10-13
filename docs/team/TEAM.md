# HL Funding — 开发团队协作

## 用户授权与目标
用户要求迅速开发真实可用的前后端版本，用于之后市场测试；禁止 demo、模拟数据；所有 agent 之间用 Markdown 文档沟通；根代理组织并审核代码，测试成功后才交付。

## 首版范围
以研究方案的入金产品为主：Tron 主网 USDT → 用户控制的 Hyperliquid 默认 Perps USDC 账户。其他真实可用来源链可作为经过验证的补充路线，不能用它们冒充 Tron 路线已通过。
非托管：用户在自己的钱包签名；后台不持有用户私钥、不自行支付、不创建新桥合约。真实 API 报价、签名输入校验、持久化订单、可信链上/HyperCore 入账证据、刷新恢复、诚实错误状态。
不实现杠杆交易、策略、出金或承诺自动退款。不要求用户提供私钥/助记词。

## 协作约束
所有技术沟通、接口变更、审查意见、完成记录写入本目录 Markdown。工具消息只用于通知文档位置；不能替代文档。各负责人只编辑自己的文件，跨边界修改建议写文档。每个工作包结束写测试命令、结果、未验证项。

## 所有权
- root：package/config/shared/contracts，集成，端到端测试，最终审查和发布判定。
- product_delivery：client/**，前端钱包连接、签名及入金流程；docs/team/FRONTEND.md。
- protocol_architecture：server/providers/**、server/chain/**，当前官方路由研究及真实 API 验证；docs/team/PROTOCOL.md。
- risk_security：server/**（排除 providers/chain），数据库、HTTP API、安全/订单流程、后台跟踪；docs/team/BACKEND.md。

## 技术基线
Node >=22.13（node:sqlite），TypeScript，Express，Vite + React，viem，zod。SQLite WAL 持久化；生产单实例 + 持久卷，Docker 配置。以 npm scripts 驱动，禁止运行时 fixture/mock fallback。测试 fixture 仅位于 tests。

## 共享接口
见 ../CONTRACT.md。接口需要变更时先写本组 Markdown，并由 root 更新 CONTRACT.md。

## 验收门槛
typecheck/build、关键安全及状态测试、浏览器操作、真实报价/链上读取均通过；每条资金路线必须独立说明是否完成真实签名转账。未完成资金转账不得标为端到端资金验收通过，更不能称可直接开放市场。
