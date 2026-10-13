# UI 改版独立回归与安全审查

负责人 risk_security；仅拥有 `tests/redesign-ui.test.tsx`，不修改运行时前端。使用 jsdom + ReactDOM/act，所有 API/钱包替身仅存在 tests 中，禁止真实签名。

## 集成请求

- root：当前 Vitest include 仅 `tests/**/*.test.ts`，请扩为覆盖 `.test.tsx`（例如 `tests/**/*.test.{ts,tsx}`）；jsdom 安装由 root 统一执行。
- 前端：测试优先用可访问按钮文字、label/input id 和页面 h1，不要求额外运行时 mock 或测试入口。请保留金额、接收地址输入的 label/htmlFor；两主页面有清楚的标题；历史面板/返回按钮有独立可访问名称。完成时通知 REDESIGN-FRONTEND.md 位置。

## 覆盖计划

1. 未连接、非法/未确认收款地址不可报价，钱包余额未知时快捷比例禁用。
2. 真实接口读数渲染；25% / 50% / 全部使用来源精度取整、钱包余额与单笔限额。
3. 动态 quote 的 expected/minimum/provider 与费用展示，创建 awaiting_signature 仍在入金页。
4. source_pending、local unknown/已签名 marker进入进度且不能再次付款；completed 缺 HyperCore credit 证据不得显示已核实到账。
5. 历史恢复及两页导航；钱包操作过程中不可切单/丢弃恢复记录；拒签可重试与过期不签名沿用现有真实支付路径测试。

当前前端正在改版，完成后记录运行结果与可复现发现，不把旧布局断言失败当成新功能缺陷。

## 测试已落盘，等待新版 App 完成后执行全组

`tests/redesign-ui.test.tsx` 已建立隔离 jsdom/ReactDOM 测试；api/钱包外联方法在该文件内替换，实际 App、api 本机持久化、executeOrderPayment、地址/报价验证和付款锁顺序仍执行。测试存储使用独立内存实现，不使用 Node25 的文件 localStorage，也不触及用户浏览器。

已按 REDESIGN-ROOT-QA.md 加入 completed 异常响应场景：缺证据、缺 creditedAmount、低于 minReceive 1 个8位小数最小单位、非法目标 hash、证据收款人不一致、证据 hash 不一致，均不得宣称已到账，也不能回显上游误导 statusMessage。另增加明确拒签后重试、双击仅一个付款流程、操作中历史入口锁定、已提交历史订单与另一草稿金额/地址分离。

测试框架预检已通过 unknown + api.order 失败的保守恢复用例。新页面完整断言待前端文件落盘后执行；当前不能称整组已通过。

## 最终新版验收：25 项通过

依据 `REDESIGN-FRONTEND.md`「新版已落盘，可开始独立测试」对应最终 App / CSS 版本执行。命令 `node node_modules/vitest/vitest.mjs run tests/redesign-ui.test.tsx --configLoader runner --reporter verbose`：**1 个测试文件、25 项用例全部通过**。随后 `npm run typecheck` 通过。测试首次运行出现的 3 个选择器失败来自测试没有读取 header 按钮 `aria-label`；已改为优先可访问名称，未改运行时代码。

关键行为已直接在实际 React App 与实际 executeOrderPayment 上验证：

- 未连接钱包、无效地址、未显式确认收款账户不能报价；余额未知不能点比例按钮；余额 `100.000007` 的 25% / 50% 分别为 `25.000001` / `50.000003`，全部受服务端单笔上限约束。
- 预计到账、最低到账、不同币种费用直接来自隔离 API 响应；awaiting_signature 无付款标记保持入金页。授权接收本单完整 quote，授权后仍须独立点击付款。
- source_pending、bridging、verifying_credit、attention 恢复后不出现新付款入口；source_pending 的第一步为正在确认，未标记已完成。
- signing / unknown 且无 hash 保持恢复界面；unknown 遇 api.order 失败仍保留本机标记，不能重新创建或付款。
- 本机已有 hash、后台仍 awaiting_signature 或 expired：主标题均为「交易编号已保留，等待核验」，明确签名窗口到期不代表付款失败，继续核验只上报原 hash，不调用付款。协议组 P2-R1 的两种恢复状态已纳入用例并关闭。
- completed 的缺证据、缺 creditedAmount、低于最低到账额、非法目标 hash、证据收款人不一致、证据 hash 不一致六类异常，全部维持预计/核验状态，不显示「已核实到账」或「实际到账」，也不回显错误的 statusMessage 或 completed 事件成功文案。
- 合法完成态使用实际 creditedAmount；开始新入金后保留旧订单凭据。历史订单的金额与收款人来自该订单 quote，不混入另一草稿。
- 明确拒签且无 hash 后可重试；双击只调用一次付款；签名未返回时历史入口禁用；付款返回后持久保存 hash；过期未付款订单不能签名。

独立审查未发现需阻断本次 UI 改版的剩余问题。所有测试替身仅在 `tests/redesign-ui.test.tsx`，未新增运行时演示数据或签名旁路，本组未连接钱包、未发送资金。这里的通过仅覆盖组件行为和类型检查；真实浏览器布局、全组构建回归由 root 验收，真实 TronLink 签名与资金到账闭环仍需用户本人执行。
