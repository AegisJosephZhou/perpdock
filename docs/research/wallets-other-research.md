# 六个钱包的 Hyperliquid 内置交易与入金研究

核查日期：2026-10-12。范围：公开的品牌官方产品页、帮助文档、公告；未登录、未连接钱包、未签名或转账。本稿区分“官方文档确认上线”和“实际操作验证”：下列结论都是前者。地区、版本、资产列表仍需以可用产品界面为准。

## 结论和计数

这组六个品牌中，可计入“钱包内已上线 Hyperliquid perps”的有 **4 个：Trust Wallet、Ledger Wallet、OneKey、KuCoin Web3 Wallet**。Ledger 通过 Yield.xyz 提供，应标记为第三方服务内嵌。当前查到 Binance Wallet 内置 perps 是 Aster，Gate 是自家 Gate Perp DEX/Gate Layer；这两个不能计入 HL。此结论不是宣称它们绝对无法连接 HL dApp，也不是全球完整钱包总数。

| 品牌 | 钱包内 HL perps 状态 | 已明确的平台 | 官方支持的入金范围 | Tron USDT 到 HL 判断 |
|---|---|---|---|---|
| Trust Wallet | 已上线；同时内置 Aster，统计必须按 venue 区分 | iOS、Android | Perps 外部入金文章列多链多资产，包含 Tron USDT；另有官方 HL 公告确认 SOL 可转成 HL USDC | **Perps 入金支持 Tron USDT 已明确；该统一文章未明确对应 HL/Aster，HL 路线仍需专项确认** |
| Ledger Wallet | 已上线，通过 Yield.xyz | 移动端、桌面端；结合 Ledger 硬件签名器 | 官方教程为 Arbitrum USDC，需要 Arbitrum ETH gas | 当前所读内置流程未列 Tron USDT；不能由 Ledger 支持 Tron 推导 |
| OneKey | 已上线，Hyperliquid 驱动，内置 App | 桌面、移动；支持 App 热钱包和硬件钱包 | Arbitrum USDC；入金帮助文档另明确 Ethereum USDT、Arbitrum USDT 可由第三方自动换/桥到 Arbitrum USDC | 所读 perps 入金文档未明确 Tron USDT，不等于已证明不支持 |
| KuCoin Web3 Wallet | 已上线；6月官方还宣布 HIP-3 扩展 | 移动端明确 | 当前帮助文档仍写仅 Arbitrum USDC；需要 Arbitrum ETH gas | 文档未支持；USDT/SOL/ETH 多资产入金被列为 future，不能算上线 |
| Gate Web3 Wallet | 未确认内置 HL；已确认的是 Gate Perp DEX | Gate Web3 网页，Gate App 有对应产品文档 | Gate 自己产品的入金不能当作 HL 路线 | 未确认，不计 |
| Binance Wallet | 未确认内置 HL；已确认的是 Aster 内嵌 perps | Web、App；仅符合条件的 Keyless wallet | 官方 FAQ 为 BSC 上 Aster，列 BNB/ASTER/USDT/USD1 等抵押资产 | 该能力是 Aster 不是 HL；不能当成 Tron→HL 支持 |

## 1. Trust Wallet

