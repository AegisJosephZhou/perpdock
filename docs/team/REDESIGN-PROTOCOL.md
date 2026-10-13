# PerpDock 新界面与真实协议的独立映射审查

负责人 protocol_architecture，2026-10-12。只读 client 与协议实现；不改前端，不请求钱包签名，不使用运行时假数据。新App落盘前先给对照表；最终复核另附。

## 实际数据映射（供重写直接核对）

| 界面概念 | 生产字段与边界 | 不应推导的含义 |
|---|---|---|
| 来源/目标 | api.config routes中可用 route；当前唯一 Tron USDT → HL 默认Perps USDC | 不是固定Arbitrum中转，也不是HyperEVM或现货到账 |
| 支付数量 | quote.amount / amountBaseUnits；TronUSDT6位，快捷百分比用最小单位BigInt取整 | 不使用Number/浮点累积或展示示例100/500 |
| 全部 | min(真实sourceBalance，config.limits.maxAmount)，按route.decimals | 不是provider自身上限10,000；服务端部署默认上限1,000且可配 |
| 预计净到账 | quote.expectedReceive（已按HyperCore虚拟USDC8位转换） | 不再次减route fee，不保证等于实际到账，不用源数量减USDT费用猜USDC |
| 最低到账 | quote.minReceive，保留必要精度（允许8位） | 不硬编码滑点百分比；即使将大数字视觉缩写，明细必须保留全部有效小数 |
| 已核实到账 | order.status=completed + hypercore_credit；主数用order.creditedAmount | 不因provider成功、授权成功或balance增加就显示成功；不要用expectedReceive作已到账fallback |
| 账户信息 | api.account.perpsUsdc来自HL marginSummary.accountValue，withdrawableUsdc来自withdrawable | 前者含未实现PnL，不是纯USDC现金，不是这笔入账证据 |
| 费用 | quote.fees逐项带symbol；gas源链费估算、relayer组合路由费、app应用费 | TRX与USDT不可直接相加；不能写固定0.2%或把TRX费也从预计USDC中再扣 |
| 时效 | expiresAt由应用取min(now+120秒，协议deadline)；显示剩余签名窗口 | 不是到账倒计时；本机窗口到期不证明已广播付款失败 |
| 资源 | 每笔Tron合约调用fee_limit最多150TRX，用户钱包显示实际资源 | 不是整次入金必花150TRX/总上限150TRX；旧非零额度不足可能产生清零+授权+付款3笔 |
| 默认Perps核验 | 后台Tron固化转账→Relay同sourcehash→HL同destinationhash、recipient、USDC、足额 | HyperCore目标hash不是0x接收地址，也不是Tron付款hash；不能混用Explorer |

## 状态与页面检查重点

- 仅报价/awaiting_signature且无本机submission仍在入金页。signing、submitted、unknown任一种本机标记足以锁定再次付款并进入恢复/进度上下文；“signing”不等于已广播。
- source_pending是源交易等待核验，不是源链付款已完成；bridging意味着源交易固化后执行路由；verifying_credit可能是供应方已完成但HL精确账本尚未匹配；attention是需进一步核查，不等于余额丢失或已自动退款。
- completed无证据继续显示核验中；如果无法取得creditedAmount不能展示“预计值已到账”。前端额外保守检查可避免坏响应导致假成功。
- 进度页主数字应直接读当前order.quote/creditedAmount，避免返回新入金后amount/recipient输入状态污染旧订单展示。
- 换历史订单、开始新单、回到进度不能绕过executeOrderPayment，也不能清除原独立submission记录。busy期间不准切订单/离开签名上下文。
- 本机恢复遇到api.order读取失败应保留恢复页面和原凭据，不能把暂未加载的order当作“未创建订单”露出新付款入口。

## 费用依据

Relay官方 Get Quote字段将 fees.gas 定义为源链费、fees.relayer为relayerGas+relayerService组合。当前代码只取gas/relayer/app，避免把子项重复计费。来源：https://docs.relay.link/references/api/get-quote-v2 （2026-10-12读取）。当前真实测试快照分别为TRX和USDT费用；这些样例值只能用于tests，不能复制到UI默认值。

## 与测试组协调

risk_security拥有tests/redesign-ui.test.tsx，本组不另写重叠组件测试。请特别加入：completed+证据但缺creditedAmount保守展示、source_pending不可画来源已确认、历史quote与草稿输入不同值、unknown在order请求失败时也不得允许重新付款。

### 实施协调
基线检查时App仍为旧双栏页面，尚未对新UI给出“通过”结论。请前端在新App落盘可审查后通知本文件审查者；无需等视觉全部收尾，可并行检查资金含义。组件测试归risk_security，本组不添加重复测试。

