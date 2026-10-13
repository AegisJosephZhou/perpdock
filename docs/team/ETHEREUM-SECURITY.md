# Ethereum USDT 钱包执行与独立审查

负责人 risk_security。拥有 client/wallets.ts、tests/ethereum-wallet.test.ts；不改后台/shared/App。测试桩只在tests，无真实钱包连接、签名或广播。

## 开发接口协调

- 保持 connectEvm / getEvmChain / switchEvmChain / evmProvider / sourceBalance / getAllowance / approveExact / sendPayment 的现有导出签名。前端无需换调用方式。
- EVM provider将优先选择EIP-6963的MetaMask，再兼容legacy MetaMask（排除isRabby冒用isMetaMask），连接成功后保持同一provider实例，读取、切链、批准、付款不再重新挑另一钱包。官方说明isMetaMask并非身份保证，因此不能以单个boolean声称认证钱包来源；钱包扩展仍属用户信任边界。
- EVM sendTransaction返回hash时立即onHash，不等待receipt或再次网络读取；RPC错误无hash维持现有unknown恢复锁，不自动重试广播。EVM扩展通常合并签名和广播，网页不能撤回用户在钱包中迟迟确认的交易；会在请求前查到期/账户/链，并将准确chainId放入请求，返回hash后无论状态变化都先保存。
- **已由root/shared与backend确认**：公开Quote增加可选 `protocolOrderId?: string`（仅新EVM路线必填），值为服务端已重算及验签的Relay协议orderId，明确不是requestId。钱包比较deposit calldata中的bytes32 id与该字段，绑定公开订单上下文。旧Tron Quote保持兼容可缺省。后台已核实Ethereum depository与真实deposit函数/参数。

