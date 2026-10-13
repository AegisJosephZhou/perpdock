# 后端实现与审查回执

2026-10-12。后端已落盘，可由 root 集成。生产入口只调用真实 provider，测试 fixture 仅在 `tests/backend.test.ts`。

## 实现

- `server/security.ts`：精确 BigInt 金额、来源哈希规范化、随机订单 ID、HMAC 派生稳定订单令牌、令牌哈希常数时间比较；生产强制稳定 `ORDER_TOKEN_SECRET`，开发持久化权限 0600 的随机密钥。
- `server/store.ts`：SQLite WAL/FULL、参数化 SQL、报价与私有 providerData、订单、追加事件、幂等键哈希、轮询计划持久化。订单 token 只存 hash；同 quote 与幂等键重试可恢复原令牌，重启不丢失；密钥变更会拒绝启动。
- `server/order-service.ts`：验证报价输入/输出绑定、限额/精度/有效期、原子订单创建、授权隔离、来源交易验证后关联、同单并发去重、单向状态推进、迟到交易恢复、HyperCore 入账证据门槛、后台重启恢复与退避。不执行付款或退款。
- `server/app.ts`：严格 schema、16 KiB JSON 限制、同源/CORS、Bearer 权限、IP 限流、requestId、无敏感参数日志、`no-store`、收敛 CSP、安全上游错误映射。
- `server/index.ts`：真实 provider 接线、生产源站校验、显式代理配置、后台 worker、关闭处理、监听失败不会误报已启动。

## REVIEW.md 逐条响应

1. 目标 `expectedReceive/minReceive/creditedAmount` 按 8 位解析，来源 Tron USDT 保持 6 位。回归覆盖 8 位目标报价与少 1 个最小单位的不足额入账。
2. completed 同时要求 `creditedAmount >= minReceive`、合法目标 hash、证据 `type=hypercore_credit` 且 reference 精确绑定 `recipient:destinationTxHash`；provider success、余额变化、无关证据均不能完成。completed 后冻结。
3. 仅将 `UpstreamError` 已知 code 映射为固定安全中文消息/HTTP 状态，不回显上游原文；未知错误维持安全 502。
4. CSP `connect-src 'self'`。`TRUST_PROXY_HOPS` 仅可省略或设 1；默认完全不信任 X-Forwarded-For。设 1 时部署必须保证唯一入口是可信反向代理，后端监听地址/容器端口不得对公网直开；root 请在部署文档同步此条件。
5. 来源交易唯一键按 `tron:mainnet` 或 `evm:<chainId>` 与规范哈希组成，不能用更换 routeId 绕过；新增同链不同 routeName 回归。只有最终核验过的来源交易才占用唯一键：尚未被链节点看到的 pending hash 仍会持久化与轮询，但不能让无关订单抢占真实付款人的交易。新增 pending 抢占防护回归。
6. test 的 vi.fn 返回值已显式标注 `Promise<TrackingUpdate>`，不关闭 strict。

## 验证

- `npx tsc -p tsconfig.server.json --noEmit`：通过。
- `node node_modules/vitest/vitest.mjs run tests/backend.test.ts --configLoader runner --reporter verbose`：17/17 通过，含真实 Express loopback HTTP 边界测试。普通沙箱禁止本机 listen，已通过工具批准以临时 127.0.0.1 端口运行；无外部访问、无资金动作。
- 默认 Vitest config bundle loader 在本机 sandbox 的 esbuild 配置加载阶段挂起；`--configLoader runner` 可立即运行。root 如统一测试也遇到挂起可采用该参数；不是改成跳过测试。
- 全仓 `npm run typecheck`：前端组完成类型修复后，2026-10-12 审查轮次已全仓通过。

## 上线约束与未验证项

持久卷、数据库备份与原 `ORDER_TOKEN_SECRET` 必须一起保留；首版仅单实例。`PAUSE_NEW_ORDERS=true` 禁止新报价/新单，已有订单继续跟踪，重试幂等创建仍恢复原订单。该变量为进程启动配置，修改后需重启。

完成真实钱包签名、Tron 广播、Relay fill 与 HyperCore ledger 同 hash 入账的资金闭环验证前，本轮只证明后端状态与安全边界，不宣称完成资金验收。上游 unknown/timeout 必须继续显示未确认，不能自动退款或重付。证据不符合保守门槛时停留 verifying_credit，由运营按链上证据核查。

## P2-1 持久游标与客户端 RPC CSP 集成完成

- `Store.patchQuoteProviderData` 将内部 adapter patch 浅合并至原 quotes.providerData，保留未修改的私有字段和全部公开报价字段。补丁仅接受有大小/层级限制的 JSON 对象，拒绝危险原型键、非有限数等异常值。
- `OrderService.refreshLocked` 在对应订单状态/证据已落盘之后保存 patch。若两次写入之间崩溃，最多重复只读回查，不会先跳过尚未处理的账本页。再次刷新/进程重启从 SQLite 恢复最新 cursor；不依赖内存游标。
- `providerDataPatch` 从不复制到 Order/Quote；当前所有公网输入 schema 均拒绝该字段，未知私有 patch 字段也不进入 HTTP 响应。
- 根据 root 纠正，CSP `connect-src` 已从 self 扩展为 self 加三个**明确**客户端主网 RPC origin：`https://api.trongrid.io`、`https://api.tronstack.io`、`https://tron-rpc.publicnode.com`。没有 `https:` 通配符。该 CSP 允许客户端 TronWeb 构造/查询时必要的主网 RPC 请求。
- 回归新增：SQLite 重新打开后 adapter 获取相同 cursor；未知私有字段不泄露、不覆盖公开 recipient；非法 patch 不改数据；HTTP 注入 patch 拒绝；CSP 三项精确白名单。
- `node node_modules/vitest/vitest.mjs run tests/backend.test.ts --configLoader runner --reporter verbose`：**19/19 通过**，仅本机测试 fixture。
- `npm run typecheck`：本轮通过。

P2-1 的 ledger 分页算法由协议组拥有；本组已完成持久化接线，并复核协议与独立审查测试 25/25 正常通过，原预期失败已转为普通回归。详见 SECURITY-REVIEW.md 末尾复核回执。
