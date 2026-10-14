# 西方钱包 Hyperliquid 内置 Perps 核查

访问日期：2026-10-12。仅采用品牌自己的产品页、帮助中心、开发者商店说明、官方开源仓库作为确定性依据；媒体和竞争对手文章仅用于找线索。未登录钱包，未实际报价或转账。

## 统计口径与结果

“内置”要求钱包自身提供开仓、管理或平仓界面，底层明确为 Hyperliquid；仅支持 HyperEVM、查看资产、DApp 浏览器或连接 app.hyperliquid.xyz 不计。一个品牌的移动、扩展和自家 Terminal 合计一家。Base App / Coinbase Wallet 是同一产品链，不重复计算。

本组五个品牌均可判断已提供原生 HL Perps：四家有可直接阅读的官方产品/帮助文档；Rabby 使用开发者发布说明和官方代码交叉确认，证据等级略低，原始发布公告本次访问受限。若最终统计坚持“单个可读官方文档同时写明已上线和 Hyperliquid”，本组应写保守下限 4 家，并把 Rabby 列为额外已交叉确认 1 家。

| 品牌 | 原生 HL Perps | 已确认端 | 入金起点与处理 | 路由供应商 | Tron USDT |
|---|---|---|---|---|---|
| MetaMask | 是，A级官方产品页 | Mobile、Extension | 支持的 EVM 资产 → 自动兑换/跨链 → HL USDC；也可直接从钱包为订单付款 | 本次官方 Perps 文档未明确命名 | 未明确支持；EVM 范围不能外推至 Tron |
| Phantom | 是，A级官方帮助 | Mobile、自家 Phantom Terminal（连接扩展） | Cash、SOL 或其他受支持 Solana token → USDC → HL 独立 Perps 余额；可在开仓时完成 | Relay，帮助中心明确命名 | 未明确支持 |
| Rainbow | 是，A级官网+帮助 | iOS/Android；桌面 Perps 未单独确证 | 钱包首页资产下方 Perps；具体资金选择/桥接步骤未公开核实 | 未确证 | 未明确支持 |
| Rabby | 是，B级官方发布说明+代码 | 移动确认；Extension 有官方实现；独立 Rabby Desktop 不应混同 | 原生 Perps 界面存在；可用源链/币种及自动桥接范围尚待产品级实测 | 未确证 | 未明确支持；不能从“EVM钱包”外推 |
| Base App / Coinbase Wallet | 是，A级开发者商店+条款 | 移动确认；网页存在，但网页 Perps 完整上线范围未单独确认 | EOA/Smart Wallet → 协议账户/余额 → 授权交易；具体源资产/源链步骤未公开核实 | Perps 供应商 HL；资金路由未确证 | 未明确支持 |

这些是本组品牌计数，不能宣称全球钱包总数；“未明确支持 Tron”不等于已经证明不支持，也不等于不存在外部桥接方案。

## 1. MetaMask

确定事实：官网直接说明 Hyperliquid 是 Perps 底层，Mobile 和 Extension 均可交易。资金流程为打开 MetaMask → Perpetuals → 任一市场 → Add funds → 选 EVM token 和网络 → 自动转换为 HL 上 USDC。官网最低入金金额为 10 美元；可选择预充值或直接由钱包余额付款。文案称 Solana tokens 尚不支持。地区示例排除美国、英国、加拿大安大略、比利时及制裁地区。

- 官方产品/FAQ：https://metamask.io/perps
- 官方博客，说明用 Optimism ETH 等资产无需用户手工走兑换和桥接流程：https://metamask.io/news/what-is-hyperliquid
- 官方支持入口（本次抓取正文为空，不用于补充未经核实的步骤）：https://support.metamask.io/manage-crypto/trade/perps/how-to-trade-perps/

限制：产品 FAQ 同页有“USDC on HyperEVM”“Arbitrum→HyperEVM”措辞，不应把营销页面当成协议结算架构证明；最终可交易余额应按 HyperCore 账本确认。页面“any EVM token”应解释为应用能够给出有效路由的支持资产，不能承诺所有流动性极差代币均可成交。未从 MetaMask 自己的 Perps 文档核实资金路由商名称；不要直接把通用 Swaps/Bridge 合作方套入 Perps。

## 2. Phantom

确定事实：现行官方帮助明确 Mobile 和 Phantom Terminal 均提供 HL Perps。同一账户跨端同步。入金：Home → Perps → Available funds / Add → 选资金来源和金额 → 查看报价费用 → Add Funds；资产先兑换 USDC，再经 Relay 跨链至 HL。也可在 Long/Short 订单时选 Cash、SOL 或受支持 Solana token 直接付款。保证金归属 Phantom 的 Ethereum 地址，要求多链账户开启 Ethereum。平仓回到独立 Perps 余额，提现才桥回 Cash 或选定 Solana token。Ledger 不支持；美国、英国等地区不可用。

- 当前完整交易、入金和故障恢复帮助：https://help.phantom.com/articles/trade-perps-in-phantom-42292249388307
- 当前原理/余额帮助：https://help.phantom.com/articles/understanding-perp-trading-in-phantom-52933464501907
- 初次发布（2025-07-08）：https://www.phantom.com/learn/blog/phantom-perps

