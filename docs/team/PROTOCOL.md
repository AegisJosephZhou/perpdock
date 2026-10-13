# 协议工作包
负责人 protocol_architecture。先读 TEAM.md、../CONTRACT.md，以及工作区 work/architecture-notes.md。
最高优先：真实验证目前公开可用的 Tron USDT → HL Perps end-to-end quote/执行交易 API（deBridge DLN、LI.FI、Relay 或其他一手官方），仅只读报价，不转账。明确API权限、准确链ID/币地址、指定 recipient 的 HyperCore 可用余额语义。不能把HyperEVM到账冒充Perps到账，不盲签未知calldata。第一时间将可执行路线、官方来源、API请求响应结构写本文件，供团队实施。
并行实现 server/providers/** 与 server/chain/**，真实请求 timeout/schema校验、报价参数白名单、wallet交易安全验证、source tx核验、目的credit核验、HL account info。
若Tron公开API不可用，明确记录阻塞并实现可真实运行的 EVM USDC→HyperCore官方CCTP路线或可信端到端provider作为补充，不冒充Tron完成。优先现成可信provider而不是自建资金托管/relayer。root将准备shared types。
提供能执行的真实API smoke测试和证据，不编造地址余额/路由/成功。测试中可用公开已知地址只读；不能请求水龙头/实际交易替用户付费。
写 PROTOCOL-RESULT.md，包含关键calldata与credit核验、安全风险、未实测项。所有团队实质沟通通过Markdown。

## 第一轮真实结果：Relay 可返回 Tron USDT → HyperCore Perps 可执行报价

2026-10-12 实际只读请求 `POST https://api.relay.link/quote/v2` HTTP 200。未带密钥；官方文档写 2026-10-02 起要求 API key，但此次真实 API 仍返回成功，因此实现支持可选 `RELAY_API_KEY`，鉴权失败时诚实停路由，不用旧报价兜底。

请求关键项：originChainId=728126428，originCurrency=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t，destinationChainId=1337（不是 HyperEVM 999），destinationCurrency=0x00000000000000000000000000000000（Relay 自定义 Perps USDC 标识），amount=100000000，tradeType=EXACT_INPUT，protocolVersion=v2，includeProtocolData=true，explicitDeposit=true，recipient=用户 HL 0x 地址，refundTo=源 Tron 地址。

真实响应保存于工作区 work/relay-tron-quote-response.json。100 USDT 预估 99.734623 USDC，最小 97.739931；这是一次报价快照，非资金实测、非长期承诺。响应含 approve + deposit 两个 TriggerSmartContract 步骤，以及完整 protocol.v2.orderData/orderId/orderSignature。

官方 `/chains` 同时返回 Tron/HyperCore 及独立 protocol depository 配置：Tron `TXtEs6t2oUWQsNos7m68gbHdE9Q5n6x2oN`（hex 41f0623e1012177482912fb057e44e1a9769b1f588）。Deposit selector `e8017952` 对应 depositErc20(address,address,uint256,bytes32)：payer、USDT、exact amount、orderId。必须用 settlement SDK 重算 orderId，再校验 calldata；不能只相信 quote 自己给的 depository。

前端注意：Tron 返回的是构造参数 `{type:'TriggerSmartContract',parameter:{owner_address,contract_address,data,call_value?}}`，并非可以直接 `trx.sign` 的完整交易。应使用 TronLink 的 tronWeb.transactionBuilder.triggerSmartContract 构造后核对 raw_data.contract 内容再签名。`approval` 使用相同共享字段，Tron 地址为 Base58。只给 exact allowance，不能 unlimited。

官方规范：https://docs.relay.link/references/api/api_guides/hyperliquid-support 、https://docs.relay.link/references/api/api_core_concepts/input-validation 、https://docs.relay.link/references/api/get-quote-v2 。下一步实现 getQuote 与源链固化检查、Relay状态+HL ledger入账归属核验。

### root 依赖请求
请安装生产依赖 `@relay-protocol/settlement-sdk`，协议模块需要 `getOrderId` 对 Relay orderData 进行本地重算（这是安全边界，不应省略）。我将用 node:crypto 实现 Tron Base58Check，不额外引入 tronweb 到服务端。接口按当前 shared/types.ts 实现，SourceVerification 使用 valid/pending，而非旧 confirmed 提案；链查询暂缺保持 pending。

### SDK 审查回复
同意把完整 SDK 移至 devDependencies。将使用顶层 viem.hashStruct 独立实现本路线所需的 v1 order schema 与地址归一化，拒绝其他版本/链/额外调用；以官方 SDK 0.0.147 和真实报价做差分测试。关键差异：Tron 地址哈希输入包含 0x41 网络前缀（21 bytes），HyperCore 自定义 USDC 保留 16-byte 表示，不能补齐20字节。SDK npm 元数据 license=MIT、author=Uneven Labs；包内未含 LICENSE，公开 repository URL 目前404。因此不复制其实现文本/冒造copyright；保留协议字段/算法来源、版本及独立实现说明，差分测试在开发依赖中调用原 SDK。

## 首轮审查回复
- 官方 get-quote-v2.md slippageTolerance 明确单位 basis points，50=0.5%，因此当前请求100=1%。初轮未传滑点快照由provider默认200bps；应用始终展示协议minimumAmount，不声称固定净额。
- 已删除长期产品warning中的工程验收状态，保留主网资金/收款地址确认。发布门槛在文档记录。
- 已取得真实历史 Tron→HL 成功订单：Relay requests/v3 requires API key，但只读 requests/v2 仍可访问。历史 requestId `0x179181616308425f6b18b868a70d582a09de8f4890bf2afe641e613a9e587d27`，源 tx `dd922bb0f3bc991e9f8e6ed97ef28f4b5ebc144d431bfc5d13021ddb47acb233`，输出 HL hash `0x91c2d9c61c4b92d4933c04466794af02129100abb74eb1a6358b8518db4f6cbf`。入账给 `0x1d26f48ac0c949d739461bffebb5bfd0148676cf`，506.546688 USDC，HL sendAsset destinationDex=""。本地证据 work/relay-history-v2.json、work/hl-fill-ledger.json、work/relay-history-status.json。该历史源交易采用transfer+orderId后缀，不是本应用exact depositErc20，因此只用于目标credit核验，不冒充本应用资金端到端验收。

## 实现已落盘，可集成

server/providers/index.ts 导出共享合同的5个函数及provider对象。当前唯一 routeId=`tron-usdt-hypercore`；10–10,000 USDT，源6位/目标8位；RELAY_API_KEY、TRONGRID_API_KEY均支持可选。没有EVM补充路线，因为主Tron已获得真实有效报价。运行时只请求固定官方hosts，不读tests fixture。

已从生产模块完成只读live：`getQuote(100 USDT)`取得 requestId `0x17918323350b98ca3d3df688e2f4b5ccc2dbc445bfdec354d25dd348691fd764`，本地哈希/solver签名/精确授权与付款calldata全部通过；expected 99.735929、min 98.73857 USDC（1%滑点）；getAccount真实返回公开研究地址余额9.56。时间2026-10-12T19:12:16Z，无转账。

订单跟踪只读：Tron SolidityNode raw transaction+receipt成功+受信USDT Transfer事件 → Relay status绑定同source hash → HL ledger绑定同fill hash、recipient、USDC、destinationDex空串、amount>=min。仅send和internalTransfer支持，其余保持verifying_credit。真实历史记录已证明Relay sendAsset产生delta.type=send、destinationDex=""的可匹配账本事件。

测试文件 tests/protocol.test.ts 和 tests/fixtures/* 已创建，覆盖真实quote+SDK差分、地址/金额/订单/签名/合约/授权篡改、Tron固化失败、spot不误报Perps。当前Vitest启动无输出排查中；typecheck协议模块无报错，其他组文件仍在实现中。

### 测试结果
2026-10-12 19:13:58Z：`node node_modules/vitest/vitest.mjs run tests/protocol.test.ts --configLoader native`，13/13通过，476ms。默认bundled配置加载卡在esbuild服务；native loader正常，建议root统一测试命令采用该选项（Node >=22.13需确认native TS strip支持，无自定义loader）。失败进程均已中止，不是测试断言失败。

### 前端集成注意
getAccount 的 `perpsUsdc` 是清算账户 `marginSummary.accountValue`（账户价值，可包含未实现PnL）；界面请称“Perps账户价值”，`withdrawableUsdc`才是可提金额，均不作为本单credit证据。Tron exact approval→depositErc20构造方式已与client/wallets.ts对照一致。建议signed transaction返回后也核验raw_data.contract参数未变化，再广播；不能只对比签名前后的txID文本。TronValue解析还应拒绝非零call_token_value及token_id以排除TRC10附带付款。

## 2026-10-12 独立安全审查 P2-1 修复提案（接口待 root/后端同步）
接受 SECURITY-REVIEW.md 的真实复现。Relay updatedAt 不能作为唯一历史范围起点。计划按订单 quote 时间开始查 HL 账本，单轮最多 4 页，每页按照官方 500 个不同时间/区块上限继续；确切 hash/recipient/default Perps/minimum 不变。扫描达到当前时间后回卷重扫，可处理后到数据，不能永久错过已扫描区间中的延迟索引。

为避免每次轮询都重扫首 4 页，需要持久扫描游标。请 root 为 TrackingUpdate 添加可选 `providerDataPatch?: ProviderData`（server-only）。后端收到适配器结果后，仅把该内部 patch 合并回本订单已保存 quote.providerData（quotes 表存 JSON，无需新表）；HTTP 客户端不得设置，也不回传。适配器使用 `creditScan: { startTime: number, fillHashesKey: string }`，hash集合变化则重置，source/recipient固定在原 quote。请后端增加 Store.patchQuoteProviderData 与调用，测试重启恢复。

纠正文档：HyperCore USDC literal 为 16 bytes（32 hex），此前写作 15-byte 是笔误；实现按原始 bytes，与官方 SDK 差分一致。

### root 接受 P2-1 修复
shared/types.ts 已添加 providerDataPatch。请立即实施有界分页/游标修复并将 security-review.test.ts 预期失败改为普通通过回归，覆盖缺失 updatedAt/500上限。risk_security 负责 Store/OrderService 持久化与重启测试。继续完成 WALLET-REVIEW-TASK.md；避免修改 client。root 整合 CSP 与浏览器验证。

### P2-1 协议修复完成（2026-10-12 19:23Z）
`scanPerpsCredit` 从 quote 前60秒开始，按官方 inclusive startTime 取上一页最大时间戳，最多4页/轮；完整扫完回卷，防迟到索引永久漏记。达到上限将游标放在 providerDataPatch.creditScan；目标hash集合改变/非法游标会重置。未使用 Relay updatedAt 推导fill时间。不对无法推进的同时间戳截断数据跳过，保持未核验。仍逐条绑定同hash、目标用户、默认PerpsUSDC、足额金额。

root已授权修改 security-review.test.ts；原预期失败改普通测试，并增加缺失updatedAt场景。协议tests补500结果上限、四页边界/下一轮恢复、迟到索引回卷、同时间戳无法推进。`npm test -- --reporter=dot tests/protocol.test.ts tests/security-review.test.ts`：25/25全部正常通过，无it.fails。后端持久化实现由 risk_security 负责，未在本组测试中替代其重启测试。
