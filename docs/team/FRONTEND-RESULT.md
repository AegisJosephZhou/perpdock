# 前端实现与验证结果

## 交付内容
- 完整中文 React 页面：真实路线与余额、付款/接收地址分别确认、实时报价/费用/最低到账/倒计时、订单创建、精确授权、签名付款、订单进度/凭证/本机恢复，响应式桌面与手机布局。
- 本版可用资金路线以服务端为准；没有 mock quote、假余额、随机成功状态或运行时 fixture fallback。
- TronLink 构造参数经 depositErc20 解码匹配付款人/代币/精确金额，再构造真实 TriggerSmartContract；验证主网 HTTPS 节点、地址、单合约动作、零 TRX/无 TRC10、费用上限。通过 TronWeb txCheck 检查编码与 txID，签名后重新检查交易意图。
- EVM injected 钱包为接收地址连接及接口已支持的补充来源提供连接/换链能力；当前服务端未开启 EVM 资金路线，界面不会自行宣称可用。
- 只有 hypercore_credit 证据才显示完成；目标账户显示 Perps 权益与可提余额，不以余额变化推断本单成功。
- 跨标签 Web Locks + 锁内本机记录/服务端状态重查 + 同组件同步锁；签名前持久化独立付款标记，hash 获得即存，网络上报失败后可重新上报同笔交易。窗口刷新不会自动付款，未知签名结果阻断再次付款。

## 已运行
1. npm run typecheck：通过。
2. npm test -- --run tests/wallet-context.test.ts：8/8 通过。
3. npm run build：通过；Vite 主 chunk 541.21 kB（gzip 167.52 kB），仅体积提示。

## 集成注意
- CSP 必须允许 TronWeb 对经过验证的主网 RPC origins 发请求，详见 FRONTEND.md 的 CSP 集成必需项。
- 钱包实现需较新的 TronLink，支持 isAddress 与 utils.transaction.txCheck；缺失时安全阻断并提示更新。
- Web Locks 需要安全上下文（HTTPS，localhost 开发例外）。不支持时付款功能安全阻断。
- 交易构造固定最高 fee_limit=150 TRX，页面在签名前明确展示；实际资源成本以钱包为准。

## 未完成的真实验证
- 本 agent 的 cua 浏览器不可用：createBrowserTab(iab) 返回 Browser is not available，listBrowsers 返回空数组；未宣称浏览器视觉/交互验收通过。root 可使用其可用的浏览器环境继续检查。
- 没有请求钱包账户权限、签名或广播；真实 TronLink 精确授权/用户付款、源链与 HyperCore 本单 credit、刷新恢复需最终小额主网验收。
- 新增资金防重与构造字段校验应继续由 root 的独立测试覆盖；导出测试入口见 FRONTEND.md。

## 最终回归补充
新增 tests/payment-recovery.test.ts 共20项，全部通过，资金编排提取至 client/payment.ts，App 使用相同生产路径。类型检查通过。已修复无 approval 报价假设足额的问题，现始终读实际 allowance；不足则重新报价。测试详情见 FRONTEND.md。
- 提取与 allowance 修复后的 `npm run build` 再次通过：453 模块，主 chunk 541.93 kB / gzip 167.75 kB，仅体积提示。
