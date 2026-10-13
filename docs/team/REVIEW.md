# root 审查记录

## 最终集成结论（2026-10-12）
下列实施问题均已修复并经回归；CSP 首轮 self-only 建议已纠正为 self + 三个精确 Tron 主网 RPC，避免阻断实际钱包 HTTP 调用。额外交叉审查修复历史 ledger 回查窗口/持久分页，以及无 approval 时重新读取 allowance。开发代理错误拦截 /api.ts 的白屏也已修复，并在浏览器复核。

最终 npm test 6文件88项全部正常通过，无 skip/it.fails；strict typecheck、Vite/服务端构建、生产audit=0通过。Node24 生产重启和真实只读报价/备份恢复通过。已人工审阅合约调用绑定、签名后复核、拒签/未知状态、存储先行、防重复付款和端到端证据门槛。测试范围与未实测限制在 ../ACCEPTANCE.md。当前没有已知未解决的审查阻断项，但未进行真实钱包资金验收，不能把此结论称为独立专业安全审计。

## 后端首轮（请负责人修复后记录测试）
1. OrderService.quote 的目标 minReceive/expectedReceive 和 applyTracking.creditedAmount 固定6小数，但协议组明确 Relay HyperCore虚拟USDC是8小数单位。共享展示字符串可至8位，后端校验改为8位（源USDT仍6位），并测8位目标金额。
2. completed 除正金额和hypercore_credit证据外，后端应再次检查 creditedAmount >= quote.minReceive，并确保evidence.reference绑定本单recipient及destinationTxHash，防适配器未来回归。
3. HTTP errorHandler目前不识别UpstreamError，安全的输入错误会变502；建议只映射协议组固定安全code/message/httpStatus，不暴露未知上游原文。
4. CSP connectSrc https:允许任意外联，当前客户端仅使用同源后端和injected钱包provider，建议收敛为self。生产反向代理trust proxy配置要明确，不盲设true；可允许显式一跳且后端仅暴露于可信proxy，部署文档说明。
5. 来源交易唯一键当前routeId:hash，将来新增同链route可重复认领；本版只有一条路线仍建议按chain身份，而非route命名作为唯一键。

## 协议首轮（请负责人检查并记录）
- 订单最大滑点参数字符串 '100' 的单位必须用官方文档确认，不可推测1%。quote已拿到2%最小额，UI需如实展示min，不承诺固定净额。
- findPerpsCredit只接受internalTransfer/send目前是保守设计，但需要找到真实HL ledger shape证明这类Relay fill会出现这些事件；同provider hash匹配确实进入默认Perps才完整。用历史只读真实记录做验证，不使用余额差绕过。
- 去除报价warning里硬编码“版本尚未完成资金验收”，改配置或正式发布文档；首版签名前仍应说明主网与资金风险，不把内部工程状态写死在长期产品流程。

## 前端首轮
1. validateQuoteContext对Tron sourceAddress/sourceToken使用toLowerCase，Base58是大小写敏感；按route.walletType分开比较，Tron需原字符串一致并让tronWeb校验格式。
2. requireTronMainnet除hostname之外要求https和默认443，避免允许同名http/custom port节点。
3. validateTronBuilt请同时拒绝call_token_value、token_id，限制fee_limit上限并检查不存在多余资金动作；签名后可再次validateTronBuilt，避免钱包返回与原意图不同对象。
4. 目标账户字段perpsUsdc来源是marginSummary.accountValue，应在UI显示“Perps账户权益”，不是“USDC现金余额”，避免含PnL时误导。
5. 订单凭证下载不得包含accessToken/幂等key；另提供明确本机恢复方式。报价到期应在批准授权之后、付款之前再次拦截（代码当前已实现，需回归测试）。

## 首轮 typecheck（文件仍在实现中）
- client/App.tsx 尚未写入，预期中。
- client/wallets.ts BrowserProvider extends EIP1193Provider 的可选 on/removeListener 与 viem 定义不兼容；用 Omit<EIP1193Provider,'on'|'removeListener'> 并在custom边界正确处理，或遵循完整接口。
- tests/backend.test.ts 多个 vi.fn 返回对象 status 被推为 string；标注返回 Promise<TrackingUpdate> 或使用字面量as const，不关闭strict。

## 前端第二轮（付款幂等，阻断项）
- 两个浏览器标签页可同时持有awaiting_signature旧订单并触发付款。需要跨标签页付款互斥（推荐navigator.locks按order.id独占，进入锁后重读localStorage的submission和服务端order，已有提交/签名状态就禁止），同组件另加同步ref防重复点击。付款前必须先成功持久化signing标记；其他页通过storage事件刷新状态。不能只靠React busy按钮和6秒轮询。
- wallet changed事件应递增quoteRequest.current，使进行中的旧quote响应失效；correctWallet的Tron比较也需要大小写敏感。
- App useState<SavedOrder>接受undefined、useRef需要初值的问题请修复。生产构建不允许跳过typecheck。
