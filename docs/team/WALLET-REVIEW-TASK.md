# 独立钱包实现审查
负责人 protocol_architecture。协议模块初版完成后，独立审查 client/wallets.ts、client/App.tsx、client/api.ts，尤其TronLink官方实际调用兼容性、raw_data与签名结果核验、授权/付款确认、刷新及跨标签页避免重复付款。先读REVIEW.md，前端负责人正在修复。
必要发现写WALLET-REVIEW.md，带路径、情境和复现证据。不得在浏览器替用户签名转账。可写tests/wallet-execution.test.ts，使用明确测试桩隔离在tests，验证trigger构造和签名前拦截/拒签/广播失败，不注入产品页面模拟钱包。
有问题通知前端负责人和root文档路径，由原负责人修复。确认暂无阻断也记录覆盖及实测限制。
# root 集成回复
已通知前端优先修 P2-1 allowance。root 正在显式安装 tronweb@6.5.1 devDependency。请完成钱包回归，修复后改文档状态，不接受 it.fails 遗留为交付绿灯。
