# Ethereum 双路线前端实施记录

## 接口协作

前端继续使用现有 `connectEvm(): Promise<string>`、`getEvmChain(): Promise<number>`、`switchEvmChain(chainId)`、`evmProvider()`、`sourceBalance(route, source)`、`getAllowance(quote, route)`、`approveExact` 和 `sendPayment` 签名，不修改 wallets/server/shared。付款继续进入已有 `executeOrderPayment`，不修改存储键和付款恢复锁。

界面把链不匹配视为阻断状态，并在发报价/建单前重新读取钱包 chainId；账户/网络事件失效报价及确认。EVM 付款钱包连接后，仅在未填写接收地址时填入该地址，始终要求用户手动确认。选择路线同时清理报价、余额、授权额度、两类地址确认与旧幂等创建上下文；旧订单仍以订单路线恢复，未知付款仍停留恢复页。

本组仅运行双路线组件测试及必要的原 UI 回归，不运行全量套件或更新最终验收数字。尚未连接真实钱包、签名或广播。

## 已落盘改动

- `client/App.tsx`：按真实 config 顺序选择首个可用路线；Ethereum chainId=1 清楚显示主网、MetaMask/Rabby、ETH 授权和付款费用。Tron 保留 TronLink、TRX 与原资源说明。没有硬编码两条可用路线或填入余额，路线和费用仍由 API/钱包响应驱动。
- 首次连接 EVM 付款钱包时，空白 HL 地址填入同一 0x 地址但不勾选任何确认。用户预先填写的其他地址不覆盖；不同地址仍要求两次确认。「填入已连接地址」复用连接，不再次请求 MetaMask 连接。
- 不匹配网络时不读来源余额/额度，报价、建单、授权、付款入口均阻断；提供切换 Ethereum 主网按钮。报价和建单前额外读取 chainId，即便钱包漏发 chainChanged 也不会继续请求 API；请求序号阻断切链后晚返回的旧报价。
- 选择路线清理余额/错误、报价、授权状态、地址确认和旧创建幂等上下文；未签名旧订单恢复后仍固定在原路线，未知付款只展示原恢复流程，没有切换路线或再次支付按钮。
- 接收地址帮助文字按 Tron/EVM 区分。处理时间标为「路由提供方处理估时」，明确不含源链最终确认与本应用核验；实际 quote warnings 在报价和进度页都显示。Ethereum provider 应依照 root 约定省略 Relay 的 1 秒估时并给出 finality warning，前端没有编造倒计时到账进度。
- `tests/ethereum-ui.test.tsx`：新增 13 项隔离组件回归，真实 App、报价上下文验证与存储选择逻辑执行，外部钱包/RPC 请求只在测试中替代。

## 本组实际验证

命令（Node 24.19.0）：

```sh
/Users/aegis/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run --configLoader runner tests/ethereum-ui.test.tsx tests/redesign-ui.test.tsx
```

结果：**2 文件 / 38 测试通过**，包括新增 13 项与原 25 项 UI 回归。覆盖默认双路线、同地址未确认、不同地址两次确认、错误网络和切换、缺失切链事件、晚返回报价、建单前再次核对链、路线切换、独立 availability、旧 Tron 订单恢复、订单付款的网络阻断、unknown 恢复锁、ETH 费用与 provider finality warning。

当前完成前端组件实现，可供主控与安全组交叉复核；后端/钱包代理仍并行实现，最终全量类型检查、构建、真实双路线只读联调和浏览器验收由主控统一执行。未更改 styles/wallets/server/shared/payment/api，到账凭证与实际完成态判定保持原语义。

## 后续用户文档同步完成

按主控新增所有权更新 `README.md`、`docs/API.md`、`docs/CONTRACT.md`、`docs/OPERATIONS.md` 和 `docs/DEPLOYMENT-HANDOFF.md`：明确 Ethereum USDT 默认路线与原 Tron 路线、钱包和 ETH/TRX 区别、两条具体链币限制、旧订单恢复、协议 order hash 与 requestId 的区别、Ethereum 最终确认延迟和无总时长保证、仅服务端 HTTPS `ETHEREUM_RPC_URL` 及不泄露含凭据 URL 的要求。交付目标名称更新为 `perpex-v0.1.0-rc5-source.zip`，资金与公网待验收状态保留。

README 的115项/18项记录明确标成 rc4 历史结果，没有改写成 rc5 最终通过数字；未编辑 ACCEPTANCE、env、Compose 或其他代码。另核对5份文档均包含双路线/RPC说明，全部本地链接目标文件存在。

钱包组严格 protocolOrderId/calldata 校验落盘后，额外以相同 Node24 命令仅运行 `tests/ethereum-ui.test.tsx`：**13/13 通过**，无需修改原测试fixture或前端代码。最终全量结果仍由主控填报。

新增的用户场景覆盖建议继续写入 `docs/team/SCENARIO-FRONTEND.md`，等待主控批准共享 registry 与实现所有权后再落代码，不以规划代替真实路线支持。
