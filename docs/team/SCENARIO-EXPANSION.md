# 主动补全主要入金场景

用户追加：不要等其一个一个指出场合，自己把大部分可能场景设计到并补充好。仍要求真实服务、非demo；不做真实签名和资金广播；代理间用md沟通。

## 当前先完成rc5集成，再推进同一交付的覆盖扩展

Ethereum+Tron代码已落盘并初步build通过；完整测试217pass+2仅沙盒listenEPERM，root会授权范围内重新跑HTTP回归。当前Ethereum后端/前端/钱包稳定可作为扩展基础。root准备收集真实链/token/协议可用性。

### 后端 protocol_architecture 新任务

先做只读方案与实现建议，写 docs/team/SCENARIO-BACKEND.md，不立即修改尚需安全交叉审核的Ethereum代码。研究以最小安全公共结构支持：Ethereum USDT/原生USDC，Arbitrum USDT/原生USDC，Base原生USDC，Optimism USDT/原生USDC，Polygon PoS USDT/原生USDC，BNB Chain USDT（谨慎明确Binance Peg资产名称与18decimals），保留Tron USDT。全部目的地HL默认PerpsUSDC。各链真实Relay显式v2depository、chainId/token+decimals、HTTPS RPC与finalized支持是gate；不支持即不开放。给共享审核registry、RPC/验证泛化、逐路线真实quote回归建议。root将落盘支持矩阵/registry后分配实际改动。评估现有amount 6位与BSC 18位是否会误金额，建议首版可保守排除不能快速验证的token。

### 钱包 risk_security

先完成当前Ethereum后端+App独立审查，写已约定报告。然后就场景扩展写 docs/team/SCENARIO-SECURITY.md：钱包provider选择、移动钱包内置浏览器、钱包未装/锁定/拒绝/切错链、多账户、USDT授权归零、Gas余额检查、签名/广播未知恢复、重复/多标签、Token链归属/资产伪造、误以为HL地址等于资金可用、交易所直提等。对于可复用代码建议提出；root随后分配改动。当前不要自行扩大原ownership。

### 前端 product_delivery

先完成当前文档，随后写 docs/team/SCENARIO-FRONTEND.md：以用户任务组织链+币选择与钱包、手机、交易所来源、HL已有/新账户/其他自己地址、金额/gas/报价/恢复各状态；建议主要操作界面结构、帮助入口、目前支持/不支持分界。不要只写未来规划，需要提出能在本版本真实落地的改动。root随后明确共用registry和实现ownership。

root负责真实路由验证、范围取舍、共享registry及最终审查测试。不要堆所有链或用假可用路线占位。用户没有要求充值交易所账户、自动提现或托管资金，不引入服务端私钥。移动端通过已验证注入钱包浏览器；未配置WalletConnect projectId不得假装二维码已接入。交易所直提无法签approve/deposit，必须明确先提到自己的受支持钱包，不生成平台收款地址。

## 具体实施决策（root主网只读验证后）

`shared/route-registry.ts` 已落盘（root owner）提供 `REVIEWED_EVM_SOURCES`、`reviewedEvmSource(routeId)`，每项 `{route,protocolChain,depository,publicRpcUrl,explorerUrl,finalityWarning}`。Route新增可选gasSymbol、assetNote，旧fixture兼容。选定8条EVM + 原Tron =9条：Ethereum USDT/USDC；Arbitrum USDT0/USDC；Base USDC；Optimism USDC；Polygon USDC；BNB Chain Binance-Peg USDT18位。暂不接老OP USDT/Base桥接USDT/PolygonUSDT0/Solana，显示明确支持边界。不要把USDT0和USDC.e混在USDT/USDC。全部真实10单位报价与RPCchainId/decimals/depositoryCode/finalized已通过：`work/scenario-qa/results.json` 和各 `${chain}-${asset}-quote.json`，公开地址无签名。真实fixture可复制进tests。

### 后端开始实施

