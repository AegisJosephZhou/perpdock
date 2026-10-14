# 新会话技术核对记录

核对人：protocol_architecture。核对日期：2026-10-14（America/Los_Angeles）。主项目：`outputs/hl-funding`。

本轮只读检查当前代码、场景清单、Gasless 设计、验收与运维文档；**没有重跑测试、联网报价、启动服务、读取私有环境或数据库、访问钱包、签名或转账**。下文的测试数字与运行结果均明确归属于 2026-10-12 的历史记录；本轮不证明当前进程在线、供应商今日可用或依赖今日仍无新增漏洞。Git 镜像及最终主文档由 root 统一核对。

## 1. 当前交付状态

当前代码是 **Perpex rc5 单实例非托管入金应用**：React/Vite 前端、Node/Express 后端、SQLite 持久化，通过 Relay 报价及结算，来源链与 Hyperliquid 账本另行核验。唯一已接入目标是用户指定地址的 **HyperCore 默认 Perps USDC**。本机软件及主网只读验证已有历史通过记录；真实钱包资金闭环、公网运行、Gasless 和 Perpex 收费均未完成。

“支持路线”表示已有代码与历史真实只读证据，不表示九条路线均由用户实际付款验收。当前 `/api/config` 可用性由运行时检查决定，不能从静态 `available: true` 或旧报价判断今天仍可执行。

## 2. 精确路线与钱包范围

默认选择 `ethereum-usdt-hypercore`。八条 EVM 路线以 [共享白名单](../../shared/route-registry.ts) 为准，Tron 以 [Relay 适配器常量](../../server/providers/relay.ts) 为准。

| routeId | 来源网络 / chainId | 实际资产 | 精度 | 来源 Gas / 资源 |
| --- | --- | --- | ---: | --- |
| `ethereum-usdt-hypercore` | Ethereum / 1 | Tether USDT | 6 | ETH |
| `ethereum-usdc-hypercore` | Ethereum / 1 | Circle 原生 USDC | 6 | ETH |
| `arbitrum-usdt-hypercore` | Arbitrum One / 42161 | USDT0；上游可能显示 USDT | 6 | ETH |
| `arbitrum-usdc-hypercore` | Arbitrum One / 42161 | Circle 原生 USDC | 6 | ETH |
| `base-usdc-hypercore` | Base / 8453 | Circle 原生 USDC | 6 | ETH |
| `optimism-usdc-hypercore` | Optimism / 10 | Circle 原生 USDC | 6 | ETH |
| `polygon-usdc-hypercore` | Polygon PoS / 137 | Circle 原生 USDC | 6 | POL |
| `bsc-usdt-hypercore` | BNB Chain / 56 | Binance-Peg USDT（BSC-USD） | 18 | BNB |
| `tron-usdt-hypercore` | Tron / 728126428 | 主网 TRC-20 USDT | 6 | TRX / 资源 |

共 **七网络、九个链币组合**；不能写成九条网络，也不能泛化为任意 USDT/USDC。USDC.e、Optimism USDT/USDT0、Base 上其他 USDT、Solana、原生 ETH/SOL、法币均不在当前白名单。

钱包实现见 [wallets.ts](../../client/wallets.ts)：

- EVM：EIP-1193 注入接口、EIP-6963 发现及旧式多 provider 列表；优先识别 MetaMask/Rabby，也允许实际发现的其他 EVM provider。用户选择成功后，余额、账户、网络、授权与付款固定使用同一 provider。这是接口支持，不是所有品牌/版本兼容认证。
- Tron：TronLink 注入接口；需有 `tronWeb.utils.transaction.txCheck`。当前只接受代码列出的三个 HTTPS 主网节点域名（TronGrid、TronStack、PublicNode），不接受任意自定义节点。
- 浏览器：付款需安全上下文、可用持久存储与 Web Locks。手机需兼容钱包内置浏览器的注入能力；目前只有窄屏布局历史检查，没有手机钱包实签覆盖。没有 WalletConnect 二维码/通用深链、内嵌钱包、社交登录钱包或硬件钱包专项验收。

