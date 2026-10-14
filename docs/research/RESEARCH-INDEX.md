# 研究资料索引与结论边界

归档：2026-10-14。这里保存此前已完成的研究，不代表今日重新浏览、安装钱包或执行资金测试。研究时间、官方来源和限制保留在各文件中。

## 钱包与入金竞争

2026-10-12 共研究 **17 个品牌样本**。“内置 HL”指钱包自身提供交易面板或专用内嵌模块，底层明确为 Hyperliquid；保存 HYPE、支持 HyperEVM、连接 DApp 或提供 Agent 插件不计。一个品牌的手机/扩展/自家终端只算一次。

| 组别 | 品牌及结论 | 原始研究 |
|---|---|---|
| 西方样本 5 家 | MetaMask、Phantom、Rainbow、Base App / Coinbase Wallet 有直接官方文档；Rabby 以官方代码及开发者发布记录交叉确认 | [wallets-western-research.md](wallets-western-research.md) |
| 亚洲样本 6 家 | TokenPocket、Bitget Wallet、SafePal、MathWallet 取得内置证据；imToken 已确认 DApp 入口，OKX 已确认 Agent 插件，不能混算原生面板 | [wallets-asian-research.md](wallets-asian-research.md) |
| 其他样本 6 家 | Trust Wallet、Ledger / Yield.xyz、OneKey、KuCoin Web3 Wallet 取得内置证据；Binance Wallet 已确认的是 Aster，Gate 是自家场所 | [wallets-other-research.md](wallets-other-research.md) |

汇总 **12 家直接官方文档确证，另 1 家 Rabby 交叉确证**。可说“本次样本共 13 家有内置证据，证据等级不同”，不能称全球只有 13 家、全都已实测、或这些钱包都已接入 Perpex。

入金体验不同：有的要求先持 Arbitrum USDC，有的集成换币/跨链，有的先入现货再换保证金。内置交易、源链/token 范围和首次 Gas 必须分别核对。

“未查到 Tron USDT → HL 的明确文字”不是没有竞争的证明。Trust 的统一 Perps 外部入金已列 Tron USDT，但 HL / Aster 具体对应待查；Bitget 的 API 链支持不等于每个消费端路线已验证。Tron 的机会仍需实际报价与用户数据检验。

10 月 14 日需求分析曾复读 [MetaMask Perps](https://metamask.io/en-GB/perps) 与 [Phantom Perps 原理](https://help.phantom.com/articles/understanding-perp-trading-in-phantom-52933464501907)：二者已将部分资金准备流程内置，“多链一键”本身不足以证明差异化。适用资产、地区、费用和版本会变化，后续决策前重新核验，不把营销页面当协议架构依据。

## 商业方案与开发研究

- [产品与交付研究](product-delivery-notes.md)：分开入金、出金和可选交易外包，含假设性团队、工期与预算方法。
- [协议与架构研究](architecture-notes.md)：方案阶段的协议选择及证据要求；实际实现以当前代码、API 与验收为准。
- [风险与安全研究](risk-security-notes.md)：资金/运营边界，不是已部署完整风控体系的证明。
- [GitHub 上传记录](GITHUB-UPLOAD-2026-10-13.md)：历史源码提交与核验，不包含本轮文档上传。
- [需求总表](../PROJECT-REQUIREMENTS.md) 的商业设想章节：原 PDF 主要假设与尚未执行的验证方法。

初期 PDF 中任意链、出金、B2B、builder 分成及预算不自动成为首版承诺。当前是从零开发的独立入金应用，未取得原稿假设的现成伙伴合同、90 天后台资金数据或收费收入。原开发方案 PDF 的本机位置见 [交接入口](../SESSION-HANDOFF.md)。

## 市场验证

10 月 14 日 X 执行与回访见 [市场状态](../market/MARKET-STATUS.md)，其 `evidence/` 已保存 28 份历史工作记录和 9 张截图。草稿、审阅、已发送和外部回应不能混计。

当前判断：有摩擦线索，值得小规模验证；市场规模、收费意愿、无补贴复用与单位经济性尚未确认。不能用 HL 整体成交量、钱包竞争热度或本方发帖数代替新入金功能的需求证据。