**已确认内置：** 官网当前 Perps 页面明确同时原生集成 Hyperliquid 与 Aster，移动端 iOS/Android 可用；这不是浏览器里收藏一个 HL dApp 的级别。[Trust Wallet Perps 产品页](https://trustwallet.com/perps)

**可引用的操作：** 打开 Trust Wallet → Perps → Deposit → Exchange or other wallet → 选择网络 → 检查支持币种 → 将该网络该币种发送到界面本次给出的地址。用户不必先把资金提到普通余额再自己找桥。官方文章发表于 2026-07-02、更新于 2026-07-17。[官方外部入金教程](https://trustwallet.com/blog/company/deposit-directly-from-cex-to-trust-wallet-perps)

该教程列明网络：Ethereum、BNB Chain、Solana、Base、Arbitrum、Optimism、Polygon、Avalanche、Bitcoin、Tron；其中明确 Tron 仅列 USDT。其他示例包括 Ethereum USDT/USDC/ETH、Arbitrum USDT/USDC/ETH、Solana USDT/USDC/SOL、BTC。

**重要证据边界：** 此教程的文字说 Trust Wallet Perps，没有逐项标明 Hyperliquid 或 Aster。由于品牌支持两个交易场所，严谨表达应为“Trust 的 Perps 外部入金已官方列出 Tron USDT，Tron→HL 的具体选择与路由待查实”，不能直接下结论“已证实 Tron USDT 一步入 HL”。已尝试打开文中入金配图，图片工具读取失败，环境无可用浏览器，尚未通过配图核对目标场所。

HL 专属资金例子：Trust 官方公告频道写明 SOL 直接存到钱包内 Hyperliquid 并转换为 HL USDC；可以证明它不仅支持 Arbitrum USDC 原样入金，但不能拿 SOL 推导 Tron。[Trust 官方公告频道，SOL→HL](https://t.me/s/trust_announcements?before=960)

不要使用 2024 年旧“Beginner's Guide to Hyperliquid”作为当前标准流程：它讲先换 USDC.e 再连 dApp，既早于钱包内集成，也存在币种表述需核实的问题。

## 2. Ledger Wallet

Ledger 自己 2026 年产品公告明确“钱包内可用、Yield.xyz 提供、底层 Hyperliquid”。这应计入用户体验上的内置 HL，但不能因此说 Ledger 自建了 perp 运营后端。[Ledger 产品公告](https://www.ledger.com/blog-perpetual-trading)

流程：打开 Ledger Wallet 的 Perpetuals → Trade Perps → 阅读并接受 Yield 条款与风险披露 → Deposit → 按需创建 Arbitrum 账户 → 从 Arbitrum USDC 余额入金 → 在 Ledger 设备核验并签名 → 到 HL 交易账户后交易。

官方帮助页注明准备 Arbitrum USDC 与 ETH gas，仅支持该 USDC 入金；这意味着用户只有 Tron USDT 时，还需先有可用换汇/跨链步骤，本文未发现把这一步纳入该 perps Deposit 的官方证据。[Ledger 帮助文章（俄文官方版本，可在搜索索引读取正文）](https://support.ledger.com/ru/article/trading-perpetuals-perps-with-yieldxyz-through-ledger-wallet)

平台：Ledger Academy 明确移动和桌面 Ledger Wallet 均可访问该 Yield/HL 产品。[Ledger 官方说明](https://www.ledger.com/academy/topics/economics-and-regulation/perpetual-trading-explained-what-is-it-and-how-does-it-work)

## 3. OneKey

官方帮助文档明确 Hyperliquid 已嵌入 OneKey App，桌面或移动端可进入 Futures/Perps。另一介绍说明热钱包和硬件钱包均可参与；只读钱包仅观察，不应计为可交易钱包。[集成与平台](https://help.onekey.so/en/articles/12071735-introduction-to-onekey-app-perps-perpetual-futures)；[OneKey Perps 介绍](https://help.onekey.so/en/articles/13987899-onekey-perps-introduction)

操作：OneKey App → Futures/Perps → 初次按界面完成交易授权（硬件账户需设备）→ 左上 Deposit → 选择钱包资产 → 确认兑换、跨链、费用和签名 → USDC 入交易账户。

**不是只能 Arbitrum USDC。** 当前官方入金文档首先推荐 Arbitrum USDC，随后明确其他资产如 Ethereum USDT、Arbitrum USDT 由第三方协议自动兑换/跨链成 Arbitrum USDC；但没有列出 Tron。教程还列跨链、滑点及平台服务费，应以实际报价为准。[官方入金/出金文档](https://help.onekey.so/en/articles/13988073-perps-deposits-withdrawals-and-settlement-currency)

OneKey v6.5.0 发布说明还有 Arbitrum USDC perps 入金 gas 补贴，表明用户准备 gas 的要求可能随路线而变；不能给所有用户固定说必须另备 ETH。[OneKey App 更新日志](https://help.onekey.so/en/articles/11461391-onekey-app-update-log)

## 4. KuCoin Web3 Wallet

官方帮助中心明确移动端钱包内 perps，底层是 Hyperliquid，无需外跳第三方 dApp。2026-06-01 公告又说明在 1 月 native in-wallet Perps 基础上接入 HIP-3，初期通过 XYZ 扩展市场。[官方产品介绍](https://www.kucoin.com/web3/support/48142946141523)；[官方 HIP-3 升级公告](https://www.kucoin.com/blog/pk-kucoin-web3-wallet-expands-into-crypto-tradfi-perpetuals-with-hip-3-upgrade)

入金步骤明确：打开钱包并切换 Web3 → Perps → Add Funds → 输入 USDC 数量 → 确认交易。源资产为 Arbitrum USDC，并需少量 Arbitrum ETH gas。[官方入金教程](https://www.kucoin.com/web3/support/48142946141528)

当前帮助 FAQ 仍明确仅 Arbitrum USDC 进出。产品介绍将 ETH/SOL/USDT 入金自动换 USDC 标为未来计划，故不能统计为当前支持的多链入口。6 月 HIP-3 公告是市场扩展，不能推导已上线这些入金币种。[官方 FAQ](https://www.kucoin.com/web3/support/48142946141450)

## 5. Gate Web3 Wallet

本次搜索未找到 Gate 自己公告或帮助文档足以确认钱包内接入 HL perps。官方 2025-09-29 公告及当前 Gate Web3 首页确认的是 **Gate Perp DEX，基于 Gate Layer**，与 HL 是不同场所。[Gate 正式上线公告](https://www.gate.com/announcements/article/47421)；[当前 Gate Web3 产品页](https://dex.gate.com/)

因此其内置 Perps 按钮、支持 HYPE、支持网络或能连接 dApp 都不构成“内置 Hyperliquid”的证据。当前不可给出经过该钱包原生 HL 模块的入金步骤，标为未确认即可。不是宣称 Gate 钱包绝对不能作为签名器连接 HL。

## 6. Binance Wallet

Binance 自己 FAQ 明确 Web 与 App 内置 perps 均由 **Aster** 提供，交易都在 Aster 执行，当前网络为 BSC。页面还能看到完整资金操作步骤，因此无需依赖 Square 用户投稿作证。[Binance 官方钱包 Perps FAQ](https://www.binance.com/en/support/faq/detail/7a0b1e282453479da1d7216b9cf83402)

App 实际入口说明为 Binance Wallet → Markets → Perps → Enable Trading → Transfer → 选择币种和数量 → Deposit；仅支持满足备份条件的 Keyless wallet。**这些是 Aster 入金步骤，不能放进 HL 入金流程图。** 本次未找到足以确认原生 HL 接入的官方资料，不计入 HL。

Binance 中心化交易所上市 HYPE、HYPEUSDT 合约、Binance Square 文章提到 Hyperliquid，均不能当作 Binance Wallet 集成 HL 的证据。

## 建议给主报告采用的统计口径

1. “内置 HL”定义：品牌官方确认用户在钱包自身 Perps 产品中开平仓，执行场所是 HL；经 Yield 等服务商也计入，单列 provider。
2. 本组 **4/6 品牌已官方确认**；Gate/Binance 另列“已有其他场所 Perps”。不把手机和桌面版本、硬件型号、地区版本重复计数。
3. 多链入金、源资产支持、Tron USDT 支持各自单列；不与“钱包能保存某链币”混为一谈。
4. Trust 的 Tron USDT 统一 Perps 外部入金是商业模式必须研究的竞争证据；HL 场所路由尚未核验，不应忽略，也不应先替其确认。
5. 统计值是“本次品牌样本且官方可确认的下限”，不对“全球所有钱包有多少”作完整性宣称。