## 3. 已实现能力与关键边界

| 能力 | 当前代码核对结论 |
| --- | --- |
| 实时报价 | Relay `quote/v2`、EXACT_INPUT、显式 deposit；核对审核链/币、付款人/接收人、金额与精度、solver 签名、重算协议 order hash、规范 calldata、授权对象与精确金额。未提供模拟回退报价。 |
| 可用性检查 | EVM 新报价检查 RPC chainId、finalized 区块、depository/token 代码与 token 精度，成功缓存 60 秒、失败 15 秒；各链币独立控制。Tron 新报价核对 Relay 主网配置，**没有与 EVM 等同的 RPC 合约/资源预检**；付款追踪使用 TronGrid 固化接口。 |
| 金额与期限 | BigInt/字符串金额，BNB 来源 18 位、其他来源 6 位；HL 输出按 8 位核验。本应用签名窗口最长 120 秒，并受协议 deadline 限制；这不是退款或最终确认期限。 |
| 授权与付款 | 有足额额度则跳过授权；不足时精确授权。本版 USDT 类非零旧额度不足需先归零，USDC 直接精确授权；授权与付款为不同用户动作。不会自动撤销过期报价留下的链上额度。 |
| Gas | EVM 每次授权/付款前读取原生币余额并估算当前调用；零余额阻断。估算不是完整多步总预算，不保证后续 Gas 或 L2 额外费用。Tron 提示 TRX/资源并限制单次调用 fee_limit，不提供实时完整资源预算。 |
| 来源核验 | EVM 要求审核来源链、原付款账户、固定合约、完整 calldata、零原生 value、成功回执、精确 token Transfer 及 canonical/finalized 区块；Tron 要求固化成功交易、匹配调用及 USDT Transfer。仅供应商 success 或交易被收录不够。 |
| 到账判定 | Relay 本单源/目标交易关系 + 同接收地址、同目标 hash、默认 Perps USDC 正向账本记录 + 不低于最低到账，才完成；未知账本类型继续等待。账本分页游标在服务端持久化。 |
| 订单与恢复 | 一报价一订单、幂等键、订单 Bearer 凭据隔离、SQLite 保存、后台重启继续只读追踪；已绑定 hash 不允许任意替换。公开交易 hash/下载收据不能替代私有访问令牌。 |
| 防重复付款 | 签名前持久写入 signing 标记；取得 hash 后立即保存；非明确拒签的未知错误保留 unknown。每单及全本机 Web Locks、跨标签检查、坏存储/孤立标记阻断新付款。保护仅覆盖同浏览器同源，不覆盖换设备或用户清除数据。 |
| 维护与异常 | 暂停新报价/订单后仍允许旧单查询、补交原 hash 与跟踪；Relay refund/failure 进入 attention，不视作成功或已核实退款。不存在自动退款执行。 |
| HTTP 安全 | schema 校验、限流、同源限制、CSP、服务端 providerData 隔离、日志不写令牌/请求体；服务端不接收钱包私钥。仅适用现有单实例架构。 |

代码依据：[Relay](../../server/providers/relay.ts)、[EVM 来源核验](../../server/chain/evm.ts)、[EVM 健康检查](../../server/chain/evm-rpc.ts)、[Tron 核验](../../server/chain/tron.ts)、[HL 账本](../../server/chain/hyperliquid.ts)、[订单服务](../../server/order-service.ts)、[付款协调](../../client/payment.ts)、[本机凭据](../../client/api.ts)、[UI 全局恢复](../../client/App.tsx)。

