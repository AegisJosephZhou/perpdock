# HTTP 与模块合同（v0.1 / rc5）

所有金额为十进制字符串，不用 float 计算金额。时间为 ISO8601。错误 JSON: {error:{code,message,requestId}}，不得泄露堆栈或上游凭据。

## HTTP
- GET /api/health → {status,version}
- GET /api/config → {appName,network:"mainnet",routes:Route[],limits:{minAmount,maxAmount},paused:boolean}
- POST /api/quotes body {routeId,amount,sourceAddress,recipient} → Quote
- POST /api/orders，Idempotency-Key header，body {quoteId} → {order,accessToken}。同幂等键重试须返回原结果；同键不同输入409。
- GET /api/orders/:id，Authorization: Bearer accessToken → Order
- POST /api/orders/:id/transaction，Bearer token，body {txHash} → Order。服务端核验交易与本单匹配，不能信任前端声称成功。
- POST /api/orders/:id/refresh，Bearer token → Order。后台亦恢复轮询。
- GET /api/account/:address → {address,perpsUsdc:string,withdrawableUsdc:string,observedAt}，真实 Hyperliquid info。

## 公开类型
Route {id,label,sourceChain,sourceChainId:number,sourceToken,symbol,decimals,walletType:"evm"|"tron",available:boolean,reason?:string,gasSymbol?:string,assetNote?:string}
Quote {id,routeId,sourceAddress,recipient,amount,amountBaseUnits,expectedReceive,minReceive,expiresAt,provider,fees: {label,amount?,symbol,description?}[],estimatedSeconds?:number,protocolOrderId?:string,transaction: WalletTransaction,approval?:{token,spender,amount},warnings:string[]}
WalletTransaction {kind:"evm",chainId:number,to:string,data:string,value:string} | {kind:"tron",transaction:unknown,contractAddress?:string}
Order {id,createdAt,updatedAt,quote:Quote,status:"awaiting_signature"|"source_pending"|"bridging"|"verifying_credit"|"completed"|"attention"|"expired",sourceTxHash?:string,destinationTxHash?:string,providerOrderId?:string,creditedAmount?:string,statusMessage:string,events:{at,status,message}[],evidence?:{type:string,reference:string}[]}

## 路线与资金绑定

当前审核9条来源路线，完整routeId、网络、token和精度见 [API清单](API.md) 与 `shared/route-registry.ts`。保留已发布Ethereum USDT和Tron USDT id语义；新增ETH/Arbitrum/Base/Optimism/Polygon原生USDC、Arbitrum USDT0、BNB映射USDT。目标为chainId1337的HyperCore默认PerpsUSDC，8位账本；来源按真实6或18位BigInt，不将18位币误作6位。单路线available取真实配置和RPC健康结果；仅审核token可用。

`Quote.protocolOrderId` 是服务端对协议订单重算并验签得到的 bytes32 hash；新 EVM 报价必须返回，旧 Tron 订单可缺省。不能与应用 quote/order id 或 Relay requestId 混用；`Order.providerOrderId` 仍是供应商跟踪用 requestId。钱包将它与 `depositErc20(address payer,address token,uint256 amount,bytes32 id)` 第4参数绑定，并核对 payer、代币、精确金额、审核合约和原生 value=0。Ethereum USDT 为 `0xdAC17F958D2ee523a2206206994597C13D831ec7`，depository 为 `0x4cd00e387622c35bddb9b4c962c136462338bc31`。

来源核验按订单原路线分派：EVM 核对 chainId、交易、成功收据、对应token Transfer、canonical block/hash 及 finalized 高度；Tron 保留固化付款验证。目标仍要求同接收地址、同目标 hash、默认 Perps USDC 与不少于最低到账的证据，不能使用账户余额变化替代。Ethereum 的最终确认及本应用核验可能约15分钟或更久；报价不把 Relay 的1秒估计作为总时长，实际提醒通过 warnings 返回，没有到账时间保证。

## Provider boundary (供后端与协议负责人对齐)
`server/providers/relay.ts` exports getRoutes(), getQuote(input), verifySourceTransaction(quote,txHash), trackOrder(order), getAccount(address)，符合 `shared/types.ts` 的 ProviderAdapter。各函数 async，真实网络请求超时、响应验证；禁止任意用户 URL。getQuote 返回报价业务字段，id/期限持久化由后端管理。`providerData` 留在服务端，不从客户端接收或公开返回。
路由不可达/未验证要关闭，不能假报价。余额 delta 单独不足以确认某订单成功。provider 返回 success 也不足以确认目标 Perps credit。

各源链RPC环境键及默认值见env样例和API文档，仅服务端读取运营配置；shared只存无凭据的公开默认RPC用于用户请求添加钱包网络。实际带令牌URL不得输出日志或客户端。新报价健康gate不得用于跳过已有订单的来源证据。

## 浏览器恢复与签名前检查

`readLocalPaymentState()`严格读全本机订单与独立付款marker；坏JSON/空字符串/权限错误阻断新的资金动作，孤立marker保留提示。已尝试付款记录不因最近20条上限丢失。App在全浏览器Web Lock内重新检查全本机未决付款，历史切换不可绕开；只有服务器强入账证据能结清。原每单锁与持久signing/submitted/unknown标记保留。正常拒签且无hash可重试，其他发送结果不明不自动重付。

EVM签名前预检真实token余额、原生余额及当次估费；不足/未知先停下，实际费用由钱包确认。USDC按exact策略，USDT类按白名单reset-if-needed策略；无无限授权。所有钱包事件/余额/交易固定同一provider，切链后实读核对。手机普通浏览器没有注入接口时仅给指引，无假WalletConnect连接。

当前真实用户签名、各手机钱包资金验收与公网部署尚未完成，协议合同不代表该项已验收。
