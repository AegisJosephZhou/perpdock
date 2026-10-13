# 独立钱包实现审查

审查者 protocol_architecture；2026-10-12；范围 client/wallets.ts、client/App.tsx、client/api.ts。仅静态审查、官方接口核对与 tests 隔离测试；未在用户浏览器注入模拟钱包，未代替用户签名或转账。

## P2-1：无 approval 步骤时仍需读取实际 allowance（待前端修复）

`client/wallets.ts:getAllowance` 当前 `if (!quote.approval) return BigInt(quote.amountBaseUnits)`。Relay 在其报价时发现已有足额授权可以省略 approval，随后用户/另一标签页撤销授权，或其他付款消耗额度。付款前此分支仍声称足额并进入签名，可能导致链上 revert 与无谓资源费。`sendPayment` 虽调用 getAllowance 但无法发现该情况。

建议 Tron 当前路线始终从 route.sourceToken 合约读取 `allowance(quote.sourceAddress, quote.transaction.contractAddress)`，有 approval 时还应核验其 spender 相同；没有 approval 且不足时阻止付款并提示重新报价，不假设授权已经完成。将在 tests/wallet-execution.test.ts 写可重复隔离回归。

## 当前兼容性与既有修复

- 官方旧接口 `window.tronLink.request({method:'tron_requestAccounts'})` 仍为兼容保留；不能说当前代码一定不兼容 TronLink。但新文档推荐 `window.tron` 的 `eth_requestAccounts` 与 accountsChanged/chainChanged，以及 TIP6963 多钱包发现。本版只检测旧注入，可明确限定 TronLink 桌面旧兼容接口；现代注入单独支持可后续增补，不计本轮阻断。
- 官方签名拒绝为 `Error('Confirmation declined by user')`（无数值 code）；现 isWalletRejection 正确涵盖该形式。
- raw_data 内容、raw_data_hex、txID 在签名前捕获；签名后精确比对，并用 TronWeb 的 protobuf `txCheck` 绑定。这能拦截钱包原地修改同一对象，初步实现正确。
- App 已加入同步 actionInFlight、按 order.id 的 Web Locks、进入锁后重新读取服务端与本机、签名前持久化 signing、storage 同步。独立 per-order submission key 防止其他订单覆盖最近20项列表时抹去付款状态。两标签页复核仍待最终测试结论。

## 官方依据（2026-10-12读取）

- https://docs.tronlink.org/dapp/getting-started/ ：推荐现代 provider、TIP6963 与事件。
- https://docs.tronlink.org/plugin-wallet/active-requests/ ：兼容请求接口、签名结果、拒签形式。
- https://tronweb.network/docu/docs/Interact%20with%20contract/ ：读取 allowance 等合约方法；本地开发依赖实际 TronWeb 6.5.1 的 triggerSmartContract、utils.transaction.txCheck 与官方调用参数对照。

## 测试准备

计划在 tests/wallet-execution.test.ts 直接使用实际 TronWeb 6.5.1 的 trigger ABI 编码和 protobuf 序列化，只 stub 节点响应、用户签名及广播，避免“测试桩认可自己的编码”。它目前由 Relay dev SDK 间接带入。建议 root 将 `tronweb: 6.5.1` 显式加至 devDependencies，稳定钱包兼容回归的依赖声明（不增加前端运行时 bundle）。

## 最终复核与结果（2026-10-12 19:25Z）

**关闭 P2-1；本轮未发现遗留 P0/P1 资金安全阻断。** 前端已修复：即使 Relay 省略 approval，getAllowance 仍读真实 USDT allowance 并核验 depository；不足时付款/授权都阻断，要求重新报价。回归直接调用生产函数证明节点构造和签名尚未发生，不以模拟余额掩盖错误。

新增 `tests/wallet-execution.test.ts`：16/16正常通过；`npm run typecheck`：通过。测试在Node隔离环境运行，以实际 TronWeb 6.5.1 triggerSmartContract 编码器、protobuf构造/校验执行生产钱包函数；仅钱包签名返回、节点响应、广播、allowance是显式测试桩，全部位于tests，未注入运行页面。签名桩不是有效资金签名，也未使用私钥。

覆盖：真实quote calldata在TronWeb编码后逐字相同；旧额度先清零后精确授权；无approval后撤销授权；官方无code拒签；构造期间账户改变；签名弹窗期间quote过期；签名原对象被修改data/rawHex/fee/TRC10/Permission_id/第二合约；攻击者重算有效protobuf和txID仍因偏离原文被拦截；广播前持久化失败；广播拒绝保留hash且不自动重试；不一致的节点raw编码在签名前拒绝。

独立静态复核 `client/payment.ts`（从App提取的同一生产付款编排）：锁内读取最新本机submission与服务器状态，持久化signing成功后才调用钱包，hash持久化在Tron广播前完成。刷新/另一标签页看到signing、submitted、unknown均禁止新签名；无hash明确用户拒签才解除标记；无hash超时保持unknown。前端组 `tests/payment-recovery.test.ts` 直接覆盖该生产函数的竞争、刷新、存储失败和拒签恢复，未复制付款算法。原同组件ref保护继续保留。

### 真实验收限制

此结论是代码及隔离回归结论，不等于真实扩展、主网资源成本、真实签名和HyperCore入账已验收。本次未打开用户钱包签名，没有任何实际转账。市场开放前仍需用户在其TronLink中确认小额授权及付款、核实最终同hash默认Perps到账；当前前端明确主要支持TronLink桌面兼容注入，未承诺所有手机钱包/现代TIP6963-only环境。