特别保留两项语义：`Quote.protocolOrderId` 是重算验签后的协议 hash，不是 Relay requestId；`Account.perpsUsdc` 当前取自 `marginSummary.accountValue`，代表默认 Perps **账户权益**，不是某笔 USDC 充值金额，也不能用其变化证明本单到账。接收地址归属依赖用户确认，未实现接收地址所有权的密码学签名证明。

## 4. 未实现与尚未验收

**尚未实现**：Gasless/稳定币付 Gas 的执行模式、首次 approve/清零全覆盖代付、受限 paymaster/资源池、Perpex 平台收费及收入台账、出金/HyperEVM 出金、合约交易、钱包白标 SDK、多租户伙伴结算、自动退款、邀请码/指定用户门禁、日累计限额、自动告警投递和完整值守系统。

Gasless 只有 [2026-10-12 设计](../GASLESS-PLAN.md)。当前钱包仍走普通 `eth_sendTransaction` 或 TronLink；EVM 零原生币会阻断；Relay 接口没有开启 permit/sponsored 执行，协议 `fees` 数组严格限空。上游报价显示的 gas/relayer/app 费用不表示 Perpex 已收款。未来代付需另建来源验证器：外层 from/to/calldata 可能变化，不能删除现有严格检查来放行包装交易。不得把旧付款测试当作 Gasless 验收。

**仍待验收**：用户本人钱包授权/付款与本应用订单资金到账；每条开放路线与钱包版本的真实小额闭环；手机/硬件钱包；目标服务器 Docker/Caddy/TLS、DNS、供应商连通、暂停配置和目标机器备份恢复。只读查到别人的已成交记录不替代本应用验收。

## 5. 验收时间及证据边界

以 [ACCEPTANCE](../ACCEPTANCE.md) 和 [SCENARIO-ROOT-QA](SCENARIO-ROOT-QA.md) 的 rc5 为最新已有软件验收记录；不是将 rc1–rc4 数字累加。

| 历史日期 / 时间 | 已记录结果 | 不能推定 |
| --- | --- | --- |
| 2026-10-12 16:02 PDT | Node v24.19.0，15 文件、345/345 应用回归通过；18/18 部署预检通过 | 不是今日重跑，也不是用户真实资金验收 |
| 2026-10-12 | strict TypeScript、Vite、服务端编译通过；主 JS 552.75 kB / gzip 171.16 kB，仍有体积提示 | 不能称无构建警告或已做全量性能优化 |
| 2026-10-12T23:02:52.341Z | 最终生产构建九路线真实配置/报价、HL 查询、未签名订单、幂等/访问隔离；全九单重启、SQLite 一致备份及隔离还原通过 | 不涉及签名、转账或资金端到端；快照费用不代表现在报价 |
| 2026-10-12 | 六 EVM 网络 chainId、代码/精度、finalized 真实读取；桌面 1440、手机 390 与恢复视口布局检查；控制台无 warn/error | 窄屏截图不是手机钱包兼容通过 |
| 2026-10-12 | `npm audit --omit=dev` 为 0 个已知生产漏洞；全量开发依赖记录 12 项（6 高、6 中） | 不表示全依赖零风险，也不代表今日审计结果 |
| 2026-10-12 | Compose 静态解析通过；本机无运行的 Docker daemon | 没有目标容器启动/公网 TLS 验收 |

历史独立协议审查的“137 通过 / 2 失败”是旧 fixture 问题的发现记录；[SCENARIO-REVIEW](SCENARIO-REVIEW.md) 尾部已有 root 修复回执，最终纳入 345 全通过，不应当作尚未修复缺陷。既有团队记录称本轮已审查范围内无遗留 P0/P1/P2 阻断；本次只读整理不构成新的完整安全审计。

## 6. 运行入口与运维注意

命令从 `outputs/hl-funding` 项目根目录执行。`package.json` 的 engines 是 `>=22.13.0`，项目实际目标和生产 smoke 要求 **Node 24**；新会话应沿用 Node 24，不以 package 下界替代验收运行时。

