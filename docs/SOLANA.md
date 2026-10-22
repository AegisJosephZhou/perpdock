# Solana 原生 USDC 入金

Dock 新增 `solana-usdc-hypercore`：Solana 主网原生 USDC → 用户确认控制的 Hyperliquid 默认 Perps USDC 账户。代码支持不等于此版本已部署或已经完成真人资金验收。

## 使用范围

- 来源链：Solana mainnet-beta，Relay chain ID `792703809`。
- 资产：Circle 原生 USDC，mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`，6 位精度。
- 钱包：检测到的 Phantom、Solflare 浏览器扩展，支持选择具体钱包。连接、余额读取和签名固定同一个 provider；账户变化使原报价失效。
- 收款：需另填自己控制的 `0x` Hyperliquid 主账户地址并确认；Solana 付款地址不会填入收款地址。
- 手续费：需要 SOL 支付链上费用及可能的代币账户租金。此路线没有 ERC-20 allowance 授权步骤。
- 不包含 Solana USDT、原生 SOL 入金、Solana WalletConnect、Mobile Wallet Adapter 或硬件钱包兼容保证。手机布局正常不代表钱包签名已验收。

## 交易与核验

1. 服务端核对 Relay 链配置、固定 depository/vault、USDC mint、付款人、金额、退款地址、目标默认 Perps 账户、协议订单哈希及 solver 签名。主网 genesis、程序账户或 mint 校验失败时关闭新报价。
2. 只接受一条经过核对的 deposit 指令，逐项验证 10 个账户及权限、金额和订单编号；拒绝额外调用、授权和不透明交易。客户端用这条指令构造 legacy 交易，不使用地址查找表。
3. 签名前读取真实 USDC/SOL 余额、估算费用并模拟执行。签名后检查完整消息未改变且唯一付款人签名有效，先持久保存完整 base58 交易签名，再广播一次。网络结果不明时保留原单，不能自动重付。
4. 服务端从 finalized RPC 记录核验唯一付款人、完整指令、USDC 源账户扣减与金库入账、SOL 费用及允许的内部调用。Solana 签名保留大小写，并绑定对应订单。
5. 源链成功后仍需 Relay 的本单结算记录和可归属的 Hyperliquid 默认 Perps 账本证据。未最终确认、RPC 无结果、Relay 延迟或仅总体余额上涨都不能标作完成。

## RPC 与部署配置

服务端 `SOLANA_RPC_URL` 默认 `https://api.mainnet-beta.solana.com`，已加入本地和公网 Compose 样例。运营方可配置自己的 HTTPS RPC；该值只在服务器使用，不接受访客传入，也不会进入浏览器配置。

浏览器固定访问 `https://api.mainnet-beta.solana.com`，CSP 仅放行该精确来源。公共端点出现限流、地区限制、超时或 CORS 拒绝时，客户端会阻止签名；服务端自定义 RPC 不能解决浏览器端可用性。发布前需从目标域名及真实用户地区验证该端点。以后如需替换，应一并审核客户端固定地址、CSP 和回归测试，不能把私有 RPC 凭据暴露给浏览器。

此功能没有数据库表结构迁移；现有 EVM/Tron 订单继续使用原来源链命名空间，Solana 另用 `solana:mainnet`。恢复时继续查询已保存的原签名，不创建替代付款。

## 验证边界

2026-10-22 已完成真实主网健康检查及合成地址的只读 Relay 报价核验。另抽查公开 Relay deposit 交易，确认实际使用 SPL TransferChecked，源 USDC 减少与金库 USDC 增加一致。这些观察没有操作用户钱包，也不能替代 Dock 的实际付款验收。

最终自动化与构建结果见 [验收记录](ACCEPTANCE.md)。发布后的人工验收需分别在 Phantom 和 Solflare 完成：连接、余额、独立收款地址、拒签、账户变化、小额签名、保存原交易、恢复查询及本单 Perps 入账。只读报价不能证明未来报价或到账时长。

生产依赖审计（2026-10-22）：0 个 high/critical，4 个 moderate（`@solana/web3.js` → `jayson` → `stream-json` / `uuid` 的直接或传递报告）。保留兼容版本；没有使用 `npm audit fix --force`。本应用不调用相关 JSONC/流过滤及 UUID v3/v5/v6 可选输出缓冲功能，但这不等于依赖漏洞已经修复。

## 协议依据

- [Relay Solana 接入说明](https://docs.relay.link/references/api/api_guides/solana)
- [Relay 报价输入核验](https://docs.relay.link/references/api/api_core_concepts/input-validation)
- [Relay Hyperliquid 接入说明](https://docs.relay.link/references/api/api_guides/hyperliquid-support)
- [Circle USDC 合约地址](https://developers.circle.com/stablecoins/usdc-contract-addresses)
