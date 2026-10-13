# 多链场景独立协议复核

审查人：protocol_architecture。日期：2026-10-12。范围为 `client/wallets.ts`、`shared/route-registry.ts`、`shared/types.ts`、`client/api.ts`、`client/payment.ts`、`scripts/live-smoke.ts`、`scripts/production-smoke.mjs` 及相关回归。只读取前端全局恢复锁的调用关系；App 的完整交叉核验仍由 risk_security 负责。未修改其他 owner 的业务或测试文件，未连接钱包、签名、广播或触碰现有运行库。

## 需 root 收口：P2-SR1 日志脱敏回归未进入目标分支

- 位置：`tests/live-smoke-logging.test.ts:25` 的 config fixture 缺少 `walletType`；`scripts/live-smoke.ts:34` 现按选中路线的 `walletType` 校验报价交易类型。
- 独立执行结果：`create-failure` 和 `credential-mismatch` 两项均提前因 `'tron' !== undefined` 失败，未走到原本要核查的订单创建失败／幂等令牌不匹配断言。这不是已观察到令牌泄漏，但使既有脱敏回归失去覆盖并令测试集失败。
- 最小修正：给该 Tron route fixture 补 `walletType: 'tron'`；建议同一 fixture 明确设置 `SMOKE_ROUTE_ID: 'tron-usdt-hypercore'`，避免继承操作员环境中的其他路线导致测试漂移。保留“不含两个假令牌”的断言，并确认两个子进程各到达自己的预期错误消息。不得通过删除消息断言或吞失败放行。
- 根因是多链 smoke 合同变化后的旧 fixture 不完整，无需修改生产脚本的正确路线类型校验。

## 已核验且未发现新的阻断问题

1. **链、资产和精度**：钱包把 config 路线再次与编译入包的审核 registry 比对；routeId、chainId、token、decimals、symbol、depository 均绑定。付款 calldata 校验 payer、token、BigInt amount、非零 protocolOrderId，并规范 ABI 重编码比较，不接受附加尾部数据或不规范地址填充。BSC 最末一位 18 位小数的回归保留为 `10000000000000000001n`，未经过 Number。
2. **授权策略**：最新版 `approvalPolicy` 明确区分 USDC `exact` 与审核 USDT/USDT0 `reset-if-needed`；五条 USDC 在旧非零不足额度时只批准一次精确数量。USDT 类每一步授权都重新核对账户、链、期限、Gas 和成功回执，并读回实际额度。足够授权不额外发交易。Tron 旧行为保持。
3. **钱包发现和 pin**：EIP-6963／legacy 多钱包可显式选择；成功连接后使用同一 provider。晚到 provider 不擅自请求账户，显式选择拒绝不回退到另一钱包。发现函数已加入同步公告重入保护。未知链仅按审核 registry 的公开 RPC／浏览器／Gas 币元信息添加，再实读 chainId。
4. **付款前置核验**：余额、allowance、源链原生币余额、当前调用 estimateGas/gasPrice 均在付款前读取；零 Gas、余额不足、错误估值、账户／链／到期变化阻止 `eth_sendTransaction`。费用估算明确只针对当前调用，L2 数据／结算费不是已保证的完整总预算。
5. **未知结果恢复**：付款只发送一次，不把上游 gas 字段转交钱包；返回 hash 后立即进入持久保存回调，不因等待回执或报价此后到期丢 hash。每单 Web Lock 与 signing marker 在发送前生效。非明确拒签的无 hash 错误保留 unknown；已有 hash 的上报失败不自动重付。App 的全局锁与每单锁使用不同名称，未看到同名嵌套死锁。
6. **严格恢复存储**：root 已将空字符串 fallback 修正为仅 null fallback。坏 JSON、畸形字段／重复 id、损坏独立 marker／读取失败抛错；孤立有效 marker 返回 orphanedIds。保留全部带付款标记订单，20 条限制只作用于未尝试付款记录。`loadSavedOrders` 的宽松显示结果没有被钱包付款协调器当安全依据；`savedOrderForPayment` 使用严格读取。
7. **共享元信息**：原生 USDC、Arbitrum USDT0、BNB Binance-Peg USDT 的名称和精度有区别；不把 USDC.e 或旧 OP USDT 加入同名通用资产。公开 registry 不含服务端配置的 RPC 密钥。旧 Tron 和 Ethereum routeId／订单类型保持兼容。
8. **生产 smoke**：从编译 registry 遍历八条 EVM 加 Tron，任一路线关闭即失败；每条均查真实报价、协议 id、类型、EVM chain/value、无误导总完成秒数、未签订单、访问令牌隔离与幂等恢复。专属临时数据库、随机回环端口、子进程重启、备份和隔离还原不写现有应用库。断言不把 bearer token 放入失败 diff，子进程输出只用于内部控制。脚本结论明确无 Docker 启动、钱包签名或资金端到端验收。

## 独立执行证据

执行：

```sh
npx vitest run --configLoader runner tests/multichain-wallet.test.ts tests/ethereum-wallet.test.ts tests/wallet-context.test.ts tests/wallet-execution.test.ts tests/local-payment-state.test.ts tests/payment-recovery.test.ts tests/live-smoke-logging.test.ts
```

结果：7 个文件中 6 个通过；**137 项通过、2 项失败**。失败仅为上面的日志测试 fixture 过时；不能将本轮报告写成全部通过。此命令只跑隔离测试，未访问真实钱包或现有服务器。源链后台另一个 ownership 的最新针对性回归为 119 项通过，详见 `SCENARIO-BACKEND.md`，不与本处重复计数。

## 验收界限

本报告证实代码约束及模拟 provider 分支；真实 RPC／报价验证证实路线当时可读、可报价。二者均不等于已实测具体手机／硬件钱包、Web Locks 在某钱包内置浏览器受支持，或资金已从九条路线到达 HyperCore。最终仍应保留“协议及只读验证通过，钱包资金流程待本人验收”的口径。可恢复记录的保护边界是当前浏览器同源 storage；不声称覆盖用户清除数据、另一设备或别的网站发起的独立付款。

## Root 收口追加

2026-10-12：P2-SR1 已补完整 fixture 的 `walletType: 'tron'`，并在测试子进程显式指定 Tron routeId；两项日志脱敏回归现均进入各自预期失败分支并通过，未放松消息或凭据保护断言。最终全工程 Node24 Vitest 为15文件、345项全部通过。本段是修正后的验证结果，上方137通过/2失败保留为原独立审查发现记录。
