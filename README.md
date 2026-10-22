# Dock by Perpex

非托管入金应用：把受支持钱包中的稳定币转为用户指定 Hyperliquid **默认 Perps 账户的 USDC 保证金**。正式入口为 [dock.perpex.ai](https://dock.perpex.ai/)，仓库分支中的新功能是否已上线需以部署版本为准。

## 当前代码范围

八个网络、十条具体路线：Ethereum USDT/原生 USDC、Arbitrum USDT0/原生 USDC、Base USDC、Optimism USDC、Polygon USDC、BNB Chain 映射 USDT、Tron USDT，以及本次新增的 **Solana 原生 USDC**。合约、精度和限制见 [场景清单](docs/SCENARIO-COVERAGE.md)。

- EVM：实际检测的注入钱包，以及管理员配置后的 WalletConnect 扫码连接。
- Tron：TronLink。
- Solana：Phantom / Solflare 浏览器扩展，另填独立的 `0x` Hyperliquid 收款地址，需要 SOL 手续费。详见 [Solana 说明](docs/SOLANA.md)。
- 中英文界面、网络与币种选择、真实余额、报价净额与最低到账、订单进度、收据及中断恢复。
- 可选的第一方推广归因默认关闭；配置方式见 [推广配套开发说明](docs/GROWTH-RELEASE.md)。
- 入金运营记录与离线报表、可选 Sentry 错误监控和 PostHog 漏斗、Better Stack 每分钟监控配置工具；见 [监控说明](docs/OBSERVABILITY.md)。外部采集默认关闭，代码交付不等于生产已启用。

React + Vite 前端，Node/Express 后端，SQLite 持久化。Relay 提供实时报价与结算；服务端独立核验来源付款及可归属的 Hyperliquid 账本。生产代码不提供模拟报价、余额或虚构到账。服务端不保管用户私钥，不代用户转账。

## 安全与完成状态

报价绑定来源币、金额、付款人、收款人、协议订单和 solver 签名。付款签名前再次核验钱包、账户、网络、余额及交易内容；订单凭据与付款标记持久保存。签名结果不明时先恢复原单，不能自动重付。

Solana 签名后核对完整消息和唯一付款人签名，先保存完整 base58 交易编号再广播。源链最终确认、Relay 结算及本单目标 Perps 账本证据都满足后才显示完成。

最新验证见 [验收记录](docs/ACCEPTANCE.md)。自动化测试和真实只读报价不能替代钱包签名及资金到账验收。本轮代码交付不包含生产部署；Gasless 实际执行、平台收费、出金、合约交易和白标 SDK 尚未实现。当前仍需来源链的 ETH、BNB、POL、TRX 或 SOL。

## 本地运行

要求 Node 24 LTS、npm，以及可访问 Relay、来源链 HTTPS RPC 和 Hyperliquid 的网络。

```sh
npm ci
test ! -e .env && cp .env.example .env
npm run build
npm start
```

打开 http://127.0.0.1:8787 。开发模式分别运行 `npm run dev` 和 `npm run dev:client`，访问 http://127.0.0.1:5173 。真实钱包验收应在正式 HTTPS 环境由用户本人操作。

各链服务端 RPC 配置见 `.env.example` 与 `deploy/.env.public.example`。不得接受访客传入的 RPC URL 或向浏览器暴露带令牌的端点。Solana 浏览器固定使用公共主网 RPC；限流、CORS 或地区不可用时会阻止签名，服务端自定义 RPC 不会改变客户端端点，见 [配置限制](docs/SOLANA.md#rpc-与部署配置)。

## 验证与运维

```sh
npm run typecheck
npm test
npm run build
npm run test:deployment
npm audit --omit=dev
# 使用独立临时数据库：真实只读报价、未签名订单、重启和备份恢复；无签名或广播。
npm run test:production
```

测试夹具仅在 `tests/fixtures`，不会作为生产备用数据。完整 Relay settlement SDK 与 TronWeb 仅用于开发测试；Solana 的 `@solana/web3.js` 是运行依赖。当前依赖审计的已知项见 [Solana 说明](docs/SOLANA.md#验证边界)，不要盲目执行 `npm audit fix --force`。

单实例部署、稳定订单密钥、HTTPS、持久化存储和备份要求见 [部署交接](docs/DEPLOYMENT-HANDOFF.md)、[运维说明](docs/OPERATIONS.md) 与 [API](docs/API.md)。不要清理含在途订单的数据卷。历史研发记录保存在 `docs/CONTINUATION-*`；当前钱包与链支持范围以本页和 Solana 说明为准。