新旧口径：2025 年发布稿的 mobile/SOL 起步不能当作 2026 年的完整范围；现行帮助已包含 Terminal、Cash 和更多 Solana 资产。桌面路径是扩展连接 Phantom 自家 Terminal，不应写成扩展弹窗本身有完整交易终端。官方明确 Relay 状态用于资金在途查询，Hypurrscan 只显示已经进入 HL 的余额。费用以订单/充值确认页为准，不把官方帮助中的某个费率概括为所有市场统一费率。

## 3. Rainbow

确定事实：官网 Perps 卡片明确底层 Hyperliquid；官方帮助给出首页资产下方 Perps 入口，并可打开和查看仓位。该帮助归属手机 App 支持栏目；移动原生界面确认。官网整体有桌面下载入口，但尚不能据此确认桌面扩展的 Perps 同步支持。

- 官网：https://rainbow.me/
- 原生操作入口帮助：https://rainbow.me/support/app/perps-on-rainbow
- 手机 App 支持分类：https://rainbow.me/ja-jp/support/app
- 品牌自己发布的投资人/代币持有人信（补充上线历史，2025 下半年上线 HL Perps）：https://github.com/rainbow-me/investors/blob/main/Presentations/2026%20RNBW%20Token%20Holder%20Letter/2026%20RNBW%20Token%20Holder%20Letter.md

必要保留：帮助中的“例如 USDT 现金结算”是通用 Perps 教学文字，不能作为 Rainbow 实际收取 USDT 保证金、支持 Tron USDT 或具体桥接链的依据。未找到 Rainbow 自己公开说明的完整充值币种/链清单与路由供应商，不能补写成“任意链一键入金”。

## 4. Rabby

确定事实：开发者 App Store 版本说明写明 0.6.72 增加 Perps 限价单、0.6.87 增加 Perps 组合概览和 Pro Mode。自家 RabbyHub/Rabby 的原生 Perps 模块引用 @rabby-wallet/hyperliquid-sdk，实例明确 isTestnet:false，含账户和签名处理。发布说明证明产品确有交易功能，代码证明底层并非仅 DApp 连接；两者交叉支持内置 HL Perps 已上线。

- 开发者发布说明（仅用 What’s New，不用用户评论）：https://apps.apple.com/sg/app/rabby-wallet-crypto-evm/id6474381673?platform=vision
- 官方 Extension Perps 实现：https://github.com/RabbyHub/Rabby/blob/develop/src/ui/views/Perps/sdkManager.ts
- 官方代码目录：https://github.com/RabbyHub/Rabby/tree/develop/src/ui/views/Perps
- 官方扩展发布记录，当前页面 v0.94.11：https://github.com/RabbyHub/Rabby/releases
- 官方 2025 年上线公告原始地址：https://x.com/Rabby_io/status/1964360621681414356

证据限制：原始 X 公告本次返回 403，不能声称亲读正文；其内容线索称 Mobile 和 Extension 上线，但本文只以可读官方发布记录/代码确认。代码使用 develop 分支，不能逐项承诺它的最新细节都已经进入所有商店版本。Rabby Desktop 是另一独立产品，不能将 Extension 的支持自动套用。未完成充值链币/路由商核验，原方案不应假定 Rabby 缺少一键桥接，也不应断言其支持 Tron。

## 5. Base App / Coinbase Wallet

确定事实：截至本次访问，base.app 跳转 wallet.coinbase.com；官方 Google Play 开发者说明（更新 2026-10-09）明确“Trade Perps, Powered by Hyperliquid”且在 App 内完成，更新说明为“We’re now Coinbase Wallet”。2026-09-08 钱包条款单列原生 Perps 接口：可在应用中查看市场、开仓、管理、平仓，协议包括 HL；用户把 EOA/Smart Wallet 资产转到协议账户/余额并授权操作。

- 品牌入口（当前重定向）：https://base.app/
- 当前产品页：https://wallet.coinbase.com/
- 开发者 Google Play 产品说明：https://play.google.com/store/apps/details?hl=en&id=org.toshi
- 官方条款 Native Perpetual Futures Interface 段：https://wallet.coinbase.com/terms-of-service

限制：条款列明美国、英国、加拿大和部分地区不可用。移动上线证据充分；网页产品有交易入口，但尚未逐项验证网页 Perps 可用性。品牌支持多个链的普通现货交易，不意味着每条链都能原生充值 HL。条款通用 DEX 段提到 LI.FI、0x、1inch，不能将这些公司直接认定为 Perps 入金路由商。未核实具体充值按钮、可用源币/链和桥接步骤，不能写成确定的 Base USDC→HL 充值指南。Coinbase 交易所的中心化永续合约是另一产品，不能合并统计。

## 对开发方案的意义（研究推论）

1. “钱包用户都要自己先桥 Arbitrum 再进 HL”已不是正确概括：MetaMask 和 Phantom 已把兑换/桥接包入原生入金或订单流程。
2. 用户仍可能有“钱包源链资产 → 路由商在途 → HL 已到账 → 可交易保证金”几个真实状态，只是应用隐藏了手工步骤；故障恢复与可查账依然是产品价值。
3. 本组未有可引用的一手文件明确支持 Tron USDT 原生到 HL。可以把该路径列为待实测的差异化假设，不能把“搜索未找到”写成全市场空白结论。
4. 竞争对照要区分“钱包已有 HL 原生交易界面”“支持从哪些源资产入金”“Tron USDT 是否实际报价并成功到账”；这三项必须分别验证。
