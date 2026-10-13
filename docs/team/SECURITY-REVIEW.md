# 独立协议安全审查

审查者 risk_security，2026-10-12。范围：`server/providers/**`、`server/chain/**`、`tests/protocol.test.ts`；未修改协议组实现。新增独立审查回归 `tests/security-review.test.ts`。

结论：未发现可在当前已固定 solver 签名和固定 depository 前提下替换收款人/币种/金额而通过校验的 P0/P1 漏洞。发现的 1 项 P2 入账恢复问题已修复并复核通过（见末尾复核回执）。真实用户签名闭环仍是独立放行条件，测试不能代替。

## P2-1：将 Relay updatedAt 误当作 fill 时间，会永久漏查已入账的历史交易

- 代码位置：`server/providers/relay.ts:136` 至 138；`server/chain/hyperliquid.ts:19`。
- 触发：Relay 订单完成后，状态数据被重新更新（例如元数据修正），`updatedAt` 比真实 HL 入账晚超过 5 分钟；或旧订单恢复时可选 updatedAt 缺失。当前从 `updatedAt - 300000` / `Date.now() - 300000` 开始查账本，会把已知目标 hash 对应的真实 credit 排除在时间窗口之外。以后每次刷新仍查询错误窗口，订单永远 verifying_credit。
- 官方依据：Relay [Get Status](https://docs.relay.link/references/api/get-intents-status-v3) 将 updatedAt 定义为数据最后更新时间，并非链上 fill 时间。Hyperliquid [Info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) 提供时间区间分页规则，时间范围查询最多 500 个元素/不同区块，需用最后时间戳继续查询。
- 复现：`tests/security-review.test.ts` 的 `P2-1 recovers...` 使用真实历史 HL ledger fixture，把状态 updatedAt 推迟 10 分钟；模拟 API 正确按查询窗口过滤后，预期 completed，实际 verifying_credit。该测试目前以 `it.fails` 明确标注**预期失败**，不能把总测试绿视为已修复。
- 建议：保留当前近端窗口作为快速路径；未命中时从 quote/source 时间开始按有界窗口/分页回查，或用目标 hash 的可靠时间元数据定位。回查需要持久游标或可继续执行的边界，不得无限大重查压垮 API。仍必须绑定同 hash、recipient、default Perps USDC 与 minReceive，不可用余额差替代。修复后把该测试的 `.fails` 去掉，并补缺失 updatedAt/分页上限回归。

## 非阻断改进与边界

- `relay.ts:74` 仅限制 refunds 的链、币种、收款人；允许空 refunds、任意合法 hex 的 refund extraData 以及 uint32 范围内的 deadline。这些字段均被 order hash 和已固定 solver 的签名覆盖，外部攻击者修改会失败，故本次不把它描述为签名绕过。首版若只支持现有两种空 extraData 退款语义，建议在产品策略层显式拒绝未知 refund extraData，并记录接受的 deadline/缺失退款政策。
- `relay.ts:101` 的 120 秒是本应用主动缩短的签名窗口；协议期限来自 `output.deadline`（真实快照约 7 天）。官方 [Input Validation](https://docs.relay.link/references/api/api_core_concepts/input-validation) 指定 output.deadline 为订单期限，minimumAmount 是协议结算下限。请文档和 UI 不把 120 秒说成 provider 保证的报价存活时长，也不将本地过期当成资金失败。本地窗口短于签名期限的实现本身是保守的。
- `tron.ts:34` 的 SHA256 验证 raw_data_hex 的 txID，同时从节点 JSON 读取调用；未独立 protobuf 解码并重新绑定 JSON，也未验证区块包含证明。这是依赖官方 TronGrid HTTPS/SolidityNode 的 RPC 信任边界，不是无需信任的轻客户端。本轮没有发现普通客户端能控制这些固定官方 RPC 响应的路径。
- HL 查询依赖官方 API 与 Relay 状态，正确拒绝 spot/HIP-3/HYPE 账本事件；单笔 default-Perps credit 必须足额。若将来支持分笔结算，需要可归属聚合，不能直接放宽条件。当前未知事件类型保持 verifying_credit 是有意保守行为。
- `PROTOCOL.md` SDK 审查回复写 HyperCore USDC 为“15-byte”，但当前 literal 有 32 个 hex 字符，是 **16 bytes**。实现和 SDK差分正确，需修正文档数字，避免后续重写时补齐/截断。

## 已验证的安全检查

1. 独立 `/chains` 配置与固定 Tron depository；单 input/output，固定 Tron USDT 与 HyperCore USDC 标识；来源付款人、目标地址、源数量与 UI 金额互相绑定。
2. 本地 orderId 重算与已固定 solver 的 EIP-191 签名；Tron depositErc20 精确 selector/参数/长度与 orderId 一致；授权只给精确 amount；不接受额外 calls/fees/步骤、native/TRC10 附带价值。
3. Tron 主网 Base58Check；读取固化交易和执行 receipt，要求成功与受信 USDT Transfer 的 from/to/amount；未检索到保持 pending，HTTP 错误抛出而非伪造失败/成功。
4. Relay success 仍须具有同 source hash 和 destination hash；HL ledger 同 hash、recipient、足额默认 Perps USDC 才完成。真实历史证据证明正常 send 形态，未把它当成本应用 depositErc20 的资金验收。
5. 固定 HTTPS endpoints、禁重定向、15 秒 abort、4 MB 响应上限、JSON/schema 校验、安全状态码；未将上游响应 body 暴露给客户端。
6. 独立 getOrderId 与官方 SDK 0.0.147 的字段顺序、动态数组、Tron 21 bytes、HyperCore 原始 bytes、uint256 最大值、uint32 deadline、refund顺序/extraData 等差分通过。未知版本和多余执行 side effects 明确拒绝。

## 测试结果

- `node node_modules/vitest/vitest.mjs run tests/protocol.test.ts tests/security-review.test.ts --configLoader runner --reporter verbose`：新增 P2 复现前 19/19 通过。
- 新增 P2 后独立文件：6 正常通过 + **1 预期失败**。失败不是上游服务异常；是可重复的时间窗口逻辑缺陷。
- `npm run typecheck`：2026-10-12 本次审查过程中已全仓通过。
- 全部独立测试仅用 tests 下 fixture / fetch stub，无网络资金操作，无真实钱包签名，无付款。

## P2-1 修复复核回执（2026-10-12 19:23Z）

已复核协议组新实现：扫描边界基于原 quotedAt，不再以 Relay updatedAt 推导 fill 时间；每轮最多4页，inclusive last timestamp 续查；hash集合变化/非法游标重置，扫描结束回卷以恢复迟到索引。分页没有放宽 exact hash、recipient、默认 Perps USDC 与最小额门槛。

已复核后端接线：内部 `providerDataPatch.creditScan` 合并存储在原 quotes 私有数据，重启后恢复；公开 Quote、Order、HTTP 中均不输出该字段，不接受客户端注入。保存顺序为先记录处理结果再保存游标，崩溃最多重复只读查询。

`node node_modules/vitest/vitest.mjs run tests/protocol.test.ts tests/security-review.test.ts --configLoader runner --reporter verbose`：**25/25 正常通过，无预期失败**。覆盖 updatedAt 晚更新、updatedAt 缺失、500结果上限、每轮4页/后续恢复、迟到索引、同时间戳不可推进。另后端 **19/19 通过**，包含 SQLite 重开游标、私有字段隔离与 HTTP 注入拒绝。

因此关闭 P2-1。保留可见限制：若上游返回无法分页推进的同时间戳截断数据，当前保守保持核验中，不能伪造完成；可作为人工排查事项。真实资金闭环验收仍未由这些测试替代。
