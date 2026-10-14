# 技术架构研究笔记：Tron USDT → Hyperliquid 入金通道

研究日期／官方文档访问日期：2026-10-12。供主代理汇总，不是上线设计定稿。仅研究了给定 PDF 和公开官方资料，未取得现有代码、后台交易数据、供应商账户、真实报价或完成链上交易验证。下文把协议文档事实、设计建议、待实测项分开。

## 一、会改变方案的已验证事实

### 1. 不能再写“HL 只收 Arbitrum USDC”

Hyperliquid 官方开发文档的旧 `bridge2` 页面目前重定向到 USDC 文档。它明确把 CCTP 列为首选，将旧 Arbitrum bridge 标记为 deprecated。旧桥的 5 USDC 最低额及存款按发送地址入账属于旧桥语义，不应机械套在新 CCTP 路线上。CCTP 的官方支持域包含 HyperEVM（domain 19），未包含 Tron。[S1][S2]

Circle 官方给出 HyperCore 的完整 CCTP 工作流：先在 HyperEVM 铸造原生 USDC，再通过 `CoreDepositWallet` 记入 HyperCore；HyperCore 余额是协议层信用记录，底层原生 USDC 留在 HyperEVM 合约。因此“到 HyperEVM 钱包”“已铸造 USDC”“已成为 HyperCore 可用余额”是三个不同完成状态。[S3]

**设计结论：新开发以 CCTP/官方 CoreDepositWallet 为 HL 适配目标；旧桥只保留兼容研究，不作为新主线。** Tron USDT 仍须先通过兑换／流动性服务得到 CCTP 支持链上的原生 USDC，或直接拿到 HyperEVM 原生 USDC。CCTP 本身不把 Tron USDT 兑换成 USDC。Circle 已于 2024 年宣布停止在 Tron 铸造 USDC。[S2][S13]

### 2. 可以给指定用户入金，但不能简单转币到合约

Circle 官方 `CoreDepositWallet` 接口提供 `depositFor(address recipient,uint256 amount,uint32 destinationId)`：从调用者扣款、记给指定 HyperCore 用户；`0` 是默认 Perps DEX，`4294967295` 是 spot。普通 `deposit` 则给调用者同地址记账。未支持的目标 DEX 可能落入 spot。直接向 CoreDepositWallet 地址执行 USDC `transfer` 不会触发 HyperCore 入金，官方警告资金会卡住。[S4]

官方 Arbitrum → HyperCore CCTP 指南要求 `mintRecipient` 和 `destinationCaller` 均为部署在 HyperEVM 的 `CctpForwarder`；最终用户地址及目标 DEX 放在 hook 中。两个字段错误可能导致不可恢复的卡款。`destinationDomain = 19` 是 CCTP 域，不能把 EVM chainId 填进去。[S5]

当前 Circle 地址表列出 HyperEVM 主网 CoreDepositWallet `0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24`、CctpForwarder `0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757`。它们用于研究配置；上线前必须重新确认网络、代理实现、ABI、暂停状态及合约地址来源，不能从 PDF 或第三方博客复制地址直接用。[S6]

**设计结论：**收款人写入不可变订单，前端向用户展示 HL 的 `0x...` 地址，服务端校验与签名绑定；Tron 的 `T...` 发送地址不能自动视为用户的 HL 身份。平台可代付 gas／执行 depositFor，但不应持有用户 HL 主私钥。提供商只支持“Tron”和“HyperEVM”两个链，不足以证明它能完成 Tron → 指定用户 HL Perps 的整条路线。

### 3. 新账户费用存在官方材料不一致，必须实测

Hyperliquid 的 activation-gas-fee 文档称新账户首次作为目标接收交易时需要 1 个 quote token；Circle 的 HyperCore 概念文档则称首次存入全额可交易、1 USDC 激活费在首次出金／转出时扣除。Circle GitHub `master` 的 CoreDepositWallet 源码还包含可配置新账户费和 DEX forwarding 开关，其源代码状态不自动等于当前生产代理实现。[S3][S7][S8]

**阻断项：**选择并固定实际合约版本，分别验证新账户、老账户、standard/unified 模式、小额与首次出金；记录净入账、净可转出、激活费扣除时点。上线报价应展示实际净到达额与相关费用，最低金额采取可配置业务阈值，不能把“5 USDC”或“全程免入金费”写死。官方 testnet 文档还提示：接收地址须已在主网有状态、测试 USDC 上限 1,000，未在主网存在的地址可能静默失败；这会影响测试设计。[S3]

### 4. 出金不是代交易授权就能做

