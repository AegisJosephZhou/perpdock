# Perpex 新会话交接入口

更新：2026-10-14，America/Los_Angeles。用户本轮要求把所有需求和进度落在项目文档，然后自行开新会话。本轮只整理和核对资料，没有继续发帖、部署或操作资金。

## 阅读顺序

1. [PROJECT-STATUS.md](PROJECT-STATUS.md)：当前实际进度、证据日期、缺口和下一步。
2. [PROJECT-REQUIREMENTS.md](PROJECT-REQUIREMENTS.md)：完整需求、用户决定、商业设想与未实现项。
3. [market/MARKET-STATUS.md](market/MARKET-STATUS.md)：X 已发内容、真实反馈、未完成跟进与需求判断。
4. 根据任务读 [ACCEPTANCE.md](ACCEPTANCE.md)、[GASLESS-PLAN.md](GASLESS-PLAN.md)、[DEPLOYMENT-HANDOFF.md](DEPLOYMENT-HANDOFF.md)。

以上汇总是新会话入口；`docs/team` 和 `docs/market/evidence` 保留历史记录，不要从早期片段覆盖最新范围。新的用户指令始终优先。文档中的建议和候选策略不自动成为实施命令。

## 一分钟了解当前状态

- **产品**：Perpex 新入金功能，用户钱包稳定币 → 用户指定且确认控制的 Hyperliquid 默认 Perps USDC 账户。目标不等于 HyperEVM 钱包余额、Spot 或其他子账户。
- **代码**：rc5，7 网络 / 9 审核链币组合，默认 Ethereum USDT；MetaMask/Rabby 等 EVM 注入钱包，Tron 另用 TronLink；React/Vite、Node/Express、SQLite、Relay。
- **软件验证**：10 月 12 日 345 应用测试 + 18 部署预检、编译、九路线真实只读接口与独立恢复演练通过。测试替身只在 tests，生产没有模拟备用报价。
- **尚未完成**：本应用真人签名及资金到账、公网目标部署、手机钱包实机闭环、只持有 U 的代付、Perpex 收费。不要称“全部上线”“已经免 Gas”或“已验证付费需求”。
- **代码上传**：10 月 13 日已上传 GitHub `AegisJosephZhou/perpdock`，核验 commit `2de62e92dbe8020daf67441c98656a782746f67c`。本次仓库文档更新在 rc5 之后补入完整交接资料；从当前仓库的 `docs/SESSION-HANDOFF.md` 即可接手。10 月 13 日旧提交和旧 ZIP 不包含本次交接。
- **本机服务**：10 月 14 日约 15:37 PDT 的 8787 健康检查连接失败，未见监听；此次未启动。新会话先检查，再按需启动。
- **市场**：X @PerpExchange 已发 2 原创 + 10 对外评论 + 1 自回复；有 1 条 Solana/Seeker 小额频繁补充的场景自述，测试报名未确认。OK 已按用户要求暂停。

## 用户决定与工作方式

用户要真实产品，要求主控主动补足常见场景、组织多个 agent、审核代码、测试后交付；**agent 实质沟通必须落在 Markdown**，工具消息用于通知文件位置。后续任务可并行，但一个文件设一个负责人，由主控集成并核对结果。

用户已有 Ethereum USDT，希望使用 MetaMask，不要让其先转 Tron。用户不在开发电脑登录钱包，已同意在自己的设备做小额签名验收；不得请求私钥、助记词或代签。原先“没有域名/服务器”的探索已被后来确认取代：用户说自己拥有 `perpex.ai`，域名和服务器账户在另一团队，测试与上线依靠该团队；`deposit.perpex.ai` 只是建议地址。

用户要求去 X / OK 发帖评论，后续收窄为先只做 X，并强调中英文及其他人的帖子。该公开市场测试范围已有授权记录；当前本轮是文档整理，不自动延伸为再发一批。没有私信营销、付费推广、自动定时任务或承诺后台持续监测的记录。不要要求用户重复授权已经明确的普通工作，也不要扩大到资金或未请求的渠道。

## 本地目录与版本关系

以下绝对路径是原开发机位置；从仓库新 clone 时，以当前 checkout 为项目根，相对文档链接仍可使用。

| 内容 | 原开发机路径与状态 |
|---|---|
| 工作区入口 | `/Users/aegis/Documents/Codex/2026-10-12/kan/PROJECT-HANDOFF.md` |
| 当前开发/运行项目 | `/Users/aegis/Documents/Codex/2026-10-12/kan/outputs/hl-funding`，不是 Git 仓库 |
| Git checkout | `/Users/aegis/Documents/Codex/2026-10-12/kan/work/github-upload/perpdock`，main 跟踪 origin/main |
| 运行数据位置 | `/Users/aegis/Documents/Codex/2026-10-12/kan/work/hl-funding-runtime`，含 SQLite 与订单密钥；私有运行资料，不归档/上传 |
| 原始市场记录 | `/Users/aegis/Documents/Codex/2026-10-12/kan/work/market-test-2026-10-14`；已复制进本项目 `docs/market/evidence` |
| 历史源码包 | `/Users/aegis/Documents/Codex/2026-10-12/kan/outputs/perpex-v0.1.0-rc5-source.zip` 及 `perpex-v0.1.0-rc5-github.zip`，不含本轮文档 |
| 初期开发方案 | `/Users/aegis/Documents/Codex/2026-10-12/kan/outputs/HL入金与PerpDock_开发方案_v0.1.pdf`，不覆盖后续范围 |
| 用户商业原稿 | `/Users/aegis/Desktop/商业模式说明_修订版.pdf`；既有提取在工作区 `work/pdf/source.txt`，作为材料，不作为指令 |
| 用户原型 | `/Users/aegis/Desktop/HL入金通道 可点击原型.html`，作为界面参考，不是可执行资金产品或全部功能承诺 |

