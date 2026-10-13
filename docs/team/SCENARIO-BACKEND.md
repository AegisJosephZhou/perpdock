# 多链稳定币覆盖：后端建议

2026-10-12；本阶段只研究，未改动正在交叉审查的 Ethereum 代码。

## 先给 root 的实质结论

建议共享审核 registry 驱动现有验证器，优先扩大 6 位精度的稳定币；不能把 EVM 判断改成接受任意 chainId。Ethereum USDT/原生USDC、Arbitrum USDT0/原生USDC、Base原生USDC、Optimism原生USDC、Polygon原生USDC/USDT0 可作为下一批候选，只有逐token真实显式v2报价、RPC元信息及finalized检查都通过才开放。Tron保留。

**USDT 品牌/合约存在重要差异：** 官方 [USDT0部署表](https://docs.usdt0.to/technical-documentation/deployments) 列出 Arbitrum `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` 与 Polygon `0xc2132D05D31c914a87C6611C10748AEb04B58e8F`，它们与 Relay /chains 的USDT地址相同，但应标注USDT0语义。**Optimism官方USDT0为 `0x01bFF41798a0BcF287b996046Ca68b395DbC1071`，与Relay /chains旧USDT `0x94b008aa00579c1307b0ef2c499ad98a8ce58e58`不同**。不要把两者合并到同一路线或只靠symbol选币；root可额外对新USDT0地址做真实quote探测，旧USDT需明确名称/来源后单独审核。Polygon官方[升级公告](https://blog.usdt0.to/polygon-usdt-now-upgraded-to-usdt0-1-3b-in-usdt-liquidity-available-natively-omnichain)说明保留原地址并改用USDT0。

BNB Chain `0x55d398326f99059ff775485246999027b3197955` 的 Relay 元信息是18位。**当前relay.ts和wallets.ts存在6位硬编码，不能只加路由就开放BSC**。`parseUnits('100',6)`用于18位token会差10^12倍；现有Quote/order-service比较通常会拒绝，但不能靠下游拒绝代替正确换算。首轮若来不及对18位端到端回归，BSC直接不开放；若开放必须明确 Binance-Peg 资产名称，链上decimals实测和金额通路全改为registry.decimals，禁止把它写成Tether在BSC直接发行的同一种资产。

## 已核实候选来源与代币

Relay事实来自root 2026-10-12公开 `work/ethereum-qa/chains.json`。以下EVM链均给出相同v2 depository `0x4cd00e387622c35bddb9b4c962c136462338bc31`，但相同地址不代表同一链、同一种资产；仍逐链pin。Circle的[USDC合约地址表](https://developers.circle.com/stablecoins/usdc-contract-addresses)证实下列原生USDC地址，不能替换为USDC.e/桥接USDC。

| 网络 | chainId / Relay协议ID | 候选资产合约与元信息 | 候选RPC（来自Relay元信息，需root实测） |
| --- | --- | --- | --- |
| Ethereum | 1 / ethereum | USDT `0xdac17f958d2ee523a2206206994597c13d831ec7` / 6；USDC `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` / 6 | https://ethereum.publicnode.com |
| Arbitrum One | 42161 / arbitrum | USDT0 `0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9` / 6；USDC `0xaf88d065e77c8cc2239327c5edb3a432268e5831` / 6 | https://arbitrum-one.publicnode.com |
| Base | 8453 / base | USDC `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` / 6 | https://base.drpc.org |
| Optimism | 10 / optimism | USDC `0x0b2c639c533813f4aa9d7837caf62653d097ff85` / 6；旧USDT `0x94b008aa00579c1307b0ef2c499ad98a8ce58e58` / 6，与新USDT0分开 | https://optimism.publicnode.com |
| Polygon PoS | 137 / polygon | USDT0 `0xc2132d05d31c914a87c6611c10748aeb04b58e8f` / 6；USDC `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359` / 6 | https://polygon-bor-rpc.publicnode.com |
| BNB Chain | 56 / bnb | Binance-Peg USDT候选 `0x55d398326f99059ff775485246999027b3197955` / **18** | https://bsc-rpc.publicnode.com |

这只是候选registry资料，不是上述路线已验收或已开启的声明。USDC/USDT名义都是稳定币，仍不得固定expectedReceive=amount；只呈现签名订单的真实输出/minReceive。

## 共享registry建议

新增 `shared/route-registry.ts`（root owner）作为前后端不可变审核白名单，分网络元数据与route元数据：

- 网络：sourceChainId、sourceChain、protocolChain、walletType、depository、nativeGasSymbol、explorerTxBase、finalityPolicy=`evm-finalized`/`tron-solidity`、提示文案。
- 路线：稳定routeId、chainId、tokenAddress、decimals、symbol、displayName、assetVariant、approvalPolicy（USDT类可采用zero-reset-if-needed）、enabled。不同token与不同chain绝不共用同routeId。
- 仅服务端另存 RPC env键、默认HTTPS URL、探测状态、更新时间；含凭据RPC URL不能放shared/public config。
- 严格保留 `ethereum-usdt-hypercore` 与 `tron-usdt-hypercore` 的已发布语义。停用旧路线只关闭新报价，不阻止持有旧订单继续查询与恢复。历史订单的链/合约/金额不能随着新registry变更而被重新解释；后续变更同token地址应创建新id或保留version。
- 前端不能仅信任服务器Route的任意token/chain/to；钱包验证器应引用同一编译进客户端的审核白名单，再绑定Quote，而不是扩展成任意服务器下发调用执行器。

## 最小后端修改面

1. 保留现在的 protocol.v2 hash/signature、固定solver、refund/目标Perps、depositErc20和精确approval路径；输入单位改 `parseUnits(amount, route.decimals)`，上下限改同decimals，展示 `formatUnits(units, route.decimals)`，currencyIn.decimals必须匹配。钱包金额验证同步。禁止浮点、Number金额或先按6位再乘10^12等隐性规则。
2. EVMIntent.chainId从literal1改为正整数，但**必须与独立registry的该route.sourceChainId严格相等**。付款to/token/value/payer/amount/orderId仍全部绑定。同地址不允许跨链沿用，chainId错误必须拒绝。
3. 将ethereum.ts核验主体提取为 `verifyEvmSource(quote,hash,reviewedRoute)`，RPC/chainId/token/depository/日志symbol均取已审核route；旧 `verifyEthereumSource` 可保留wrapper以稳定已有测试/调用。Source registry来自routeId，不接受浏览器参数传入RPC或合约。Tron验证独立保留。
4. finalized查询形式可复用，语义与默认时长逐链文档确认。不得把latest/safe或简单N块降级当finalized；若供应商不支持或返回异常，就不开新路线并让已有订单继续安全重试。
5. `getRoutes`可按网络缓存只读链健康（chainId、finalized存在且number/hash可用），按token缓存元信息（code非空、decimals一致）；每路线独立隔离。不会每次quote顺序请求全部网络。缓存过期或探测失败只关闭相关网络的新报价；旧订单仍使用其来源RPC恢复。
6. 目标链账本证据、分页扫描、订单idempotency、链+tx唯一性保留。evidence建议统一 `evm_finalized_transfer` 并额外chain明确，或沿链名生成；根现有Ethereum evidence不可静默重写历史订单。把“等待Ethereum”硬编码文案改route.sourceChain；EVM都不采用Relay瞬时时间作为最终完成时长。

## 必要回归与放行门槛

- 每个候选token至少真实10与100报价，保留含真实solver签名的fixture；验证独立orderId、min/expected、approve/deposit形态、requestId、origin protocol chain、退款地址。使用公开测试地址，只报价不签名。
- 每条EVM网络 live只读：eth_chainId、eth_getBlockByNumber(finalized,false)、对应canonical block/hash、token eth_getCode 与 eth_call decimals；token身份以issuer/规范桥官方地址为准，链上symbol仅展示不能作为身份。
- 参数化来源验证覆盖每个chain/token/decimals；交换链A报价/链B receipt、同symbol另一合约、另一个链同depository、错误finalized语义/不支持/空结果都必须失败关闭。
- 金额边界用实际字符串 `10`、`10.000001`、`9999.999999`；若18位开放，加 `10.000000000000000001`、超精度拒绝、2^53以上baseunits精确比较；确认精确approve与deposit、Transfer金额三者相等。
- 原Ethereum62与Tron17协议测试保持；新增真实USDC报价应覆盖可能没有approve step，仍给钱包精确approval元数据重查当前allowance；不为USDC启用permit/Permit2新签名路径。
- 至少一条新链经过临时数据库quote→unsigned order→recovery全链路，绝不写现有8787数据；不同网络/API失败只影响该route；新配置发布后仍能读旧Tron/Ethereum订单。

当前建议范围不引入原生ETH/SOL兑换、转账到固定收款地址、交易所直提、任意自定义token、Permit2/AA批处理或服务器代签。用户覆盖率通过真实主流稳定币链+清楚恢复处理提高，不能用未验证路线占位。

## 逐链finalized语义的一手依据

访问日期2026-10-12；以下说明允许复用finalized查询+canonical回执核验的结构，但不取代root对实际RPC行为的实测。所有时间只用于帮助说明，不作为倒计时或保证到账时长。

| 网络 | 官方依据与实现含义 |
| --- | --- |
| Arbitrum One | [Arbitrum troubleshooting](https://docs.arbitrum.io/build-decentralized-apps/troubleshooting-building) 明确支持 `eth_getBlockByNumber` 的 latest/safe/finalized；finalized是含该批次的Ethereum已finalized。以RPC返回的**Arbitrum** blockNumber比较receipt，不能混用合约内block.number的L1高度。别用固定L2块数代替finality。 |
| OP Mainnet | [Transaction finality](https://docs.optimism.io/op-stack/transactions/transaction-finality) 将finalized映射到批次所在Ethereum块最终确认；[主网时长](https://docs.optimism.io/op-mainnet/network-information/transaction-finality)通常15–30分钟。标准桥取回L1等待期与本场景源链付款确认不同，不能提示用户需要7天才知道HL是否充值成功。 |
| Base | [Transaction Finality](https://docs.base.org/specifications/transactions/transaction-finality) 区分200ms预确认、2秒L2包含、约2分钟L1批次包含和约20分钟L1批次finality；使用最后阶段。本次查到的最新版Base退出证明窗口已不同于旧“7天”说法，但我们的Relay→HL路径不实现Base官方L1退出流程，不引用退出窗口作为产品时长。 |
| Polygon PoS | [Finality](https://docs.polygon.technology/pos/concepts/finality/finality) 描述Heimdall milestone确定性最终性，独立于向Ethereum提交checkpoint的等待；使用该网络finalized语义，不声称继承Ethereum L1同样确认。原生Gas币应为POL。 |
| BNB Chain | [BSC API list](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/bsc-api-list/) 明确提供eth_getBlockByNumber(finalized)，对应经济最终性；另有包含概率最终性fallback的eth_getFinalizedBlock。首版只使用已核实的finalized标签，不静默改用latest-N或另一较弱保证。文档中的旧出块时间不可直接当当前SLA。 |

Tether [Supported Protocols](https://tether.to/en/supported-protocols/)目前BNB条目列出的是XAU₮合约，没有列出本候选USDT合约；因此不能因为支持列表出现BNB就声称候选USDT是Tether直接发行。BNB链官方[benchmark参考](https://docs.bnbchain.org/bnb-smart-chain/benchmark/design-reference/)指向本候选BEP20合约，精确18位仍需root RPC复核；资产背书/名称按Binance-Peg原有发行说明核实。

## 按root确认的9路线实施完成（当前版本）

已采用 root 的 shared/route-registry.ts：8 EVM路线（Ethereum USDT/USDC、Arbitrum USDT0/USDC、Base USDC、Optimism USDC、Polygon USDC、BNB Chain Binance-Peg USDT）+原Tron，共9条。上面的候选研究不是实际开放列表；OP旧USDT、Base桥接USDT、PolygonUSDT0仍未开放。

- `relay.ts` 引用共享审核表：chainId/token/depository/decimals/付款币种及展示均严格按该routeId；fixed solver、独立order hash/signature、单输入、默认Perps输出、refund、无任意calls、requestId与exact approve/deposit不放松。18位input/limits/display全程parseUnits/formatUnits(route.decimals)+BigInt。
- 新 `server/chain/evm.ts` 为每条EVM路线核验tx/receipt/Transfer/canonical/finalized，chainId与日志token取审核表。新 `evm-rpc.ts` 独立管理server-only RPC环境键和健康gate。`ethereum.ts` 保留原常量、RPC wrapper和verifyEthereumSource接口；两条chain1路线走wrapper，其余EVM走通用验证器；原Tron验证接口不变。
- 新报价前执行真实RPC gate：chainId严格一致、finalized含number/hash/transactions、depository有code、指定token有code且decimals恰好一致。network层缓存60秒、token层缓存60秒，失败缓存15秒，同网络并发合并；URL/chain/contract/decimals作为缓存键，运营RPC更换不会复用旧验证。没有production测试开关，没有latest或固定块数降级。某一网络坏只关闭其路线，单token坏不连带同链另一token。旧订单tracking不受新报价gate阻断，继续原严格验证。
- RPC keys：ETHEREUM_RPC_URL / ARBITRUM_RPC_URL / BASE_RPC_URL / OPTIMISM_RPC_URL / POLYGON_RPC_URL / BNB_RPC_URL。默认来自共享公开registry，运营实际值只服务器读取，HTTPS/禁止URL用户名密码及fragment，不把含令牌URL暴露到API。保留15秒/4MB/禁止redirect通用HTTP边界。
- 来源完成evidence.type=`${protocolChain}_finalized_transfer`，所以原Ethereum和Tron类型完全兼容；新增base/arbitrum/optimism/polygon/bnb可识别来源。目标Perps入账强证据和持久扫描游标不变，缺HL信用记录不能完成。
- 实际Polygon USDC样本仅deposit、且上游gas是number 2500000，已允许此只读元数据是安全非负整数或整数字符串；从来不把gas/fee透传给钱包。缺approve step仍提供本单精确approval元数据，使钱包按实时allowance处理。

真实8路线fixture已复制 `tests/fixtures/multichain/`（root公开无密钥样本）。`tests/multichain-protocol.test.ts` 参数化检验真实签名/SDK一致性、6链8资产receipt与日志、chain/token/decimals互换、BSC 10^19 baseunits和10.000000000000000001精确输入、健康缓存/恢复/隔离、不支持finalized不得降级、Base源证据+HL完成绑定。测试RPC仅位于tests；不曾签名或广播。

首轮必要回归：`npx vitest run --configLoader runner tests/multichain-protocol.test.ts tests/ethereum-protocol.test.ts tests/protocol.test.ts`：**3文件117测试通过**（新增多链38，原Ethereum62，原协议17）。本组未运行全量；root统一集成验收和9路线真实生产smoke。未写现有8787数据库。

自查发现viem decodeFunctionData会忽略address槽位前12字节的非零padding，因此补入EVM deposit/approve重新编码逐字节相等检查，来源验证也复查规范编码，提前拒绝会revert的畸形调用；钱包已有同等检查。补两项真实报价padding篡改回归后：**3文件119测试通过**（多链40 + Ethereum62 + 原协议17）。此前npx tsc --noEmit通过；后续最终集成由root重跑。