Circle 给出的出金入口为用户 EIP-712 签名的 `sendToEvmWithData`，可从 spot／perp 余额经 HyperEVM CCTP 到外部支持链，并指定收款地址。费用与自动转发行为取决于链和配置，文档中的 Arbitrum 0.2 USDC 是初始转发费，不应当作长期固定总费率。[S9]

HL 当前 API 另有 agentSendAsset，但它要求目的地址匹配来源地址；不能把 API wallet 理解为通用出金权限。代理 nonce 按 signer 维护，API wallet 注销后不要复用原地址，否则 nonce 状态清理可能使历史签名产生重放风险。[S10][S11]

**设计结论：**首期只做入金。回程单独立项，采用用户本人签名的出金意图，先验证可提金额、目标域、地址和扣费，再组合 USDC → Tron USDT；不得先按账户总资产向用户垫付，也不得为了自动回程要求用户导入私钥。

### 5. Builder fee 是独立授权及结算产品

Builder code 需要主钱包批准最大费率，可撤销；perps 上限 0.1%，spot 上限 1%，参数 `f` 单位为 0.1 bps。Builder 账户至少 100 USDC Perps 价值且使用 standard 账户模式；每用户最多 10 个活动 builder approvals。[S12]

**设计结论：**入金服务不要求 builder 授权。PDF 的合作方 70%／我方 30% 是商业结算规则，不能当成协议原生自动分账。PerpDock 另建成交归因、fee 查询、账单、分润台账和撤销授权处理；“导流入金”也不等于会产生 builder 收入。

### 6. Tron 确认与资金识别不能靠广播成功

TRON 官方建议以 SolidityNode 的固化状态查询确认；TRC-20 还要检查固化执行结果与受信代币合约发出的 Transfer 事件。广播返回成功不代表最终执行成功。当前协议约 19 个不同活动 SR 覆盖区块时固化，不能简单把固定秒数当作确认。[S14][S15]

Tether 官方列出的 Tron USD₮ 合约为 `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`；实际集成仍需在资产注册表校验链、合约、decimals，并限定允许资产，不接受名称为 USDT 的任意代币。[S16]

## 二、推荐 MVP 架构（设计建议）

目标范围：合作方 API/SDK + Tron 主网 USDT 入金 + 用户自控 HL 地址 + 默认 USDC Perps／明确支持的账户模式。成功口径是指定用户 HyperCore 的目标余额已记入，而非供应商返回 success。

```text
合作方 App / SDK
  → Quote + Order API（租户鉴权、地址绑定、费率及净额）
  → Route Orchestrator（持久化状态机、幂等、恢复）
  → Provider Adapter（复用现有兑换/跨链能力，首批一个主提供商）
  → HL Adapter（CCTP Forwarder / CoreDepositWallet）

共同服务：Tron/EVM/Core 索引器 + 资金台账 + KYT 决策接入
          + 对账与告警 + 运营工单 + 签名隔离与限额策略
```

### 路由选择顺序

1. **优先集成可验证的端到端提供商能力。**通过 adapter 取得指定用户 HL 地址及净入账额的真实可执行报价；逐一确认它是否执行官方合约调用，是否已代付目标 gas，谁承担过期、失败、退款以及资产托管责任。必须有真实执行证据才可称一步完成；当前研究没有验证供应商报价。
2. **复用现有 Tron USDT → Arbitrum 原生 USDC 路由，再组合官方 CCTP → HyperCore。**如果已有业务会控制中间流动性账户，由既有隔离 signer 付 gas 和调用 CCTP，在 hook 内绑定用户地址、DEX=0；不新建面向用户资金的新合约。若 USDC 中途先落到用户 Arbitrum 钱包，则需要用户签名和 gas 方案，不能暗称一笔交易完成；可评估 Circle 已有 Arbitrum sponsored flow。[S3][S5]
3. **提供商能直接交付 HyperEVM 原生 USDC 时，评估 depositFor。**要验证其可在目标链执行 approve + depositFor 或调用既有支持该行为的路由，不要把普通 token payout 当作支持。若需要我们新托管用户资产／新合约执行而现有能力不存在，重新估期，不默认包含在 2–4 周里。

“无自建流动性”与“自有预付库存”是不同经营模型。首期优先前者。若采用后者，必须另建库存、额度、调拨、对手方敞口和资金费用测算，不能用同一上线计划掩盖。

### 最小 API 合同

