# 协议实现结果

负责人 protocol_architecture，2026-10-12。

## 已实现

- 唯一启用路线 `tron-usdt-hypercore`：Tron 主网 USDT → 指定用户默认 HyperCore Perps USDC，Relay quote/v2 + v2 协议订单，非 HyperEVM token payout。
- 真实上游配置和报价，每次本地重算 orderId、验证固定 solver EIP-191 签名、绑定 source/recipient/链/币/金额/最低额/期限、独立 depository 注册信息、精确 USDT allowance、depositErc20 calldata，拒绝未知调用/签名步骤。
- 运行时固定官方 URL、15秒timeout、4MB流式响应上限、JSON/schema校验；可选 Relay/TronGrid API key，HTTP鉴权/限流/网络失败不假成功。
- Tron Base58Check；SolidityNode固化交易/收据与txid哈希，唯一TriggerSmartContract，逐字段匹配已审核付款意图，确认USDT精确Transfer到受信depository。
- Relay状态必须匹配本单source tx；完成必须匹配HL ledger的同fill hash、正USDC金额、recipient及默认Perps，不靠余额delta，不把Relay success直接写completed。
- 保守credit解析支持真实验证的`send`（destinationDex为空）和旧`internalTransfer`。未识别的事件留在verifying_credit，保留证据。
- 完整settlement SDK只用于开发差分测试；生产采用独立受限字段编码与顶层viem.hashStruct，协议来源记录在 server/providers/ORDER-HASH-SOURCES.md。

## 真实只读验证

1. 100 USDT 首次quote HTTP200，完整protocol order可重算验证：预估99.734623，最小97.739931（默认2%滑点快照，不是上线定价）。原始证据 work/relay-tron-quote-response.json。
2. 生产getQuote使用官方明确的100bps=1%滑点，2026-10-12T19:12:16Z真实新报价：requestId `0x17918323350b98ca3d3df688e2f4b5ccc2dbc445bfdec354d25dd348691fd764`，expected99.735929，min98.73857。本地hash/签名/calldata全部通过；真实getAccount公开研究地址返回9.56USDC，不是模拟值。
3. 历史Tron→HL请求 `0x179181616308425f6b18b868a70d582a09de8f4890bf2afe641e613a9e587d27`：Tron固化付款hash `dd922bb0f3bc991e9f8e6ed97ef28f4b5ebc144d431bfc5d13021ddb47acb233`；HL credit hash `0x91c2d9c61c4b92d4933c04466794af02129100abb74eb1a6358b8518db4f6cbf`；recipient `0x1d26f48ac0c949d739461bffebb5bfd0148676cf`；506.546688USDC。Relay status/v3、HL userNonFundingLedgerUpdates及Tron SolidityNode receipt互相一致。历史源采用带orderId后缀的token transfer，不能冒充本应用depositErc20资金测试。
4. TronGrid未带密钥可读上述固化交易；ret.contractRet与receipt.result均SUCCESS，USDT日志精确匹配付款人、depository、508USDT。

## 测试

`node node_modules/vitest/vitest.mjs run tests/protocol.test.ts --configLoader native`：13/13通过，约0.5秒。含SDK差分、恶意改收款人/最小额/solver签名/目标合约/授权/额外calldata、Tron checksum和精度、源链固化失败与遗漏Transfer、Spot/旧交易/错误hash/金额不足不误报到账。

`npm run typecheck`：协议文件无报错；在本次执行时前端仍有在修复的类型错误，整仓状态以root最终验证为准。

默认Vitest配置打包本机卡在esbuild；native配置加载可立即运行，无测试断言失败。root负责确定全项目/部署Node版本兼容方式。

## 未完成的验收及限制

- 未创建、签署或广播任何资金交易；用户尚需小额钱包验收。已通过真实报价和历史只读核对，不等于本产品真实端到端资金验收通过。
- Relay文档称2026-10-02后quote/v2必须API key，本次无key仍200；生产必须准备可用key并监控鉴权失败。requests/v3实际要求key，运行时跟踪使用可用的status/v3，不依赖历史requests/v2。
- 单笔10–10,000 USDT；不提供EVM/多链、提款、交易授权、builder授权、主动退款或私钥服务。若provider升级order格式/solver/depository，安全校验会拒绝，需重新审核配置。
- 可退回的实际资产/位置由协议决定，报价可能包含源链和HyperCore退款目的地；没有“失败立即原路退款”承诺。
- 当前HyperCore credit查询收窄到fill更新时间前5分钟至后1分钟；极高频账户超过API返回上限、未支持的credit类型会保持核验，不伪造成功。该类需进一步分页/运营证据处理。
- account.perpsUsdc 来源为default clearinghouse marginSummary.accountValue，代表账户价值（可含持仓未实现PnL），withdrawableUsdc单独提供可提金额。前端应标为账户价值，不应把它当作某一笔充值证据。

## 官方来源

- https://docs.relay.link/references/api/api_guides/hyperliquid-support
- https://docs.relay.link/references/api/api_core_concepts/input-validation
- https://docs.relay.link/references/api/get-quote-v2
- https://docs.relay.link/references/api/get-intents-status-v3
- https://api.relay.link/chains
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
- https://developers.tron.network/docs/api-signature-and-broadcast-flow

所有实现和证据以2026-10-12访问/调用状态为准；tests fixture仅供测试，运行时无模拟回退。
