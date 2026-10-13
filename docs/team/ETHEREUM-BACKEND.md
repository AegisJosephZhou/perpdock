# Ethereum 来源协议实现

## 已核实输入与接口约定（2026-10-12）

已读取 root 公开主网样本 work/ethereum-qa/quote-100.json 与 chains.json，报价确为 Ethereum USDT → HyperCore 默认 Perps USDC，含 approve + deposit。官方 Relay [输入核验文档](https://docs.relay.link/references/api/api_core_concepts/input-validation) 的 Ethereum 部署地址与独立 /chains 相同：`0x4cd00e387622c35bddb9b4c962c136462338bc31`。USDT pin `0xdAC17F958D2ee523a2206206994597C13D831ec7`，6位。

钱包协作契约：付款 ABI `depositErc20(address depositor,address token,uint256 amount,bytes32 id)`，selector `0xe8017952`。参数依次等于 quote.sourceAddress、上述 USDT、quote.amountBaseUnits、公开 quote.protocolOrderId。该公开字段取服务端独立重算并验证固定 solver 签名后的协议 orderId，**不是 requestId**。付款交易 chainId=1、to 为上述 depository、value=`0`。后端丢弃 Relay 给的 gas/maxFeePerGas/maxPriorityFeePerGas，不盲目转发钱包。授权只接受 approve(固定spender,精确金额)，钱包可依据当前 allowance 先执行 USDT approve(0)。新 EVM 报价总带精确 approval 元数据，哪怕上游无需 approve step，以便钱包重新检查当前 allowance。

服务端 RPC 配置名：`ETHEREUM_RPC_URL`，默认 `https://ethereum.publicnode.com`；仅运营配置、必须 HTTPS、禁止 URL 凭据/fragment，不接受用户提交 URL。每次请求沿用15秒超时、4MB响应限制、禁止重定向。不会在日志/错误信息回显 URL 或凭据。

源付款必须经过 RPC 主网 chainId=1、交易/receipt/USDT Transfer、finalized block 与 canonical block/hash 的联合核验；最终确认前保留 source_pending。官方 [JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/) 与 [finality](https://ethereum.org/roadmap/single-slot-finality/) 说明 finalized 语义与当前约15分钟确认；应用不采用样本 Relay timeEstimate=1 秒作为总时长，EVM报价不返回 estimatedSeconds，并提醒可能约15分钟或更久。

## 已实现与验证

`server/providers/relay.ts` 已提供 Ethereum 优先、Tron 保留的双路线；独立来源配置 gate，单条主网 depository 或 Ethereum RPC 配置异常不会关闭另一条。支持 EVM/Tron 的报价验签、独立订单哈希、精确输入/目标/退款地址、无未知 calls、已审核付款合约与 calldata/approval；报价展示的金额绑定签名订单。EVM付款只透出五个已审核字段，丢弃上游 gas 估算指令。已公开 protocolOrderId，并保留旧Tron无此字段兼容。

`server/chain/ethereum.ts` 已实现 HTTP/RPC 错误 fail-closed、chainId=1、精确 tx/from/to/input/value、成功receipt及其hash/block/from/to、唯一目标形态 USDT Transfer、log所在交易/区块、canonical block包含tx、finalized高度与同高hash一致性。tx/receipt/区块未检索到或最终确认尚未覆盖时 pending；错误交易/资产/区块/重组记录不能推进。RPC可信服务仍是本实现信任边界；不是独立轻客户端或多供应商共识。

trackOrder 根据 quote.routeId 分派；Relay状态originChainId须与本单一致；HL默认Perps入账强证据、持久扫描游标和恢复逻辑原样保留。Ethereum完成证据类型为 `ethereum_finalized_transfer`，Tron仍是 `tron_finalized_transfer`。

公开真实fixture已保存 tests/fixtures/relay-ethereum-quote.json 和 relay-ethereum-chains.json；只读快照包含公开示例地址，不含用户资金/密钥。测试的RPC交易/区块为tests内构造，不代表真实付款验收。

2026-10-12 首轮针对性运行 `npx vitest run --configLoader runner tests/ethereum-protocol.test.ts tests/protocol.test.ts`：**2文件/79测试通过**（新增Ethereum62 + 原协议17）。覆盖真实签名与官方SDK差分、23种报价篡改、22种交易/回执/日志/区块篡改、6种pending、上游故障、配置隔离、源链分派、老Tron、缺少实际HL入账不得完成。root还需最后统一typecheck/build/全量及临时数据库真实报价smoke。

随后 `npx tsc --noEmit` 通过。已只读检查 order-service 交易hash规范化/持久化以及 Store 的source chain identity：现有实现支持EVM hash与chain1，无需此owner改动。真实签名、广播、审批确认及到账依然待用户本人执行；本组没有连接钱包或写8787数据库。

Tether自己的 [Supported Protocols](https://tether.to/en/supported-protocols/) Ethereum Network 段直接给出 USD₮ 合约 `0xdac17f958d2ee523a2206206994597c13d831ec7`，与 Relay /chains 一致；6位来自真实 /chains 元信息，root将RPC eth_call decimals复核纳入主网smoke。以上来源访问日期均为2026-10-12。