protocol_architecture拥有原server/providers/relay.ts、server/chain/ethereum.ts以及需要新增server/chain/evm.ts或RPC配置文件、tests/ethereum-protocol.test.ts、新tests/multichain-protocol.test.ts、相应fixtures。基于共享审核表严格泛化chainId/token/decimals/amount/from/to/orderId/source证据；保留ETH wrapper和旧Tron接口。18位金额全通路BigInt parseUnits(route.decimals)，不经过浮点/6位转换。新增网络都使用finalized，不降级latest。RPC配置键见 `work/scenario-qa/rpc-config.json`，默认URL与registry公开值一致；生产运行env仅server读取。路线可用性按真实RPC只读健康（chainId、finalized，最好code与token decimals）缓存短时间并单网络隔离；报价前必须通过gate。每个EVM付款前source验证仍全部链/币精确核验。测试假RPC只在tests，不绕过生产健康gate。必要回归后再独立交叉审核。

### 钱包开始实施

risk_security拥有client/wallets.ts、ethereum-wallet.test.ts、新tests/multichain-wallet.test.ts。基于shared审核表泛化原安全检查、send chainId、精确decimals与token、同provider pin；按route.assetNote准确提示。增加sourceNativeBalance(route,source):Promise<string>（EVM18位币余额，Tron不调用）；新增preflightPayment(quote,route):Promise<void>做已知未签名前的token余额/原生Gas余额检查，余额不能伪造，至少native余额为0阻断；使用当前RPC eth_estimateGas/eth_gasPrice核验能负担本次操作时说明只是估算。审批内部同样核验手续费，未知发送后仍锁。
钱包选择：导出listEvmWallets():{id:string;name:string}[]及connectEvm(walletId?:string)（无参数原默认行为兼容），显式选择仅接入发现的EIP1193/EIP6963 provider，provider连接成功后pin。不要二维码/WalletConnect假接入。可按审核表wallet_switchEthereumChain，未知网络4902时允许wallet_addEthereumChain固定审核元信息；切链后必须实读校验。准备接口后先更新本md/SCENARIO-SECURITY.md通知前端。

### 前端开始实施

product_delivery拥有client/App.tsx、styles.css、新tests/scenario-ui.test.tsx及原UI测试必要更新。不要改wallets/shared/payment/api。
- 链/币两级选择（来源于config真实routes，使用available与reason）；默认Ethereum USDT。可保留合并selector辅助但不要9行难用下拉。显示实际token合约/assetNote，gasSymbol正确（ETH/BNB/POL/TRX）。选择任一项清空所有报价/余额/确认上下文。
- 钱包发现选择（上面约定新API），手机钱包内置浏览器说明；当前localhost只能本机，复制公开https网址需来源就是公网，不生成无效二维码或假链接。交易所来源显示先提到自己控制的受支持链钱包，再回来连接；不要平台充值地址或指导直接转合约。
- 增加紧凑的“资产在交易所 / 用手机 / 找不到资产或网络 / 已付款未到账”帮助，默认主流程简洁。不支持Solana/USDC.e/法币/直接原生币要明确；接收仅默认HL Perps，不暗示HyperEVM/Spot。
- native余额读数与零gas阻断，App pay调用新preflightPayment在executeOrderPayment之前完成，防已知未签名失败被锁成未知；钱包层签名前仍复查，后续未知不放行。
- **必须修复独立审查P2-E1**：全本机付款恢复记录中任何未结清unknown/signing/submitted（不是只当前项），新建/新支付统一挡住另一个未决order；允许历史只读查看，持续提示回到待核查订单。仅经server强完成证据结清，拒签未广播且已清marker则无需挡。跨标签storage刷新也检查。请参见ETHEREUM-SECURITY.md完整复现。订单恢复失败也不能误解锁。root可协调api小helper如必要，不自行跨文件写入。
- 加offline提示/重连刷新（不自动付款），拒签可重试而未知不可重付，过期重新报价明确旧授权仍在链上。已有后端暂停/上游不可用/金额上下限/新HL地址0余额保持准确。
- 本轮报告覆盖场景与实际测试，不夸称真人钱包资金验收。

root负责shared registry、env/Compose、生产smoke扩为全部9路线、源码审核/最终UI/交付文档汇总。写完实现后彼此独立审核，root将审查结果合并；不等待新问题才处理既有边界。

## API恢复helper与精度最终合同

