# 后端工作包
负责人 risk_security。先读 TEAM.md、../CONTRACT.md。负责 server/**（不含 providers/**、chain/**）及相应 tests/backend*。
Node TS Express + node:sqlite WAL，真实持久化 quotes/orders/events，SQL参数绑定，Bearer高熵订单访问令牌存hash，幂等重试不可丢token（需稳定/安全恢复方案，文档解释），请求 zod校验、速率限制、same-origin与CORS配置、body限额、上游timeout错误清晰。不记录secret。
真实 provider contract 由 protocol_architecture 实现，先做依赖注入便于单测（仅测试mock，生产不得mock）。后台重启恢复待追踪订单，轮询退避，不重复执行资金动作。提交tx不可凭hash随便完成；匹配from/recipient/amount/calldata，未最终确认保持pending，不未知结果瞎标失败。完成需真实HL credit证据，不单靠余额差。实现安全运营：环境暂停新单、健康状态、受保护订单概览可选、日志requestId。验证所有边界、精度、状态回退/重放、幂等与权限隔离。
需与协议负责人经Markdown对齐函数。写 BACKEND-RESULT.md 和运行测试。

## 后端接口对齐提案（实现中）

拟采用 `FundingProvider` 注入：getRoutes(): Promise<Route[]>；getQuote(input: QuoteInput): Promise<QuoteDraft>；verifySourceTransaction(quote, txHash): Promise<SourceVerification>；trackOrder(order): Promise<TrackingUpdate>；getAccount(address): Promise<AccountSnapshot>。

请 root 在 shared/types.ts 固化以下语义，或通知本文需适配：
- QuoteDraft = Omit<Quote,'id'>，provider 自己给 expiresAt（真实报价有效期），后端不能覆盖为更长。
- SourceVerification = { valid:boolean, confirmed:boolean, reason?:string, evidence?:Evidence[] }。valid=false 表示明确不匹配；未检索到/未最终确认返回 valid=true, confirmed=false，并保留 source_pending，不能称失败。
- TrackingUpdate = { status?: Order['status']; statusMessage?:string; sourceTxHash?:string; destinationTxHash?:string; providerOrderId?:string; creditedAmount?:string; evidence?:Evidence[] }。后端仅接受单向状态转换；completed 必须存在可归属于订单的 HyperCore credit evidence（建议 type='hypercore_credit'，reference 非空）。协议跟踪抛网络错误只记录暂时查询异常，不假终态。

令牌与幂等：订单令牌由稳定服务器 HMAC 密钥 + 随机订单 ID 导出，只存 SHA256 hash。同幂等键+同 quoteId 重试可重算同 token；重启也不丢失。密钥优先环境变量，开发默认在数据目录创建权限0600持久文件；生产要求显式稳定密钥。幂等键需高熵、16–128字符，保存其hash，不记录明文。订单创建不执行资金动作。

恢复：SQLite WAL 持久化 quotes/orders/events；扫描 source_pending/bridging/verifying_credit/attention 且有 sourceTxHash 的订单，指数退避。过期 quote 仅在新建订单阻断；已创建 awaiting_signature 的订单到期可以标 expired，但迟到真实 tx 仍允许核验和跟踪，不能丢失资金。

文件计划：server/store.ts、server/order-service.ts、server/app.ts、server/index.ts、server/security.ts、tests/backend.test.ts。生产无 mock fallback。
# 2026-10-12 root：恢复开发，P2-1 集成
请读 SECURITY-REVIEW.md 与 PROTOCOL.md 最新回复。shared TrackingUpdate 已增加 providerDataPatch。你负责 Store.patchQuoteProviderData 与 OrderService 收到内部 adapter patch 后合并持久化 quotes.providerData；不能在 public Quote/Order/API 中泄露。请实现并测试重启持久游标、未知字段不泄露；协议组实施游标算法。另请修复 server/app.ts CSP connectSrc 为 self + https://api.trongrid.io + https://api.tronstack.io + https://tron-rpc.publicnode.com，三项均为 client 主网 RPC 白名单，不允许任意 https:。加 HTTP 头回归，完成写 BACKEND-RESULT.md。
