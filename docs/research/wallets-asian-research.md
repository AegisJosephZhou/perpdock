# 六个钱包的 Hyperliquid 集成研究

核验日期：2026-10-12。只读公开资料，未登录、未安装钱包、未签名、未转账。以下是各品牌自身文档/公告的证据，不代表本次已实测；未找到不等于产品不存在。

## 可供汇总的数量结论

在指定六品牌中，按“钱包提供自己的永续交易面板或专用内嵌交易模块”计，**已取得一手证据的有 4 家：TokenPocket、Bitget Wallet、SafePal、MathWallet**。其中 TokenPocket 文档明确是浏览器扩展已上线，手机端仍写即将推出；其他三家有手机钱包集成证据。这个数字只是本组六品牌的确证数，不能当作全球总数。

imToken 已证实 Token Function 内的 Hyperliquid DApp 入口，尚不能据此说它提供独立的原生交易界面。OKX 已证实官方 Onchain OS 商店的 Hyperliquid Agent 插件，它与手机钱包内置 Perps 面板应分开统计。

## 品牌与资金流程

| 品牌 | 一手证据支持的类别 | 已公布的来源资产/链与流程 | 自动换币跨链 | 明确 Tron USDT → HL？ |
|---|---|---|---|---|
| TokenPocket | 原生钱包交易，浏览器扩展；手机端未由此页证实已上线 | 扩展 → Perps → Add → 选网络与币种 → 查看预计 USDC、服务费、路线 → Confirm Swap → HL Perps 余额 | 官方明确所选币换成 USDC 并存入 HL；文本没有枚举可用源链/币 | 未找到具体该资产对的文字证据 |
| Bitget Wallet | 自身公告确证深度集成、钱包内永续交易 | 自家年报明确用户可用 USDT 或 USDC 交易；该公告未列来源链与逐次点击步骤 | 有简化资金转移的产品描述；缺少针对 HL 入金的详细流程证据，不把一般跨链能力直接等同于本功能 | 未确认消费端该路线；开发文档有 Tron 和 HyperCore 的跨链能力支持 |
| SafePal | 手机钱包原生/专用 Mini Program | Trade → Perpetuals → Hyperliquid → Deposit → Arbitrum USDC → 确认与签名 → Enable Trading | 当前专用教程明确只支持 Arbitrum USDC；没有 USDT 自动换币承诺 | 未证实；这份教程明确当前入金为 Arbitrum USDC |
| MathWallet | 手机钱包 Hyper/Perps 模块 | 官方以 Ethereum 钱包为例：Hyper → Add Funds → ETH 进入 Hyper 现货 → 点击 ETH 将其换成 USDC 合约余额 | 入金与换币分两次操作；不能称所示流程全自动。模块也可从 Solana/Arbitrum One 钱包进入，但未据此推定所有入金资产 | 未证实 |
| imToken | Token Function 的 HL DApp 入口 | Arbitrum 钱包准备 USDC+少量 ETH → USDC 详情 → Token Function → 交易 → Hyperliquid → 连接/签名 → HL 页面账户/存款 → USDC 入永续账户 | 该教程从已有 Arbitrum USDC 开始，没有证明任意币自动换入 | 未证实；通用 Token Function 支持 Tron 不等于 HL 该路线可用 |
| OKX Wallet | Onchain OS Agent 插件，不能据此计作手机原生 Perps | 插件要求 Arbitrum USDC+ETH，查询状态/地址 → deposit → 注册签名地址 → 交易 | 文档要求先准备 Arbitrum USDC；不是任意源资产一键入金的证据 | 未证实 |

上述每行证据和边界见下方直接链接。对用户解释时，钱包里的“添加资金”应区分：已有合格保证金资产直接存入、兑换/跨链自动编排、先存现货再手动换成保证金。三种实际体验不同。

## 1. TokenPocket：浏览器扩展已上线，可自动换币存入

