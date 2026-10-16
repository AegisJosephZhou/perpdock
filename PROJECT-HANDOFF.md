# Perpex 项目接手入口

## 2026-10-15 WalletConnect 更新

本轮新增六个 EVM 主网的 WalletConnect 扫码连接，保留注入钱包与 TronLink；补充报价按钮禁用原因，并修复未记录付款的过期订单返回重新报价入口。配置与使用范围见 [WalletConnect 说明](docs/WALLETCONNECT.md)。

**519/519 应用测试、43/43 部署工具检查、TypeScript 与构建已通过。用户反馈 WalletConnect 连接测试成功；精确授权、小额付款及本单 Hyperliquid 默认 Perps 入账仍未完成资金验收。** 推送状态以远端提交为准。以下原有正文保留此前时点的记录；其中钱包连接范围、测试数量及相关待办以本节和 WalletConnect 说明为准。

先读 [项目交接](docs/SESSION-HANDOFF.md)、[当前进度](docs/PROJECT-STATUS.md) 和 [完整需求](docs/PROJECT-REQUIREMENTS.md)。研发详情见 [10月14日记录](docs/CONTINUATION-2026-10-14.md) 与 [10月15日记录](docs/CONTINUATION-2026-10-15.md)，市场判断见 [公开发现汇总](docs/market/evidence/FINDINGS-2026-10-15.md)。

本次提交包含只读钱包能力检查、HTTPS只读检查器、订单进度与查询时间、失败恢复及迟到响应防护。10月15日462项应用测试、40项部署工具离线测试及构建通过；推送结果以远端提交为准。

Gasless执行、平台收费、目标公网部署和真人资金验收仍未完成。明确测试报名0，持续实质讨论0，客户及付费需求未验证。
