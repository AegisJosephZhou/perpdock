# Perpex · HL Funding

## 2026-10-15 WalletConnect 更新

本轮新增六个 EVM 主网的 WalletConnect 扫码连接，保留注入钱包与 TronLink；补充报价按钮禁用原因，并修复未记录付款的过期订单返回重新报价入口。配置与使用范围见 [WalletConnect 说明](docs/WALLETCONNECT.md)。

**519/519 应用测试、43/43 部署工具检查、TypeScript 与构建已通过。用户反馈 WalletConnect 连接测试成功；精确授权、小额付款及本单 Hyperliquid 默认 Perps 入账仍未完成资金验收。** 推送状态以远端提交为准。以下原有正文保留此前时点的记录；其中钱包连接范围、测试数量及相关待办以本节和 WalletConnect 说明为准。

**新会话 / 项目交接（2026-10-15）：先读 [交接入口](docs/SESSION-HANDOFF.md)。** 完整需求见 [需求总表](docs/PROJECT-REQUIREMENTS.md)，当前实际进度与下一步见 [状态表](docs/PROJECT-STATUS.md)，X 推广与线索见 [市场记录](docs/market/MARKET-STATUS.md)，钱包调研见 [研究索引](docs/research/RESEARCH-INDEX.md)。历史软件测试、真人资金验收、部署与商业验证分别记录；免 Gas 和平台收费尚未实现。

七个网络、九条审核稳定币路线 → 用户指定 Hyperliquid 默认 Perps USDC 账户的非托管入金应用。默认 Ethereum USDT，另含原生 USDC、Arbitrum USDT0、BNB Chain 映射 USDT 与 Tron USDT；详见 [场景与资产清单](docs/SCENARIO-COVERAGE.md)。

前端 React + Vite，后端 Node/Express，SQLite 持久化。实时报价与跨链结算接入 Relay；对应 EVM 来源链的最终确认交易、Tron 固化交易及 Hyperliquid 账本用于独立核验。生产代码不返回模拟报价、余额或虚构到账状态。服务端不保管用户私钥，也不代用户转账。

## 当前验收状态

本次提交包含 rc5 基础功能以及10月14–15日研发增量：只读钱包能力检查、暂停 HTTPS 环境检查器、订单已确认步骤、独立查询时间、失败恢复与迟到响应防护。10月15日 **462/462 应用测试、40/40 部署工具离线测试、TypeScript与构建通过**；10月14日九路线主网只读联调为历史证据，本日未重跑。详见 [验收记录](docs/ACCEPTANCE.md)。推送结果以远端提交为准。真人钱包签名、资金到账和目标公网部署仍未验收。

“只持有 U，无需准备原生手续费币”及 Perpex 平台收费目前完成 [实施设计](docs/GASLESS-PLAN.md) 和只读钱包能力检查，实际代付与收费尚未接入或启用。当前代码仍要求用户具备对应来源链的 Gas 或资源；上游报价中的费用不代表 Perpex 已有收费收入。


**给外部服务器/DNS团队：先读 [上线交接入口](docs/DEPLOYMENT-HANDOFF.md)。** 用户已有 perpex.ai，建议子域名 deposit.perpex.ai 待管理员配置；先提供暂停新入金的 HTTPS 环境，再让用户在自己的设备签名测试。

## 本轮界面

按用户原型方向完成单列界面，先选资产所在网络和币种，再选择实际检测到的钱包。添加真实原生Gas余额、链币合约说明、手机/交易所/未支持资产/已付款未到账帮助。主流程为「存入 Hyperliquid」与「入金进度」两屏，并有本机订单记录入口。付款/接收地址分别确认，报价展示真实净额及最低到账，费用与账户信息可展开查看。比例金额使用真实余额；仅有本笔可绑定的入账证据才显示实际到账。未知签名结果保留恢复入口，禁止重复付款。

界面证据以本轮 [验收记录](docs/ACCEPTANCE.md) 为准；历史原型截图不能替代本轮钱包或资金验收。

## 本地运行

要求 Node 24 LTS、npm，以及能够访问 Relay、各源链 HTTPS RPC、TronGrid、Hyperliquid 的网络。各链RPC配置键及默认公开端点见两份env样例；正式运行可由管理员配置自己的可靠 HTTPS RPC，不能接受访客提交的 URL，也不能把带 API 令牌的 RPC URL 输出到日志或客户端。

```sh
npm ci
test ! -e .env && cp .env.example .env
npm run build
npm start
```

打开 http://127.0.0.1:8787 可检查本地软件；用户本人钱包验收应在外部团队提供的 HTTPS 环境进行。EVM路线选择检测到的MetaMask/Rabby等注入钱包；手续费按网络准备ETH、BNB或POL。Tron使用TronLink与TRX。普通手机浏览器无注入时须在受支持的钱包浏览器打开HTTPS网址；本版无WalletConnect二维码连接。连接 EVM 付款钱包后，空白 HL 接收地址可填入同一 0x 地址，仍需手动确认归属；填写不同地址需要再次确认。不要向服务器输入助记词或私钥。