root已提供 client/api.ts `readLocalPaymentState(): { orders: SavedOrder[]; orphanedIds: string[] }`。读取全部列表+独立marker、合并状态；坏JSON/字段/重复id/畸形marker/存储不可读取一律抛安全错误；孤立合法marker列出id但不删除。persistSavedOrder也严格读取，不以损坏存储当空列表；保留所有带付款marker的记录，不因20条最近记录截断丢失恢复凭据。旧无付款记录仅保留最近20。loadSavedOrders仍用于显示，付款安全必须用strict helper。root将增针对性api存储测试。App全局锁及未结清强证据查询由product_delivery按其第5节实现；root不重复在payment.ts加锁，避免嵌套同名死锁。

金额：保留route.decimals输入上限，BSC完整18位。server/app.ts报价amount目前允许1–30位小数，order-service用decimalUnits(route.decimals)，不存在HTTP仅6位限制。后端/钱包把6位硬编码泛化，前端不用新做6位截断。环境MIN/MAX限制可以仍最多6位稳定币单位，不影响实际付款18位金额。快捷“全部”按真实token decimals向下计算，不隐藏改单位。

## 多链实现后的交叉审查分工

risk_security 完成钱包后请独立只读复审9路线后台（relay/evm/evm-rpc）、root新增client/api严格存储helper、随后前端最终P2-E1修复；报告到SCENARIO-SECURITY.md，发现实际问题先报告，不直接修改他人文件。

protocol_architecture 完成后台后请独立只读复审钱包多链实现（client/wallets.ts已落盘）、shared白名单与root生产smoke/API storage变更，关注币种精度/链/供应商固定、原生Gas预检、未知发送恢复和真实验收边界，写SCENARIO-REVIEW.md。需要实证时可新增独立测试文件，先写报告再由root统一修复，勿并发改业务文件。

root严格存储helper必要回归：tests/local-payment-state.test.ts 14项+原payment-recovery20项共34通过。已有两项测试错误文案更新为中文安全提示，原“签名函数未被调用”的断言保持。跨订单锁仍由App实现，其不应成为已付款用户恢复同一订单上报hash的阻碍。

## root钱包复核补充

shared registry现新增显式approvalPolicy（USDC=exact；审核USDT/USDT0=reset-if-needed）。risk_security请按该字段选择非零不足时是否清零，USDC直接精确approve即可，避免给不需要重置的用户额外gas。Tron原行为保留。增加USDC旧非零不足额度只有一次approve的回归，按精确token策略而非symbol猜测。protocol审核时注意此新字段。

P2-S1已由root修复：readLocalPaymentState只在getItem返回null时采用[]（改用??），空字符串坏JSON不再视作无记录。tests/local-payment-state.test.ts已加入空字符串参数，保持不得覆写坏记录/不得签名的测试。

用户文档后续由root更新至9路线，frontend不再需要同步README/API/CONTRACT/OPERATIONS/HANDOFF避免并行冲突。

## root发现需要立即修复的集成问题 P1-R1

App监听eip6963:announceProvider后调用discover→listEvmWallets；wallet discoveredWallets每次都dispatch eip6963:requestProvider。标准扩展会在request事件处理器同步announce，造成announce→list→request→announce同步递归，可能堆栈溢出/页面不可用。risk_security请在session发现dispatch加严格reentrancy guard（try/finally），或提供不会再次请求公告的读取接口并同步App，不能只setTimeout形成异步无穷循环。优先guard保持现有API。

product_delivery请加真实App组件测试：模拟EIP6963 request handler同步dispatch公告，App监听后可稳定发现钱包，事件计数有限且可连接；不要只stub list函数从而漏掉循环。risk_security同时可加wallet list重入测试。先修再最终构建。独立审查也核对P1-R1。

## root恢复检查性能边界 P2-R2

persist保留所有付款记录后，inspectLocalPayments在每次order.updatedAt变化及每个资金步骤都查询全部历史；已完成数十单的用户可能轻易撞/api 120 req/min限流，导致被锁为无法恢复。请product_delivery加只在当前页面内存缓存的已核实完成证据（id+token为键，必须hasVerifiedCredit真才缓存），completed是服务端终态可安全复用。不要缓存待付/unknown/缺证据或查询失败，不把本地flag作为已完成证明；其他订单仍现场查。删除无意义重复terminal请求/限定恢复effect触发。补一个多已完成历史不每轮重复请求、未知单仍重新核验的回归。risk组最终复查此处。跨设备与清缓存边界保持诚实。