官方依据：[MetaMask provider API](https://docs.metamask.io/metamask-connect/evm/reference/provider-api/)、[EIP-6963](https://eips.ethereum.org/EIPS/eip-6963)。读取同日；只引用provider/事件/发现接口，不声称新SDK已接入。

## 钱包实现已落盘，可集成

`client/wallets.ts` 已完成EVM收口，保持原导出签名与Tron执行分支。pin Ethereum chain1、USDT/6位、depository `0x4cd00e387622c35bddb9b4c962c136462338bc31`；真实ABI仍depositErc20。对公开protocolOrderId与calldata第4参数进行绑定，严格区分协议hash与requestId，校验payer/token/amount、显示金额、原生value=0与规范重编码（拒绝额外尾部数据）；授权spender必须同审核合约。

同一连接provider覆盖余额/allowance/chain/receipt/交易，优先EIP-6963 MetaMask与非Rabby的legacy MetaMask，成功连接后保持实例。read-only viem transport关闭重试；发送交易直接对该provider调用**一次**eth_sendTransaction，带chainId=0x1、from/to/data/value=0，不设置provider报价gas/fee，不尝试其他send方法。hash返回后立即onHash，不因付款后到期而丢弃交易编号。未知无hash通过真实executeOrderPayment保留恢复锁。

USDT非零不足额度走approve(0) → 成功receipt → 读取额度核对为0 → 精确approve(amount) → 成功receipt → 读取额度核对；receipt来自同一钱包，并检查同hash/from/token/status/有block，账户链变化停止后续操作。授权过程到期后不再发下一笔。足额不新授权，无无限授权请求。

独立执行：`node node_modules/vitest/vitest.mjs run tests/ethereum-wallet.test.ts tests/wallet-context.test.ts tests/wallet-execution.test.ts --configLoader runner`：**53/53通过**（新增Ethereum钱包29项，原Tron/上下文24项）；`npm run typecheck`通过。测试调用实际wallet/payment/viem编码，仅EIP-1193 RPC、API和storage在tests内隔离。覆盖错误spender/to/token/value/chain/payer/amount/orderId/尾部数据、USDT清零/精确授权、reverted/错误receipt、链切换、拒签、未知send、错误hash、已返hash但report失败及禁止重复付款。无真实签名/广播。

## 第二轮：授权回执防御检查

已按root初审意见补强 `waitEvmApproval`：只有null表示尚无回执；undefined/非对象、缺失或错误类型的hash/from/to、非规范hex quantity的blockNumber、缺失/畸形blockHash均立即停止。回执必须有有效区块号与32字节区块hash，再核对status=0x1；不会据畸形回执执行下一次授权。新增9个必要失败回归。2026-10-12再次运行相同三个钱包文件，**62/62通过**（Ethereum38 + 原Tron/上下文24），随后typecheck通过。此数字不是全工程最终验收数字。

## 独立只读审查结论（Ethereum实现与集成）

已读 `server/providers/relay.ts`、`server/chain/ethereum.ts`、`shared/types.ts`、`client/App.tsx`、付款恢复协调器、order-service/store相关路径及Ethereum协议/UI回归。后端新增路线目前未发现阻断性的P0/P1资金绕过；保留一项P2页面恢复边界建议由root统筹本轮场景扩展修复。

- 报价信任边界：独立/chain元信息必须匹配固定chain1、USDT、depository、HyperCore；重算协议order hash并验固定solver签名，原始requestId与协议orderId分别处理。EVM仅转发审核后的from上下文、to/data/value/chainId，拒绝未知signing step及额外调用，金额6位、目标8位绑定。`protocolOrderId`经publicQuote保留，旧Tron缺省不受影响。
- 来源证据：核对RPC chainId、实际transaction、成功receipt、精确USDT Transfer事件、block归属与canonical包含交易；finalized尚未覆盖保留pending。节点未知或错误不能完成订单。RPC在每次HTTP取值上都有超时/大小限制/禁止重定向，不从用户请求注入RPC URL。
- 目标证据：Relay success不等于完成；必须绑定源hash、目标fill hash、指定recipient的默认Perps USDC正向账本入账且不少于最低金额；HyperEVM钱包收到币、Spot余额、总体余额增加或其他订单hash均不能替代。UI完成状态还独立核对recipient:destinationHash与金额。
- 恢复边界：服务器保存quote/providerData，单个quote仅一order；同链已验证source hash具唯一性。付款前同订单Web Lock和持久signing标记，RPC未知不清锁；hash立即保存，即使之后过期、上报失败也不再次付款。源付款后RPC失败或退款状态仅继续核查，没有退款/重付自动动作。
- 前端双路线：账户/链变化清除旧报价、确认与allowance，真正签名前钱包层再次校验；旧Tron按order.routeId恢复，不被默认Ethereum覆盖。Ethereum总时长未使用Relay的1秒估时，费用和最终确认提示在报价及进度显示。

### P2-E1：历史订单切换可绕过当前未知付款的“开始新入金”限制（已在场景扩展关闭）

位置：`client/App.tsx` 的 paymentAttempted（约73行）、startNew（约251行）与openSaved（约263行）。paymentAttempted仅来自当前credential/order；openSaved允许离开已有unknown/signing/source_pending的订单。具体路径：本机A有未知付款 → 订单记录 → 打开已有且未付款的B（或已完成B） → B的“重新填写入金/开始新入金” → 新路线/新订单。A的恢复记录没有丢失、同A不会重复广播，但用户可能把新订单当作A的重试，违反页面原本“结果不明先核查”的限制意图。

建议本轮场景扩展：读取全本机未结清付款记录（不能只取当前选中项）并给出持续可见的待核查提醒；要维持严格单未结清入金策略，就在新报价/建单/新付款入口统一挡住其他未决订单，历史浏览仍允许。完成态只能以服务器强证据结清；不要只凭本地state=submitted解锁。至少补Aunknown+B未付款、Aunknown+Bcompleted、跨标签切换等回归。其他设备/清除浏览器数据不能靠本机锁保证，应如实说明。本条不把未知认定为失败，也不要求自动清除旧标记。

最终修复与独立验证见SCENARIO-SECURITY.md「最终独立复核收口」；该历史发现已关闭。

实际主网签名/广播、钱包扩展兼容性、用户账户资产与真实资金到账仍未执行。provider身份发现依赖用户信任的扩展；RPC依赖运营选定服务，并非轻客户端或多RPC共识。全量构建/生产只读smoke由root统一，不以本报告替代。