开发热更新可分别运行 `npm run dev` 与 `npm run dev:client`，访问 http://127.0.0.1:5173 。本地 `PUBLIC_ORIGIN` 留空即可使用两组本地地址。前后端通过 Vite 同源代理通信。

## 检查

```sh
npm run typecheck
npm test
npm run build
npm run test:deployment
npm audit --omit=dev
# 可选：仅指向已启动、未暂停的隔离测试后端，会写入未签名测试订单。
# SMOKE_BASE_URL 必须设为隔离后端的实际URL，不要指向用户运行库或暂停公网环境。
# SMOKE_BASE_URL=http://127.0.0.1:<隔离端口> npm run test:live
# Node 24：独立临时数据库，真实只读接口、生产进程重启与备份恢复。
npm run test:production
```

自动化测试的历史样本仅在 `tests/fixtures`，不会被生产 API 作为备用数据返回。完整 Relay settlement SDK 和 TronWeb 仅用于协议差分/钱包编码测试，不进入生产依赖。2026-10-12历史审计记录为生产依赖0个已知漏洞、开发依赖12项（6高、6中，集中在测试SDK的传递依赖）；10月15日未重新查询依赖审计，详见验收记录。禁止以 `npm audit fix --force` 盲目降级协议 SDK。

## 支持范围

- 九条具体路线，含6条EVM网络8种链币组合及Tron USDT；白名单、精度和品牌区分见场景清单，可用性由真实主网配置及RPC健康动态决定。
- 报价时验证来源币、金额、付款人、接收人、结算订单哈希、solver签名、授权对象与精确授权金额。
- 用户在对应的钱包内签名精确授权与付款；USDT 非零旧额度不足时，先清零、确认成功，再授权本笔金额。USDC无需额外清零；每次操作的原生Gas币按来源网络明确展示。
- 订单持久化、幂等创建、访问令牌隔离、源交易核验、进程重启恢复后台追踪。
- 只有源链付款及可归属的目标 Perps 账本记录同时满足条件，才显示到账。
- 单实例部署。当前不含出金、合约交易、钱包白标SDK、多租户结算或自动退款执行。

报价净额、最低到账与网络费均按实时服务结果展示。新账户费用、服务商范围与可用性可能变化，必须以本次报价与实际签名内容为准。Ethereum 核验等待来源交易最终确认，可能约 15 分钟或更久；HL 可能先到账，页面仍需完成本单证据核对，不能因此重复付款，也没有总到账时长承诺。[Ethereum 官方最终确认说明](https://ethereum.org/roadmap/single-slot-finality/)

本应用采用 120 秒签名窗口；尚未付款时窗口过期需重新报价，已广播的原交易仍继续核验。此窗口不是 Relay 协议退款期限，也不是链上最终确认期限。当前实现实际检测到的EIP-1193/EIP-6963注入钱包选择和TronLink路径；TronLink 需提供 `tronWeb.utils.transaction.txCheck`。实际钱包签名、到账及手机兼容覆盖仍待用户验收，手机布局测试不代表手机钱包已全面支持。

## 公网域名部署

外部团队操作入口见 [docs/DEPLOYMENT-HANDOFF.md](docs/DEPLOYMENT-HANDOFF.md)，精确配置和命令见 [docs/PUBLIC-DEPLOYMENT.md](docs/PUBLIC-DEPLOYMENT.md)。本次未访问现有服务器/DNS账户，也未发布公网；目标容器、HTTPS和目标机器恢复演练仍待执行。默认暂停新入金，目标环境通过后安排本人小额测试；不能将软件测试通过等同可以立即开放市场。

## 部署与运维

见 [docs/OPERATIONS.md](docs/OPERATIONS.md) 与 [docs/API.md](docs/API.md)。用户测试前设置稳定密钥、真实服务凭据、HTTPS入口和持久化备份。请勿清理含在途订单的数据卷。

团队的接口约定、工作记录和代码审查意见全部保存在 [docs/team](docs/team/TEAM.md)。

## 研发记录

- [2026-10-14](docs/CONTINUATION-2026-10-14.md)：只读钱包能力检查、暂停 HTTPS 环境检查器。
- [2026-10-15](docs/CONTINUATION-2026-10-15.md)：订单已确认进度、trackingCheck查询时间、失败恢复与迟到响应隔离。

真实 Gasless 执行、平台收费、目标 HTTPS 和用户资金验收仍未完成。市场判断见 [公开发现汇总](docs/market/evidence/FINDINGS-2026-10-15.md)：明确报名0，客户和付费需求尚未验证。
