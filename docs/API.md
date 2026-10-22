# HTTP API v0.1

同源JSON服务，路径前缀 `/api`。所有金融金额为十进制字符串。错误格式 `{ "error": { "code", "message", "requestId" } }`。不得把订单访问令牌放入URL。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /health | 服务存活检查；不等于路线可用或资金已到账 |
| GET | /config | 主网标识、当前路线、金额范围、暂停状态 |
| GET | /account/:address | 实时HL默认Perps账户权益与可提取金额；查询结果不是单笔入账证明 |
| POST | /quotes | `{routeId,amount,sourceAddress,recipient}`；返回真实报价和已核验的待签交易 |
| POST | /orders | `{quoteId}`，必须带随机 `Idempotency-Key`；返回 `{order,accessToken}` |
| GET | /orders/:id | `Authorization: Bearer <accessToken>`，恢复订单 |
| POST | /orders/:id/transaction | Bearer鉴权，`{txHash}`，记录并核验用户已广播交易 |
| POST | /orders/:id/refresh | Bearer鉴权，`{}`；触发只读状态核验，不执行付款 |

报价有有效期，一份报价只能创建一个订单；同幂等键/同报价重试返回同订单和令牌，不同输入冲突。保存令牌与订单号；令牌相当于订单查询凭据，避免分享。

当前路线范围（实际是否可报价仍读取 `/config` 的 `available` 与 `reason`）：

| routeId | 网络 / chainId | 资产 / 精度 | 手续费币 |
|---|---|---|---|
| `ethereum-usdt-hypercore` | Ethereum / 1 | USDT / 6位 | ETH |
| `ethereum-usdc-hypercore` | Ethereum / 1 | USDC / 6位 | ETH |
| `arbitrum-usdt-hypercore` | Arbitrum One / 42161 | USDT0 / 6位 | ETH |
| `arbitrum-usdc-hypercore` | Arbitrum One / 42161 | USDC / 6位 | ETH |
| `base-usdc-hypercore` | Base / 8453 | USDC / 6位 | ETH |
| `optimism-usdc-hypercore` | Optimism / 10 | USDC / 6位 | ETH |
| `polygon-usdc-hypercore` | Polygon PoS / 137 | USDC / 6位 | POL |
| `bsc-usdt-hypercore` | BNB Chain / 56 | USDT / 18位 | BNB |
| `tron-usdt-hypercore` | Tron / 728126428 | USDT / 6位 | TRX |
| `solana-usdc-hypercore` | Solana / 792703809 | 原生 USDC / 6位 | SOL |

全部目标为 HyperCore 默认 Perps USDC；首项为默认路线。链+token合约身份见共享审核表 `shared/route-registry.ts` 与 [场景清单](SCENARIO-COVERAGE.md)。`Route.gasSymbol?` / `assetNote?` 提供费用币和资产来源说明，不能把USDT0、Binance-Peg、原生USDC与USDC.e混同。未审核链/币不接受任意输入。

新公开 `Quote.protocolOrderId?: string` 是服务端重算并验证 solver 签名后的 **协议 order hash（bytes32）**；新 EVM / Solana 报价必须提供，并与付款 calldata 中的 order hash 一致。它不是应用 `quote.id`、应用 `order.id`，也不是 Relay 查询用的 `requestId` / `Order.providerOrderId`。旧 Tron 持久订单可缺少此字段。`providerData` 仍仅供服务端使用，不属于公开报价或订单响应。

EVM 钱包交易为 `kind="evm"`、审核路线的 `chainId`、原生 `value="0"`，付款来自该路线指定token；原生币仅用于钱包执行的gas。`approval` 指定本单代币、固定 spender 与精确金额，是否先清零由审核token策略与当前额度决定；原生USDC直接精确授权。应用不要求无限授权。

Solana 交易为 `kind="solana"`、`chainId=792703809` 和 `instructions`；当前只允许一条经过账户权限与金额核验的 deposit 指令，没有 `approval`。客户端自行获取最新主网 blockhash 构建交易，不接收不透明待签交易。`txHash` 为 base58 编码的 64 字节签名（最多 88 字符），严格保留大小写；API 字段名保持兼容。

EVM 报价不把供应商 `timeEstimate=1` 当成总到账时长，不返回该值作为 `estimatedSeconds`；通过 `warnings` 提醒最终确认及本应用核验可能约 15 分钟或更久。其他路线的 `estimatedSeconds` 也是提供方估计，不含全部核验、更不是付款成功凭证。源金额按路线真实6或18位，HL 目标账本按 8 位精度独立核对。

状态含义：
- `awaiting_signature`：尚未记录付款交易。
- `source_pending`：已取得哈希，按原路线等待 相应 EVM 链最终确认、Tron 固化或 Solana finalized 及匹配核验；EVM 收据成功还不够，需核对 canonical/finalized 区块、付款交易与精确来源token Transfer。
- `bridging`：来源付款已核验，结算/兑换处理中。
- `verifying_credit`：继续等待本订单可归属的HL Perps入账记录。
- `completed`：满足来源和目标账本核验，包含入账金额和证据。
- `attention`：需要核查的异常，不等于资金已退回，也不应再次付款。
- `expired`：未付款报价过期；若其实已广播，仍可补交原交易哈希继续追踪。

后台会在重启后恢复在途跟踪。客户端无需持续在线；连接失败后应查询原订单，不能自动再发一笔付款。

服务端RPC运营配置为 `ETHEREUM_RPC_URL`、`ARBITRUM_RPC_URL`、`BASE_RPC_URL`、`OPTIMISM_RPC_URL`、`POLYGON_RPC_URL`、`BNB_RPC_URL`、`SOLANA_RPC_URL`，默认公开端点见env样例；运行值不进入客户端。新报价先核对链、finalized、合约代码与token decimals，成功缓存60秒、失败15秒；单token/网络失败独立关闭其路线。旧单跟踪继续严格核验。请求体不存在自选RPC字段；不记录带令牌的URL。软件和只读联调不代替用户实际签名/到账验收，本轮新增功能未执行公网部署。


## 订单核验查询时间（2026-10-15）

`Order.trackingCheck?: { attemptedAt: string; succeededAt?: string; result: "ok" | "unavailable" }` 为服务器写入的可选字段，兼容已有订单；时间均为ISO8601。

- `attemptedAt`：最近一次实际来源/路由状态查询结束时间。
- `succeededAt`：最近一次成功完成该查询的时间，失败保留之前的值；从未成功则缺省。
- `result="ok"`：取得并处理了查询结果，包括仍pending或明确attention。**不表示资金到账。**
- `result="unavailable"`：最新查询未完成，保留已确认资金步骤；不能推断转账失败或自动重付。

纯GET恢复、没有来源hash、已核实完成订单的刷新不会生成新查询时间。成功接受hash的来源核验会记录实际查询；被拒绝的无关hash不会覆盖本单记录。`updatedAt`只是订单记录写入时间，不能代替最后成功查询时间。历史字段缺省须显示未知；浏览器成功取回旧Order不代表后端刚重新查链。

低于历史已确认阶段的供应商结果不会回退资金步骤，但会刷新查询元数据并明确结果不一致。到账仍使用原按单金额、目标hash与HyperCore证据校验；本字段不参与付款权限。
