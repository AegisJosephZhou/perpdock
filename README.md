# Perpex · HL Funding

七个网络、九条审核稳定币路线 → 用户指定 Hyperliquid 默认 Perps USDC 账户的非托管入金应用。默认 Ethereum USDT，另含原生 USDC、Arbitrum USDT0、BNB Chain 映射 USDT 与 Tron USDT；详见 [场景与资产清单](docs/SCENARIO-COVERAGE.md)。

前端 React + Vite，后端 Node/Express，SQLite 持久化。实时报价与跨链结算接入 Relay；对应 EVM 来源链的最终确认交易、Tron 固化交易及 Hyperliquid 账本用于独立核验。生产代码不返回模拟报价、余额或虚构到账状态。服务端不保管用户私钥，也不代用户转账。

## 当前验收状态

rc5 本轮实现多链资产、钱包选择、Gas预检、手机/交易所指引、离线恢复及全本机未结清付款保护。最终软件测试、真实只读联调与审查证据见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。测试中的RPC替身只在tests，生产运行没有模拟备用报价。用户本人钱包签名和资金到账验收尚未执行，域名/公网服务也未部署。市场发布仍需目标环境与本人小额验收。

“只持有 U，无需准备原生手续费币”及 Perpex 平台收费目前仅完成 [实施设计](docs/GASLESS-PLAN.md)，尚未接入或启用。当前代码仍要求用户具备对应来源链的 Gas 或资源；上游报价中的费用不代表 Perpex 已有收费收入。


**给外部服务器/DNS团队：先读 [上线交接入口](docs/DEPLOYMENT-HANDOFF.md)。** 用户已有 perpex.ai，建议子域名 deposit.perpex.ai 待管理员配置；先提供暂停新入金的 HTTPS 环境，再让用户在自己的设备签名测试。

## 本轮界面

按用户原型方向完成单列界面，先选资产所在网络和币种，再选择实际检测到的钱包。添加真实原生Gas余额、链币合约说明、手机/交易所/未支持资产/已付款未到账帮助。主流程为「存入 Hyperliquid」与「入金进度」两屏，并有本机订单记录入口。付款/接收地址分别确认，报价展示真实净额及最低到账，费用与账户信息可展开查看。比例金额使用真实余额；仅有本笔可绑定的入账证据才显示实际到账。未知签名结果保留恢复入口，禁止重复付款。

界面证据以本轮 [验收记录](docs/ACCEPTANCE.md) 为准；历史原型截图不能替代本轮钱包或资金验收。

## 本地运行

要求 Node 24 LTS、npm，以及能够访问 Relay、各源链 HTTPS RPC、TronGrid、Hyperliquid 的网络。各链RPC配置键及默认公开端点见两份env样例；正式运行可由管理员配置自己的可靠 HTTPS RPC，不能接受访客提交的 URL，也不能把带 API 令牌的 RPC URL 输出到日志或客户端。

```sh
npm ci
cp .env.example .env
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

自动化测试的历史样本仅在 `tests/fixtures`，不会被生产 API 作为备用数据返回。完整 Relay settlement SDK 和 TronWeb 仅用于协议差分/钱包编码测试，不进入生产依赖。生产依赖审计为 0 个已知漏洞；全量开发依赖审计有 12 项已知问题（6 高、6 中），集中在测试 SDK 的传递依赖，详见验收记录。禁止以 `npm audit fix --force` 盲目降级协议 SDK。

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