- `POST /quotes`：partnerId、sourceChain、sourceAsset、amount、sourceAddress、hlRecipient、destinationDex；返回 quoteId、expiresAt、minNetReceived、逐项费用、预计区间、要求的签名／交易、routeVersion。
- `POST /orders`：Idempotency-Key + quoteId + recipient intent；同 key 同参数返回同订单，同 key 不同参数返回冲突。签名绑定 partnerId、orderId、链、资产、金额上限、收款人、目标 DEX、过期时间、nonce、refund policy。
- `GET /orders/{id}`：业务状态、每段交易标识、净入账额、是否需要用户操作、可公开的错误及处理状态。
- 签名 webhook：eventId/orderId/version/timestamp；至少一次投递、调用方幂等、允许乱序补拉。不把 webhook 作为资金事实来源。

### 资金与身份边界

- 用户使用 Tron 钱包授权付款，并明确确认其可控制的 EVM/HL 收款地址；钱包连接／必要的地址证明与付款订单绑定。只读取用户地址，不要求导入助记词或私钥。
- HL 入金 adapter 不持有用户主钱包或交易 API wallet；入金功能不注册交易代理、不自动 approve builder fee。
- 如既有业务 signer 持有中间资金，它只接受订单白名单参数；按链和用途隔离、热账户限额、硬件/多方签名服务、冷库隔离及审批策略。业务 API 不直接接触私钥。
- 目的合约、方法 selector、token、chainId/domain、允许收款人、最大 amount 全部在 signer 前二次校验；对报价 calldata 解码核验，不能无条件转发供应商任意 calldata。
- UI 将“路由服务费、兑换价差、链上费、CCTP/转发费、可能的账户激活费”分开；固定净额保证由谁承担必须明确。

## 三、失败恢复、幂等和对账（设计建议）

推荐状态链：`QUOTED → CREATED → SOURCE_DETECTED → SOURCE_FINALIZED → CONVERSION_PENDING → DESTINATION_PENDING → CORE_CREDIT_PENDING → COMPLETED`。附属分支：`EXPIRED_UNFUNDED`、`MANUAL_REVIEW`、`REFUND_PENDING → REFUNDED`。另存每条链、每段执行、每次尝试状态，不能用一个 failure 布尔值概括整个流程。

| 场景 | 系统处理／必须证据 |
|---|---|
| 报价过期且未付款 | 关闭报价；不执行兑换 |
| 用户晚到款／少付／多付 | 进入可解释分支；按用户已接受的阈值处理或让用户确认重报价；超额不能静默算收入 |
| Tron 仅广播或未固化 | 显示确认中，不释放目标资金；保存原 txid |
| 超时但交易结果未知 | 查询原 txid/provider order/message nonce；标记 pending，不用新交易重复付款 |
| CCTP burn 已发生、attestation 未到 | 保存 source domain、txhash、message、nonce；继续取得证明，不再次 burn |
| 目的执行 revert | 确认是否已经 mint/被消费；依协议受支持的恢复路径重试，不承诺所有错误可退回 |
| USDC 已在 HyperEVM、Core 未入账 | 区分 mint 与 deposit；按唯一订单和原调用查日志及 Core 账本，核验余额位置，运营处理；不能重复执行 depositFor |
| 入入 spot 而非 perps | 非成功终态；显示资金位置，只有用户授权／协议支持时转移；不替用户开启交易权限 |
| 提供商／KYT 服务不可用 | 未收款前停止报价；已收款订单保持可追踪并按既定合同处理，不凭空退款 |
| 用户错链／错币 | 进入工单；资产不受支持不能自动兑换或承诺可恢复 |

核心唯一约束：partner+idempotencyKey、chain+txHash+logIndex、provider+providerOrderId、CCTP sourceDomain+messageNonce、order+leg+executionId。数据库状态转移用 compare-and-set/事务与 outbox；广播前持久化签名请求与 tx 身份，重试先核查同一执行。

对账三层：①订单意图；②内部逐资产台账（用户应付/待退款、provider 结算、费用、在途）；③外部可验证记录（Tron 转入、兑换成交、CCTP burn/mint、HyperEVM deposit、HyperCore credit）。余额变化会混入用户交易 PnL，不能单靠余额 delta 判定订单到账。精度全部采用整数最小单位，禁止浮点。任何差额、长期在途、重复事件、负库存都进入告警并支持按 route/partner/asset 熔断。

退款是资金动作：必须确认原订单尚未成功结算、无未知在途付款，并绑定可核验原来源／预先确认退款地址。源链成功而跨链未完成时不能宣告“失败即自动退款”，否则可能同时完成跨链与退款。

## 四、首周技术验证与退出条件（设计建议）

