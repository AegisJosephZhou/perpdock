# 前端工作包
负责人 product_delivery。先读 TEAM.md 与 ../CONTRACT.md。
立即实现 client/**，不修改 package/shared/server。
界面为中文、专业简洁、有完整可用状态，品牌暂名 HL 入金。白/深蓝配少量青绿色，避免伪图表、编造交易量、虚构成功案例。功能：连接 injected EVM（viem / EIP-1193，MetaMask/Rabby）与 TronLink；分别展示付款地址与 HL 接收地址，收款地址需用户显式确认；选择后端真实 route、输入金额、实时真实账户余额、请求报价、展示净额/费用/到期/提供方、订单创建、确切 allowance 授权与用户签名广播、上报 tx、轮询状态、刷新恢复、订单凭证。localStorage仅可存本机订单凭据并说明；钱包拒签、换链、断开、报价过期、签名后上报网络失败须可恢复且不重复付款。连接或页面加载不得主动付款。
source EVM 与 recipient不同须确认，Tron不会自动推导HL地址。不能将 provider 任意 calldata 无检查签名，后端负责验证但前端至少匹配 chain/from。
需写 FRONTEND-RESULT.md，含运行检查和剩余问题。实质讨论追加本文件，工具仅通知文档更新。

## 实现约定（前端，开始）
- 创建 `client/main.tsx`、`client/App.tsx`、`client/api.ts`、`client/wallets.ts`、`client/styles.css`；根目录 HTML 请指向 `/client/main.tsx`。
- 依赖 React、react-dom、viem；不额外引入 UI 框架和运行时模拟。前端类型先按 CONTRACT.md 引用 `shared/types.ts` 中 Route、Quote、Order、WalletTransaction，请 root 保留这些导出名；若实际契约不同以类型检查反馈协调。
- EVM 余额/allowance 经用户已连接的 injected provider 真实读取；通过 wallet_switchEthereumChain 切到源链。Tron 通过 TronLink 注入的 tronWeb 读取真实余额和构建精确授权，待协议负责人确认 unsigned transaction 形状。
- 提交资金交易前，浏览器先持久化“签名处理中”状态；获得 txHash 后先存本地再上报。页面刷新后保留待上报交易；签名过程中断且无 hash 时进入人工核查提示，不自动重复付款。
- 接收地址独立连接 EVM 钱包或手工输入，并显式确认。钱包连接/选链/查询/报价都不触发支付。连接的钱包账户/链变化立即使未执行报价失效。
- 希望协议组：Quote.transaction 的 EVM 签名输入不含 from，前端将独立匹配当前 sourceAddress 与 chainId；Tron transaction 至少需有 owner_address、raw_data.contract、txID，方便签名前核对 owner、目标合约、及唯一 transaction。

## 首轮及第二轮修复（2026-10-12）
- 已修复 Base58 大小写比较（含 UI 的 correctWallet），Tron 实際操作前由注入 TronWeb.isAddress 核验地址；EVM 比较继续允许大小写编码差异。
- requireTronMainnet 现在只接受白名单节点 HTTPS/default 443；拒绝 URL 用户名/密码、HTTP、其他端口。构造交易拒绝附带 TRC10、非零 TRX、额外合约/权限，并将 fee_limit 限定到 150,000,000 SUN。
- 交易构造之后以及签名返回之后复查 raw_data；签名前快照 txID/raw_data/raw_data_hex 避免钱包原地修改逃避比较；使用注入 TronWeb.utils.transaction.txCheck 核验 protobuf 编码及 txID。若旧 TronLink 缺此校验能力则安全阻断，提示更新，不跳过校验。
- 账户文案已为“Perps 账户权益”，可提余额单列；下载凭证仅含 Order，不带本地 accessToken/幂等键。
- 按订单 ID 使用 navigator.locks 独占且 ifAvailable；无 Web Locks 的非安全环境阻断付款。锁内重新读取本地付款记录和服务端订单，状态必须仍为 awaiting_signature。React 同组件另用同步 ref 阻止双击；先持久化 signing，再触发签名。
- 每单付款标记存独立 localStorage key，避免其他标签保存不同订单时覆盖付款标记；storage 事件同步 UI。进行中的报价会在钱包账户/网络变化时通过 request counter 失效。
- 类型检查已通过第一次修复；第二轮检查进行中。

### 可供 root 增补测试的导出
`client/wallets.ts`: `requireTronMainnet`, `validateTronBuilt`, `walletAddressEquals`。
`client/api.ts`: `withOrderPaymentLock`, `savedOrderForPayment`, `STORAGE_KEY`, `SUBMISSION_PREFIX`。
请 root 在其 tests 所有权内补充 HTTPS/端口、Tron TRC10/fee limit、签名返回参数变化、跨标签锁争用/持久化失败/过期后付款回归。当前 tests/wallet-context.test.ts 的纯上下文校验不需要钱包或全局 window，保持兼容。

### CSP 集成必需项
请 root 复核 REVIEW.md 的 connect-src=self 建议：EVM 使用 injected EIP-1193，但 TronLink 注入的 tronWeb 的余额读取/triggerSmartContract/getTransactionInfo/sendRawTransaction 会通过它的 fullNode HttpProvider 在页面上下文请求 Tron RPC，只有 self 会阻断真实 Tron 流程。建议 connect-src 限于 self 加前端 requireTronMainnet 的精确主网节点 origins（https://api.trongrid.io、https://api.tronstack.io、https://tron-rpc.publicnode.com），禁止任意 https:；若产品只支持 TronGrid，可统一收窄三处白名单。TronLink 签名仍由扩展处理。

### 已运行检查
- `npm run typecheck`：通过（首轮与第二轮修复后）。
- `npm test -- --run tests/wallet-context.test.ts`：8/8 通过，含 Tron 地址/token 大小写、到期、接收地址、超额授权、网络类型和拒签识别。
- `npm run build`：通过，452 模块，客户端主 chunk 541.21 kB / gzip 167.52 kB；Vite 给出非阻断体积提示。无跳过严格类型检查。
- 没有执行任何钱包签名或资金广播；浏览器注入 TronLink 真钱包及小额资金流程仍必须由用户最终验收。

### 报价时效补充
TronLink 的 trx.sign 不广播，用户可能长时间停留签名弹窗。签名返回后、保存 hash/广播前再次校验报价期限；过期则不广播，不因签名前已校验而继续支付。EVM eth_sendTransaction 由钱包直接提交，只能签名前检查；当前没有启用 EVM 资金路线。
# 2026-10-12 root：最终恢复/跨标签测试
先修复 WALLET-REVIEW.md P2-1：缺少 approval 不能假设实际 allowance 足额。Tron 路线统一从 sourceToken 读取真实 allowance，并绑定 transaction.contractAddress；无 approval 且不足时明确提示重新报价后阻断付款。协议组会写真实 TronWeb 编码与签名测试，root 显式安装 tronweb6.5.1 devDependency。
请新增 tests/payment-recovery.test.ts，独立验证 withOrderPaymentLock/savedOrderForPayment 的锁争用、独立submission覆盖、防止storage失败后签名、订单/签名未知结果恢复等真实逻辑。不要只镜像实现；发现bug可修client并写MD。协议组正在 tests/wallet-execution.test.ts 做签名构造回归，请勿重叠。后台已接手 CSP修复。root处理IAB白屏/浏览器/生产运行验证。

## 最终恢复测试与独立审查跟进
为测试真实付款路径，已把 App 内同一段资金编排提取为 client/payment.ts 的 executeOrderPayment；页面仍使用这条生产路径，不存在测试运行时模式。测试将直接验证该函数，不在测试里复制付款算法。
接受 WALLET-REVIEW.md P2-1：getAllowance 不再因为报价无 approval 而假设足额；Tron 永远读取 sourceToken.allowance(source, contractAddress)。没有 approval 且当前不足时禁止授权/付款并提示重新报价；有 approval 也必须与实际 depository 一致。

### 最终恢复测试结果（2026-10-12 19:24 UTC）
- 已新增 tests/payment-recovery.test.ts，20/20 通过；npm run typecheck 同时通过。
- 测试调用 App 实际使用的 executeOrderPayment，覆盖：同单跨标签锁竞争、不同订单不互锁、签名前 durable 标记、hash 上报前保存、刷新后的 signing/unknown/submitted 三态阻断、广播后上报失败、钱包超时无 hash、明确拒签后安全重试、两个 storage 写入点失败均不调用 signer、存储不可读、独立付款标记抵抗旧列表覆盖、服务端状态/quote改变、读取错误后可重试、无 Web Locks、损坏本机标记。
- 测试中的节点/钱包/存储替身只在 tests 中，未注入浏览器、未进入产品运行路径。
- WALLET-REVIEW.md P2-1 已修复并通知协议负责人用其钱包执行测试独立验证；CSP 与浏览器验证由 root/后端继续。