官方教程直接明确由 Hyperliquid 提供交易基础设施，浏览器扩展内完成 Add、选市场、开仓和平仓。Add 时选择网络及币种，确认预计 USDC、服务费和 swap route；所选币换为 USDC 并存入 HL Perps。未列源链完整白名单、具体服务费率或明确 Tron USDT；并提示可能存在地区限制。文档仍写 mobile coming shortly，不能将浏览器版本扩大为手机已上线。

- [TokenPocket：How to Trade Perps on TokenPocket](https://help.tokenpocket.pro/en/wallet-operation/perps-trading)
- [TokenPocket：HyperEVM 钱包支持教程](https://help.tokenpocket.pro/en/wallet-operation/how-to-create-a-wallet/hyperevm)——只能作为 HYPE/HyperEVM 支持证据，不能单独证明 Perps。

发现过程：第三方 Telegram 镜像只用来找原始文档链接；结论使用上面的 TokenPocket 自身文档，不依赖镜像或其他钱包的竞品文章。原始 Telegram 最近页未含对应旧帖，不据镜像给发布日期。

## 2. Bitget Wallet：已内置交易，具体 HL 入金路径仍需核验

自身 2025 年回顾（页面日期 2025-12-22）明确介绍深度集成 Hyperliquid，并可用 USDT/USDC 进行钱包内永续交易。这足以计入集成品牌，但不提供完整的源链列表、钱包按钮次序或“Tron USDT 一步入金”的证据。

- [Bitget Wallet in 2025: The Year We Built Everyday Finance](https://web3.bitget.com/en/blog/articles/bitget-wallet-2025-review)

**当前状态交叉确认：**2026-09-25 官方 Tatadex 维护公告将停提现、新用户停充值限定于 Tatadex，并明确新用户可通过 Bitget Wallet 改用 Hyperliquid 或 PopDex。这支持 HL 作为独立的现行钱包内服务，不能把 Tatadex 维护误说成 HL 入金下线；但仍没有证明每条 HL 来源资产/链在此刻都能成交。

- [Bitget Wallet：Tatadex Service Maintenance Notice](https://web3.bitget.com/en/blog/articles/tatadex-service-maintenance-notice)

2026-09-28 更新的开发文档，Trading Capabilities 同时列 Tron (`trx`) 与 HyperCore (`hyperliquid`) 支持 cross-chain；跨链限额表在 Tron 行列 liqBridge 和 deBridge，在 HyperCore 出发链行列 relaylink。这说明其路由能力值得作为直接竞品测试，但**两个链各自支持跨链不等于任意资产对和钱包内 Perps 入金路线已接通**。需要实时报价、目的账户类型及真实入账证据，才能确认 Tron USDT → HL Perps。

- [Bitget Wallet：Chain & API Support](https://web3.bitget.com/en/docs/authentication/supported-chains)

未引用二次转载的 0.06%–0.09% 交易费作为当前承诺；未把钱包卡充值、假同名代币购买页面或 Bitget 中心化交易所合约教程当作 HL 集成证据。也不将 2025-10 的通用 Futures 教程中“USDT 存合约”自动套用于后来接入的 HL。多供应方共存意味着通用 Perps/452 教程列出的全部链币不可直接归属于 Hyperliquid 路线。

## 3. SafePal：原生集成升级到 Mini Program，当前教程仍要求 Arbitrum USDC

自身 2025-11-19 公告确证原生集成；2026-09-23 公告升级为 App 内专用 Hyperliquid Mini Program。最新专用操作教程更新于 2026-09-22，要求 App v4.11.9+，流程为 Trade/Perpetuals 进入 HL、Deposit、Arbitrum USDC、确认签名，再 Enable Trading。教程明确当前只支持 Arbitrum USDC；不是通用 USDT 自动跨链入口。

- [SafePal 2025 原生集成公告](https://safepal.com/en/blog/hyperliquid-hype-integration)
- [SafePal 2026 Mini Program 公告](https://www.safepal.com/en/blog/hyperliquid-mini-app)
- [SafePal 专用操作教程](https://safepalsupport.zendesk.com/hc/en-us/articles/55586631601947-How-to-trade-on-Hyperliquid-Perp-DEX-with-the-SafePal-App)

公告列入金最低 5 USDC；出金最低 2 USDC、网络费 1 美元，签名前展示费用，并注明地区资格限制。这是该钱包公告口径，未通过 App 实测，不应扩大成 HL 所有路线的统一限制。该教程有一行将 Arbitrum ETH gas 错写关联 BNB Smart Chain，正文与步骤明确 Arbitrum，不传播该明显笔误。

## 4. MathWallet：ETH 现货入金再换 USDC，有明确的两步体验

官方 2025-10-30 教程明确 App 有 Hyperliquid Perps 模块。以 Ethereum 钱包演示：点击 Hyper；Add Funds 存 ETH 至 Hyper 现货；到账后点击 ETH，再换为 USDC 合约余额；随后交易。它也说可从 Solana、Arbitrum One 等钱包进入模块，但不应推定 ETH 示例代表每条链都以相同方式入金。文中的 ETH 存取最低 0.05 是该教程数值；当前费率、地区名单和 Tron 入金均未在此页证实。

- [MathWallet：Hyperliquid Perps User Guide](https://blog.mathwallet.org/?p=4902)

## 5. imToken：已证实入口整合，不能混算为独立原生交易面板

官方 2026-03-03 更新的教程，从 Arbitrum USDC 和少量 ETH 开始，经 USDC 的 Token Function 进入“交易 → Hyperliquid”，连接并签名后进入 HL 页面，再从账户存款把 USDC 存入永续账户。交易费指向 HL 官方费率。此证据支持精选 DApp 入口与钱包签名集成，不能证明钱包重做了原生交易界面或自动兑换/跨链入金。教程末尾虽提通用 Token Function 覆盖 Tron 等链，也不足以证明 Tron USDT → HL。

- [imToken：Arbitrum USDC Token Function 与 Hyperliquid 教程](https://support.token.im/hc/zh-cn/articles/55653169141401)
- [imToken：Token Function 上线说明](https://support.token.im/hc/zh-cn/articles/51793345991577)

## 6. OKX Wallet：Agent 插件另算

官方 Onchain OS 插件商店提供 Hyperliquid 插件，作者标为 GeoGu360；文档要求 Onchain OS CLI、Arbitrum USDC 与少量 ETH，再执行入金、注册签名地址和交易。这证明官方平台有 Agent/DApp 接入，不证明手机钱包首页已内置完整 HL Perps 产品。未得到具体手机点击路径、Tron USDT 自动入金、当前费率或地区完整名单。

- [OKX：Hyperliquid Onchain OS 插件](https://web3.okx.com/onchainos/plugins/detail/hyperliquid-plugin)
- [OKX：Agentic Wallet DApp 说明](https://web3.okx.com/zh-hans/onchainos/plugins/detail)

## 对当前商业方案的含义（研究判断）

1. “钱包能自己接 HL”已经是多品牌实际产品，不只是技术上可能；TP 甚至已有在入金面板选币、自动换 USDC 和存 HL 的流程。
2. 仍不能将“已内置交易”推导为“已经覆盖 Tron USDT 的全部入金链路”；本组没有获得该特定消费端路线的充分文字证据。Bitget 的 API 覆盖意味着这是应优先实测的竞争能力，不能写成竞争空白。
3. “支持 HyperEVM/HYPE”“DApp 入口”“Agent 插件”“钱包专用 Perps 面板”应分别统计。原方案将 imToken 和 TokenPocket 一并称为“已接 HL”可作宽口径描述，但讨论产品竞争时必须拆开；TP 目前明确的是浏览器扩展。
4. 多份钱包教程仍写 Arbitrum USDC。它们可证明产品当时/当前公布的交互，不应反推协议只支持这条链或把旧路线写成新集成唯一方式。实际开发仍需以当前协议、钱包版本与可执行报价核验。
