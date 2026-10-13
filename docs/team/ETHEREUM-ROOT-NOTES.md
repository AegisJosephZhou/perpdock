# Ethereum rc5 root notes

## 真实报价与公共链配置

2026-10-12T22:35:01Z root已成功取得真实EthereumUSDT→HyperCore100USDT报价，主网只读无签名，无资金操作。原始公开快照位于：
- /Users/aegis/Documents/Codex/2026-10-12/kan/work/ethereum-qa/chains.json
- /Users/aegis/Documents/Codex/2026-10-12/kan/work/ethereum-qa/quote-100.json

链1protocol.v2.chainId=`ethereum`，depository=`0x4cd00e387622c35bddb9b4c962c136462338bc31`，rpc公开metadata为 https://ethereum.publicnode.com；USDT合约=0xdac17f958d2ee523a2206206994597c13d831ec7、6位。

步骤为approve + deposit，全部kind transaction；item.data为 from/to/data/value="0"/chainId=1，另含gas/maxFeePerGas/maxPriorityFeePerGas（不要盲信/原样转发费用）。deposit选择器e8017952，ABI仍depositErc20(address,address,uint256,bytes32)。输入100USDT；expected99.837994/min98.839614USDC，目标8位；price仅快照。

## finality展示必须诚实

Relay本次details.timeEstimate=1（1秒）。我们的Ethereum源核验若坚持finalized，UI不能把该值说成总到账时长！建议Ethereum provider返回不带estimatedSeconds，并加清楚警告：Ethereum交易最终确认及本应用入账核验可能需要约15分钟或更久，HL可能先到账；不代表用户需要重付。不要硬编码进度计时或保证时间。

官方依据 https://ethereum.org/roadmap/single-slot-finality/ （2026-07-23更新）说明当前block finality约15分钟。以最终链上结果为准。

root负责更新生产smoke以同时覆盖双路线、metadata/RPC实测和部署文档；等待代理确定ETH RPC环境变量名称后补env/Compose。当前资金模型无需shared改动，evidence.type原为任意string可新增ethereum_finalized_transfer。

## 公开协议字段确认

已在 shared/types.ts Quote 添加可选 `protocolOrderId?: string`，仅用于服务端重算验签后的协议order hash（p.orderId/computed，**不是** q.requestId）。provider正常返回此字段即可，由publicQuote自动保留并随order持久化；新Ethereum报价必须填写。旧Tron订单缺字段继续兼容。backend与wallet按这个明确语义绑定calldata bytes32。

## 前端完成后的文档任务

product_delivery 请继续更新 README.md、docs/API.md（若存在）、docs/CONTRACT.md（若存在）、docs/OPERATIONS.md、docs/DEPLOYMENT-HANDOFF.md 的当前功能说明与运行手册：Ethereum 主网 USDT → HL 默认 Perps USDC 为新增默认路线，Tron仍可用；EVM用MetaMask/Rabby和ETH gas，Tron用TronLink/TRX；不是支持任意币种/任意网络；新公开Quote.protocolOrderId为协议order hash；Ethereum最终确认可能约15分钟或更久，没有总时长承诺；真实签名/资金验收待用户；仍未公网部署。ETHEREUM_RPC_URL默认https://ethereum.publicnode.com，运营配置HTTPS RPC，禁止把含API令牌的URL写到日志/客户端。

仅改这些用户文档与本组报告，不改代码/env/Compose/ACCEPTANCE；不要写全量最终测试数字，root稍后填。旧rc4历史结果保持历史，不改成rc5已验收。部署交付包将命名perpex-v0.1.0-rc5-source.zip。前端完成报告已有，继续文档不需要等钱包组。

## 钱包实现后交叉复核

risk_security 请在后端组确认最终落盘后独立审查 relay.ts + chain/ethereum.ts + shared + App.tsx 的集成信任边界与既有订单恢复，报告结论到 ETHEREUM-SECURITY.md。发现P1/P2请先在md写清具体文件/问题/建议，root统筹修复；可完善自己wallet文件问题。root已看钱包代码：waitEvmApproval 的 blockNumber 仅排除 null，没有排除 undefined/畸形回执，建议用有效hex quantity检验包含区块，receipt字段同时做防御式验证（错误应关闭而非视为成功）。仅钱包receipt检查相关必要回归。其余root进行生产smoke和部署配置验收。

已补两份env样例/Compose ETHEREUM_RPC_URL。浏览器仅custom钱包provider读取EVM RPC，不增加CSP连接域。