### 主网资源文案补充（官方核对）
fee_limit 150TRX严格来说限制单笔合约调用的 Energy 预算，不是整次入金的全部网络费上限，Bandwidth另计。建议付款前文案为“每次合约操作的能量费用上限为150 TRX；带宽及实际费用以钱包为准。授权与付款分别计费。”旧额度需要归零时会多一次授权操作。避免仅写“最高手续费150TRX”而令用户误认为总费用保证。依据：Tron官方 https://developers.tron.network/docs/set-feelimit 和 https://developers.tron.network/docs/resource-model （2026-10-12读取）。不必在主流程暴露SUN或协议开发细节。

## 新App第一轮读码（13:24落盘的逻辑层，JSX尚在重写）

新增BigInt快捷金额、busy导航保护、restoring和progressPage分离与真实合同一致。`isCredited`已拒绝缺creditedAmount，后续JSX请不要再以expectedReceive作为到账金额fallback。

一项需在最终版收口的展示防线：当前isCredited只检查positive creditedAmount和某个hypercore_credit类型，尚未复核最小到账额及 evidence.reference 与当前recipient/destinationTxHash的绑定。建议与backend同条件：creditedAmount>=minReceive，destinationTxHash合法0x64hex，reference精确匹配`recipient:hash`（EVM大小写无关）。状态completed但证据不完整时，主标题与状态说明都应改为核验中，不能直接显示原始order.statusMessage的“已到账”文字。risk_security的新组件测试已包含underpaid/invalid-hash/wrong-recipient/wrong-hash，按该组测试即可，不另添重复用例。

## 新JSX第二轮：一项状态文案需修正

### P2-R1：本机已有txHash但尚未上报时，主状态仍显示“等待钱包签名”或“报价已过期”
位置 `client/App.tsx:progressTitle`（约253行）。触发：付款函数在Tron广播前保存submission={state:'submitted',txHash}；用户广播后页面关闭/进程中断，尚未来得及api.report。下次恢复后本机有txHash，服务器仍awaiting_signature或expired。当前progressTitle只特别处理signing和unknown，会回退服务器标签，主状态提示等待签名/过期；实际已转到进度页且必须先核验同一hash。

建议：在没有order.sourceTxHash但存在localHash时，使用“交易编号已保留，等待核验”（不直接说已广播成功，因为保存发生在广播前）。明确本地签名窗口过期不代表这笔资金失败；继续核验入口保持同hash上报。不需修改wallet/payment资金路径。本机submission=signing无hash、unknown无hash继续使用当前文案。

其余二轮通过：hasVerifiedCredit现绑定min与recipient/hash；不完整completed状态和事件文案不再泄露上游“已到账”；进度金额直接order.quote/creditedAmount，不被草稿污染；source_pending为第1步active而非done；网络费不跨币相加；每次150TRX Energy预算与Bandwidth分开说明；恢复读取失败不显示新付款表单。

## 最终协议映射审查结论（2026-10-12）

**通过本组静态独立审查；P2-R1关闭，没有遗留的协议/金额/资金状态映射阻断项。** 最终复核 `client/App.tsx`：localHash且未上报优先显示“交易编号已保留，等待核验”，说明签名窗口过期不代表该付款失败；相同hash继续核验入口保留。没有把广播前持久化hash当作源链成功凭证。

已确认最终界面：
1. 路线取config；未见Arbitrum/HyperEVM中间链硬编码、示例净额/固定收费/假成功计时器或交易/B端新功能。零报价显示“—”。
2. 源余额与快捷金额为真实wallet结果；百分比在6位最小单位BigInt取整，并按服务器max截断。目标预计/最低值逐字保留8位能力，费用保留原symbol，不重复扣费。
3. 目标始终标默认Perps；目标账户价值称“权益”并说明含PnL；实际到账只用creditedAmount，不用expected fallback，且与min、recipient/hash证据绑定。
4. 未付款awaiting/expired在填写页；存在本机signing/submitted/unknown或sourcehash进入进度；恢复未读出时不显示新报价/付款表单。操作中ref与busy锁导航，原executeOrderPayment/approveExact/getAllowance/sendPayment路径未被替换。
5. source_pending第1步为等待确认，bridging后才把来源标已核验。供应方success不直接完成；异常completed的主状态、描述与事件不传播“已到账”误导文案。
6. Tron TRX资源提醒、单次Energy预算150TRX、Bandwidth另计和可能清零多次交易已按官方含义表达。签名窗口独立显示，只在未付款页倒计时，未假设到账时间。
7. 进度使用本单quote/recipient/sourcehash，不使用草稿输入；本机历史与下载凭证入口保留。未知结果没有新付款按钮，无自动退款/通知/客服等未实现承诺。

本组此次不修改运行时代码，不重复创建组件测试。风险组 `tests/redesign-ui.test.tsx` 覆盖上述关键恢复/坏completed场景，最终测试结果以 REDESIGN-SECURITY.md 与 root 集成记录为准；本结论不冒充浏览器视觉验收或实际资金端到端验收。真实TronLink签名和小额到账仍由用户本人完成。