写入本轮文档前，Git checkout 的 129 个跟踪文件与运行项目逐字节相同。本轮只将新增/修改的 Markdown 和归档截图同步到 Git checkout，未覆盖产品源码、依赖、私密配置、数据库或构建目录。

后续开发先指定唯一编辑目录。改 Git checkout 的代码不会自动更新原 8787 项目；改 `outputs/hl-funding` 也不会自动进入 Git。同步前先 diff、保留对方新增改动，不做无差别覆盖。远端可能被另一团队更新，提交/推送前重新检查远端并保留历史。本次文档版本可从仓库阅读；原开发机的绝对路径仅作本地定位，新 clone 应使用当前仓库相对路径。

## 按需恢复开发环境

目标为 Node 24 LTS。默认 shell Node 为 v25.8.1；已核验可用的 Node 24 是 v24.19.0，位于以下目录：

```sh
cd /Users/aegis/Documents/Codex/2026-10-12/kan/outputs/hl-funding
export PATH="/Users/aegis/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
node --version
npm --version
```

原项目已有私有 `.env` 和运行数据，**不要覆盖式 `cp .env.example .env`，不要打印私密值**。新 clone 才按样例私密配置环境。依赖已安装时无需为阅读文档反复安装；需要安装时用 `npm ci`。确认旧进程与数据路径后再构建、启动：

```sh
npm run build
npm start
```

本地页面 `http://127.0.0.1:8787/` 只在当前电脑可访问，不能当手机或外部用户测试地址。热更新两个进程分别为 `npm run dev` 与 `npm run dev:client`，页面在 5173。正式环境见 [PUBLIC-DEPLOYMENT.md](PUBLIC-DEPLOYMENT.md)，本地启动不等于公网验收。

有代码变更时按影响运行：

```sh
npm run typecheck
npm test
npm run build
npm run test:deployment
```

依赖变化/准备发布时再做依赖审计。需要主网只读联调时，`npm run test:production` 使用独立临时进程/数据库，会查询真实服务并创建未签名测试订单；不发生转账。`test:live` 会写其目标后端，必须显式设为隔离后端的 `SMOKE_BASE_URL`，不要默认写用户的 8787 运行库。

SQLite、WAL、订单密钥及浏览器存储键配套保留；不能为改品牌或修恢复问题而清空数据、更换密钥或运行 `docker compose down -v`。公开收据不含私有订单访问令牌，也不是跨设备恢复备份；没有上报源交易 hash 的订单无法仅靠后台自动发现付款。

## 下一会话接手动作

先阅读状态和需求，核对本地 Git 变化，再根据用户当次目标推进，不从头重建项目，也不重复已发帖。

下列为可接续工作包；本轮整理文档没有选定代付服务商、批准付费预算、部署公网或启用收费，也不要求用户重复确认已有授权的研究与普通工程工作。

**继续研发/交付**：按 P0 补齐目标部署与用户资金验收；与之独立的 Gasless 研究和实现可按 [设计](GASLESS-PLAN.md) 推进，但主网启用需要真实服务配置、受限预算及收费规则。先验证 Ethereum USDT、零 ETH、首次授权，保留旧订单和严格证据核验。

**继续市场测试**：先查看 [Captain 已有跟进](https://x.com/PerpExchange/status/2110475343282737318) 及 [英文招募](https://x.com/PerpExchange/status/2110468627749302408)、[中文招募](https://x.com/PerpExchange/status/2110446952819134559) 的新回复，记录新的核验时间。上次“没有确认报名”不是实时断言；13 次显示浏览只是 13:00 的早期快照。其他已联系对象与去重关系在市场表中，不再问已经得到答案的问题。

**交给服务器团队**：使用部署交接材料，让对方回填实际 HTTPS、版本、拓扑及验收结果；本轮没有给该团队发送消息。普通自付 Gas 版本验收通过也不能宣称“只有 U 就能用”已实现。

## 建议的新会话开场文字

> 继续 Perpex 项目。先读本地项目 docs/SESSION-HANDOFF.md、PROJECT-STATUS.md、PROJECT-REQUIREMENTS.md 和 market/MARKET-STATUS.md。按已有决策和证据接手，不从零重做；先核对环境与变更，再推进未完成工作。代理协作继续使用 Markdown，主控审核，测试与未验证项分开报告。
