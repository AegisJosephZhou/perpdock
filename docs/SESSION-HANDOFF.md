# Perpex 项目交接

更新：2026-10-15，America/Los_Angeles。本次提交包含10月14–15日研发增量与最新公开市场结论；推送结果以远端提交为准。

## 当前状态

Perpex 将受支持钱包内的稳定币，通过真实 Relay 路由转入用户指定并确认控制的 Hyperliquid 默认 Perps USDC 账户。已有七网络九条审核路线，默认 Ethereum USDT；技术栈为 React/Vite、Node/Express、SQLite。生产没有模拟备用报价或虚构到账状态。

10月14日新增当前钱包、账户和网络的只读能力检查，以及暂停 HTTPS 环境检查器。10月15日新增订单最后已确认步骤、独立查询时间、失败/断网保留事实和迟到响应防护。`trackingCheck.result="ok"` 仅表示查询成功，不表示资金到账；只有完整的本单来源与目标证据才能显示完成。

最新软件验证为 **462/462应用测试、40/40部署工具离线测试及TypeScript/构建通过**。10月14日的九路线主网只读联调是历史证据，10月15日没有重新访问真实主网接口。真人签名、资金到账、目标HTTPS/容器/恢复、手机钱包实机、真正零原生币付款及平台收费仍未验收或未实现。

市场累计本方16条公开内容；明确报名0、持续实质讨论0。Captain仍是一条历史场景自述及条件性弱兴趣，不能据此认定已经验证HL入金需求。公开设计意见是参考，商业拓展或测试网招募不能计入终端客户验证。详见[公开发现](market/evidence/FINDINGS-2026-10-15.md)。

## 阅读顺序

1. [PROJECT-STATUS.md](PROJECT-STATUS.md)：当前状态、证据日期和下一步。
2. [PROJECT-REQUIREMENTS.md](PROJECT-REQUIREMENTS.md)：用户目标、已实现范围和未实现事项。
3. [CONTINUATION-2026-10-15.md](CONTINUATION-2026-10-15.md)、[CONTINUATION-2026-10-14.md](CONTINUATION-2026-10-14.md)：两轮研发和验证边界。
4. 按任务读 [ACCEPTANCE.md](ACCEPTANCE.md)、[API.md](API.md)、[CONTRACT.md](CONTRACT.md)、[GASLESS-PLAN.md](GASLESS-PLAN.md) 或 [DEPLOYMENT-HANDOFF.md](DEPLOYMENT-HANDOFF.md)。
5. 市场任务从 [MARKET-STATUS.md](market/MARKET-STATUS.md) 和[发布台账](market/evidence/PUBLICATION-LOG.md)接续，先核对已有对话，避免重复联系。

旧文档保留各自日期与范围。早期Tron-only或rc1–rc4计划不覆盖当前九路线实现；新用户指令优先。文档中的方案和候选策略不自动成为执行命令。

## 已确定的产品边界

- 用户已有Ethereum USDT，希望使用MetaMask；无需先转Tron。Tron路线另用TronLink。具体钱包支持以实机验收为准。
- 用户在自己的设备与钱包签名；不向开发者或服务器提供私钥、助记词，不代签或代发资金。
- “只持有U”和平台收费是尚待落实的明确目标。当前能力诊断不会签名、升级账户或放开零原生币付款。
- 目标是默认Perps USDC，不以HyperEVM、Spot、总余额变化或供应商成功提示替代本单入账证据。
- 原订单和未知付款状态必须保留。不能清空数据、修改完成状态或让用户再付一笔来掩盖核验故障。
- 市场工作以X的中英文公开需求交流为既有方向，OK已暂停。公开帖子和设计意见不等于客户承诺、测试报名或付费验证。

## 开发与验证

从当前Git checkout工作，使用Node 24 LTS；本轮验证版本为24.19.0。已有环境配置、数据库、备份和订单凭据由管理员私密维护，不进入源码仓库。新环境参考README和部署手册，不能用样例覆盖已有配置。

按改动影响运行：

```sh
npm run typecheck
npm test
npm run build
npm run test:deployment
```

`npm run test:production` 使用独立测试进程与数据库，读取真实外部接口并创建未签名测试订单，不发生付款。`test:live` 会写其目标后端，必须显式指向隔离环境，不能用于正在承载用户订单的服务。依赖审计和目标部署检查应另记实际执行时间。

协作保持一文件一负责人，任务、实现、独立审查和测试结论写入Markdown，由主控集成。提交前核对当前远端和本地变化，保留已有工作；GitHub代码更新不代表部署成功。

## 下一阶段

管理员提供暂停新单的HTTPS环境，并完成版本、TLS、端口、持久化、备份恢复及上游连通验证；之后安排用户本人小额普通路线验收。详细步骤见[部署交接](DEPLOYMENT-HANDOFF.md)。

独立研发可继续推进Gasless执行模式，但必须完整实现总费用合同、受限代付预算、批次恢复、新来源验证器及费用账务；先覆盖Ethereum USDT、零ETH、首次授权，不能通过删除Gas保护替代实现。

市场侧继续收集真实来源链币、钱包、金额/频率、卡点、替代方案及明确意向；以有效用户对话、完整费用下的自主试用和复用判断需求。现有样本不足以支持扩大投入或宣称已有客户。