1. 固定官方合约/版本与 route matrix；读取生产配置、暂停标志、支持 DEX 和 fees。用已存在测试账户验证 CCTP → Core，记录完整 source/attestation/mint/Core credit 证据；测试网约束单独记录。
2. 用真实金额梯度获取提供商路线报价（可先 read-only）：100/1,000/10,000 USDT，目标分别 HyperEVM token 与 HyperCore perps；核验 total fee、净额、失败责任、支持用户地址与退款策略。未有可执行报价即不通过立项闸门。
3. 新老账户、standard/unified 模式、地址绑定、CCTP hook、activation fee、临界金额、故意超时和重复通知进入测试矩阵。费用矛盾用实际部署与结果解决，而不是挑一个文档值。
4. 复核现有能力：Tron 固化索引、官方 USDT 资产注册、完整账本、KYT、钱包签名基础设施、provider 重试/退款、运营 on-call。如果缺核心项，不能把这项目当“多一个 destination 参数”。
5. 先实现 dry-run/沙箱和 operator 控制台，再经既定资金审批流程做受限主网验证；本研究没有执行真实资金操作。通过条件包括：指定地址实际 credit、全部账目闭合、重复请求不重复支付、失败可定位与恢复、费用能够覆盖成本、停止新单仍能处理存量在途单。

**首期排除：**自动回程、PerpDock 下单／持仓／强平客服、builder fee 分润、任意链任意资产、智能合约钱包/子账户/vault 全兼容、自建跨链桥、新用户资金托管合约、自动补仓或策略、无抵押垫付、AI 自动资金处置。标准入金如果业务必须接 unified，也先用显式兼容矩阵验证；不能暗示 HL 当前全部账户模式已支持。

## 五、需要主代理带入最终开发方案的判断

- 原文“2–4 周”只有在已有成熟兑换路由、资金台账、KYT、签名和运营能力，并通过第一周 end-to-end 验证时，才可能是有限 beta 的估期；协议变更说明不能直接接受零新增成本。
- 技术路线应分两个 gate：其一“provider 能否把正确净额放进指定用户 HyperCore”，其二“失败、退款、对账和暂停能力是否完整”。光有链支持与报价接口都不等于通过。
- 入金主线与 PerpDock 应分别排期、密钥权限与商业账本；把交易产品强绑入金会扩大研发和运营边界。
- 推荐主方案以 provider adapter + 官方已部署合约完成，无额外用户资金合约；第一周用 evidence pack 决定选择经 Arbitrum CCTP 或 HyperEVM depositFor 的实际路线。

## 官方来源（均于 2026-10-12 访问）

S1. Hyperliquid USDC/legacy bridge：https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/usdc （旧入口：https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/bridge2）

S2. Circle CCTP 支持域：https://developers.circle.com/cctp/concepts/supported-chains-and-domains

S3. Circle CCTP-enabled HyperCore transfers：https://developers.circle.com/cctp/concepts/cctp-on-hypercore

S4. Circle CoreDepositWallet 接口：https://developers.circle.com/cctp/references/coredepositwallet-contract-interface

S5. Circle Arbitrum → HyperCore：https://developers.circle.com/cctp/howtos/transfer-usdc-from-arbitrum-to-hypercore

S6. Circle HyperCore 合约地址：https://developers.circle.com/cctp/references/hypercore-contract-addresses

S7. HL 账户激活费：https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/activation-gas-fee

S8. Circle 官方 CoreDepositWallet 源码（可变 master 分支，不是生产实现已验证证明）：https://github.com/circlefin/hyperevm-circle-contracts/blob/master/src/CoreDepositWallet.sol

S9. Circle HyperCore → EVM 出金：https://developers.circle.com/cctp/howtos/withdraw-usdc-from-hypercore-to-evm

S10. HL exchange API：https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint

S11. HL nonce/API wallets：https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets

S12. HL builder codes：https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes

S13. Circle 停止 Tron USDC 支持：https://www.circle.com/blog/circle-is-discontinuing-support-for-usdc-on-the-tron-blockchain

S14. Tron 共识及固化：https://developers.tron.network/docs/concensus

S15. Tron 签名、广播、固化执行验证：https://developers.tron.network/docs/api-signature-and-broadcast-flow

S16. Tether 官方支持协议和 USDT 合约：https://tether.to/en/supported-protocols/

S17. Circle HyperEVM → HyperCore 教程：https://developers.circle.com/cctp/howtos/transfer-usdc-from-hyperevm-to-hypercore

S18. HL info API（userRole 等）：https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