```sh
npm ci
# 管理员在私密环境按样例配置 .env；不把真实密钥贴到会话。
npm run build
npm start
```

本地默认 `127.0.0.1:8787`。热更新需两个终端分别 `npm run dev`、`npm run dev:client`，浏览器访问 `127.0.0.1:5173`。这些命令会启动/写入运行环境，本轮未执行；已有运行实例和数据库须先识别，不能贸然复用作测试。

后续软件检查命令为 `npm run typecheck`、`npm test`、`npm run build`、`npm run test:deployment`、`npm audit --omit=dev`。需要真实只读联调时，`npm run test:production` 会自行建立临时数据库和进程，查询主网并创建未签名的本地测试订单；它不是完全无本地写入的检查。`npm run test:live` 默认指向 8787 且会写未签名订单，**必须先显式设置隔离后端的 SMOKE_BASE_URL，不能无参数对用户运行库执行**。

公网按 [DEPLOYMENT-HANDOFF](../DEPLOYMENT-HANDOFF.md) 与 [PUBLIC-DEPLOYMENT](../PUBLIC-DEPLOYMENT.md)，显式使用 `deploy/compose.public.yaml` 和管理员私密 `.env.public`。`deposit.perpex.ai` 只是待确认部署建议，不是已上线地址。目标为单实例、SQLite 固定持久卷、Caddy 80/443，后端不暴露宿主端口；已有代理/CDN 须重新核对拓扑，不可随意增加可信代理跳数。

必须保留的运行细节：

- 代码普通默认金额范围 10–1000；公网 Compose 默认暂停并设 10–100；适配器硬范围 10–10000。真实生效范围需读 `/api/config`，10–100 不是邀请码、总量或日限额。
- `ORDER_TOKEN_SECRET` 与数据库配套持久保存，不能为“修复”订单更换或遗失；备份使用 `scripts/backup.mjs` 一致快照，不覆盖运行数据库，不删除在途数据卷。
- 旧内部 `perpdock-public` 卷名及 `hl-funding.*` 浏览器键是兼容性标识，不因 Perpex 品牌改名全局替换。不要运行 `down -v`。
- 修改暂停环境后需使新配置真正生效，Docker 用重新创建应用容器；仅 restart 不加载新环境。暂停不能撤回已广播交易。
- `/api/health` 只代表存活；路线看 `/api/config` 和供应商/RPC。Ethereum 可能等待约 15 分钟或更久才能完成最终核验，不能用 Relay 的短处理估计作为总到账承诺。

## 7. 下一步技术任务（交接顺序建议，本轮未执行；授权范围以用户指令为准）

1. **先完成部署与资金验收缺口**：管理员回填真实 HTTPS 地址/拓扑/版本、暂停与限额、目标机器备份恢复、RPC/供应商连通；再由用户在自己的设备完成受控小额签名与两端证据核验。每条开放路线及钱包单独记录，测试后恢复暂停。
2. **对齐下一阶段范围**：若继续“只持 U”需求，按 GASLESS-PLAN 将钱包能力检测、首次授权/清零、代付预算、费用确认与台账、独立来源验证、重启幂等恢复作为同一闭环；先验 Ethereum USDT 零 ETH/零旧授权账户，不能只改按钮文案或移除 Gas 阻断。
3. **形成运维与试点条件**：确定支持负责人、异常处理入口、值守/告警；若要求仅邀请用户访问，补真实入口控制。现有单笔限额不承担这些作用。
4. **维护而非扩大宣称**：在隔离环境复核依赖问题与 SDK 差分测试，按实际交易后复盘钱包/移动浏览器兼容、未知签名/替换 hash 人工恢复；性能体积和多实例属于后续明确范围，不应阻断当前文档交接，也不能提前标完成。

本轮未修改产品、配置、测试或运行数据；只有本技术核对文档新增。需求来源与市场结果由其他分工及 root 汇总，不能用商业 PDF 的设想补成“已实现功能”。
