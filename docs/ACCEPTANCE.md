# 验收记录

## 当前结论：rc5 多链与主要场景补齐

2026-10-12：Perpex 已完成七个网络、九条审核稳定币路线的前后端实现、代码交叉审查、自动化与真实只读生产联调。默认 **Ethereum USDT → 自己的 Hyperliquid 默认 Perps USDC**，支持检测到的 MetaMask/Rabby 等 EVM 注入钱包，另保留 TronLink 路线。详细资产和使用边界见 [场景覆盖](SCENARIO-COVERAGE.md)。

**本机软件验证通过；尚未发布公网，用户钱包签名及本应用订单真实资金到账仍待完成。** 所有真实测试订单均未签名。手机布局适配不代表具体手机钱包资金流程通过。

| 检查 | 本轮结果 | 证据与限制 |
|---|---|---|
| 全工程应用回归 | 345/345 通过，15文件 | Node v24.19.0，16:02 PDT；含协议、钱包、前端、未知付款恢复、存储损坏、多钱包与精度分支，无跳过 |
| 部署预检 | 18/18 通过 | 域名、HTTPS origin、密钥、限额、暂停配置；未替代目标服务器实测 |
| Compose静态配置 | 通过 | 合成配置解析：六条EVM RPC、默认暂停10–100、后端无宿主端口、Caddy仅80/443、原固定卷名；未启动容器 |
| strict TypeScript、Vite、服务端编译 | 通过 | 主JS 552.75 kB，gzip 171.16 kB；Vite仍有超过500 kB的体积提示 |
| 生产依赖安全审计 | 0个已知漏洞 | 本轮 `npm audit --omit=dev`；开发依赖历史问题见下方记录，锁文件未变 |
| 九路线真实生产HTTP联调 | 全部通过 | 23:02:52.341Z：真实配置/RPC gate、Relay签名报价、HL账户读取、未付款订单、访问隔离与幂等 |
| 重启与备份恢复 | 通过 | 全九路线订单使用原token恢复；在线VACUUM INTO、integrity_check、0600、防覆盖、隔离还原；测试专属进程和数据已清理 |
| 本机运行与浏览器 | 通过 | 8787使用原配置及数据库运行新构建；真实网络/资产选择、缺钱包提示、帮助、非法地址阻断和订单入口 |
| 响应式布局 | 通过 | 1440、390及恢复后的692px均无横向溢出；控制台无warn/error。截图见下方 |
| 真人钱包签名与HL到账 | 待验收 | 开发者未签名、未转账；用户须在自己设备亲自验收 |
| 公网/容器/TLS/手机钱包 | 待验收 | 无服务器或DNS访问；本机Docker daemon未运行，无目标Docker/Caddy/TLS或手机钱包实测 |

最终只读报价快照如下，均由最终编译后的服务端校验协议签名、来源币种及付款调用；它们不是用户未来订单价格承诺。EVM每单10来源资产单位，Tron100 USDT；产出及最小到账均为USDC。

| 路线 | 输入 | 预计净到账 | 最小到账 |
|---|---:|---:|---:|
| Ethereum USDT | 10 | 9.965502 | 9.865847 |
| Ethereum USDC | 10 | 9.978998 | 9.879208 |
| Arbitrum USDT0 | 10 | 9.964555 | 9.864910 |
| Arbitrum USDC | 10 | 10 | 9.9 |
| Base USDC | 10 | 9.978998 | 9.879208 |
| Optimism USDC | 10 | 9.978998 | 9.879208 |
| Polygon USDC | 10 | 9.978998 | 9.879208 |
| BNB Binance-Peg USDT | 10 | 9.955516 | 9.855961 |
| Tron USDT | 100 | 99.735175 | 98.737823 |

浏览器确认：Ethereum默认USDT，切USDC保持正确原生合约；Arbitrum显示USDT0、BNB显示18位映射资产与BNB Gas、Polygon显示原生USDC与POL Gas、Tron切回TronLink与TRX；没有注入钱包时正常提示。交易所帮助要求先到自己的钱包；手机帮助明确localhost不能供另一台设备访问。未连接真实钱包、未勾选地址归属，结束时输入框为空、Ethereum USDT为当前路线，临时视口覆盖已恢复。

界面证据：[当前页面](screenshots/perpex-rc5.jpg)、[桌面1440](screenshots/perpex-rc5-desktop.jpg)、[手机390](screenshots/perpex-rc5-mobile.jpg)。审查及闭环：[主控](team/SCENARIO-ROOT-QA.md)、[协议](team/SCENARIO-REVIEW.md)、[安全](team/SCENARIO-SECURITY.md)、[前端](team/SCENARIO-FRONTEND.md)。

## 历史 rc4 结论（当前版本见上方 rc5）
2026-10-12：Perpex rc4 本地软件验证与真实只读主网接口联调通过，可交接外部服务器/DNS团队进行暂停部署。用户不在开发电脑登录钱包；后续本人小额测试使用外部团队验收后的 HTTPS 环境。**用户钱包签名与本应用订单实际入账尚未发生，不宣称资金端到端通过，也未发布到公网。**

| 检查 | 状态 | 说明 |
|---|---|---|
| 生产依赖审计 | 通过 | npm audit --omit=dev：0个已知漏洞，2026-10-12 |
| 编译与生产构建 | 通过 | strict TypeScript、Vite及服务端编译；rc4主JS gzip 169.92 kB，原始547.70 kB体积提示不影响构建 |
| 自动化安全/订单/协议测试 | 通过 | 本轮113项应用回归 + 后续2项脚本凭据保护回归，合计115项；Node24，无skip/预期失败。另18项部署预检通过 |
| 本应用真实API联调 | 通过 | 正式HTTP链路：Relay配置/可执行报价、HL真实账户、未签名订单、幂等与访问隔离 |
| 浏览器基础验收 | 通过 | 真实路线、公开账户余额、无TronLink提示、非法地址阻断、桌面1440px及手机390px布局、无横向溢出、控制台无error/warn |
| Node 24 生产运行 | 通过 | v24.19.0、生产静态资源/JS/CSP、真实只读API、同库重启恢复原token/订单/幂等键 |
| 数据库备份恢复 | 通过 | 在线VACUUM INTO、integrity_check、0600权限、防覆盖、独立目录恢复原订单 |
| Docker/Compose | 部分通过 | Compose语法验证通过；主机无运行的Docker daemon，未执行容器启动 |
| 用户钱包真实付款 | 待完成 | 用户已同意亲自签名；尚未转账 |
| 本应用订单资金到账 | 待完成 | 必须有Tron固化付款、Relay订单及HL Perps credit凭证 |

## 历史 rc4 已执行证据

Node24运行完整 Vitest → 113/113；`npm run build` → exit 0；`npm audit --omit=dev` → 0 vulnerabilities。独立审查结果与已修复项见 [root审查](team/REVIEW.md)、[协议安全审查](team/SECURITY-REVIEW.md)、[钱包审查](team/WALLET-REVIEW.md)。测试中的链响应和签名桩明确隔离于tests，不是生产数据。

完整生产过程见 [Node 24 验收](team/PRODUCTION-QA.md)：2026-10-12T19:26:56.183Z 真实报价100 USDT → expected 99.735823 / minimum 98.738465 USDC。该价格仅为快照，无资金广播；不得作为用户随后订单的价格承诺。历史公开Tron→HL已成交记录仅证明账本识别语义，不代替本应用 depositErc20 验收。

浏览器实际读取公开研究地址 `0xf3d63166f0ca56c3c1a3508fce03ff0cf3fb691e` 的 Perps权益/可提金额均为9.56，观察时间2026-10-12T19:23:35Z。这不是用户地址，也不代表本单到账。验证后输入框已清空。界面证据：[桌面](screenshots/desktop.jpg)、[手机](screenshots/mobile.jpg)、[只读账户](screenshots/real-account-browser.jpg)。

开发环境白屏已定位并修复：Vite代理原本拦截 `/api.ts` 源码；改为只代理 `^/api/` 并重启后，浏览器实际正常渲染。生产构建始终使用编译后资源，最终两种模式均已检查。

全量 `npm audit` 仍报告12项开发依赖问题（6高、6中），位于用于差分测试的Relay SDK、TronWeb及传递链（包括Solana/Anchor、Axios、内嵌viem/ws）。这些依赖不被生产入口导入，Docker最终阶段使用 `npm ci --omit=dev`。开发依赖更新仍需维护，不能把生产audit=0表述为全仓无风险。未使用强制降级掩盖问题。

## 原型方向改版验收（rc2）

2026-10-12：PerpDock单列「入金确认 → 入金进度」与独立订单记录已接入原真实资金路径。server/**、shared/**、client/api.ts、client/payment.ts、client/wallets.ts与rc1逐字节相同；未新增运行时演示数据。新增25项React组件回归，覆盖净额/最低到账/费用读数、真实余额比例算法、精确授权的独立付款步骤、重复点击与导航锁、历史恢复、签名未知/已保存hash、过期处理、六类无效completed响应。原88项仍全部通过。

浏览器在Node24生产服务实际检查新构建：1440×1000与390×844，无横向溢出；无扩展提示、无效接收地址阻断、空订单记录及返回入口正常；控制台无warning/error，页面HTTP200并带生产CSP。20:30:44 UTC读取上述公开研究地址权益及可提余额均9.56；验证后清空地址、未勾选归属确认、未签名。截图：[新版桌面](screenshots/redesign-desktop.jpg)、[新版手机](screenshots/redesign-mobile.jpg)、[新版真实账户](screenshots/redesign-real-account.jpg)。

独立审查：[前端实现](team/REDESIGN-FRONTEND.md)、[协议映射](team/REDESIGN-PROTOCOL.md)、[UI安全回归](team/REDESIGN-SECURITY.md)、[主控验收](team/REDESIGN-ROOT-QA.md)。已修正本机有交易hash但服务器未接收时的状态文案，避免误导用户再次签名。真实支付/到账进度的浏览器钱包流程尚待用户完成；这里没有用模拟订单制作“资金已到账”截图。

## 用户小额验收操作

1. 外部团队先按 [上线交接入口](DEPLOYMENT-HANDOFF.md) 完成暂停部署及目标环境验收，再安排受控小额窗口。用户在**自己的设备**上，用有实际钱包注入接口、支持安全存储与Web Locks的浏览器打开管理员确认的HTTPS网址；建议 `deposit.perpex.ai` 尚未上线，不要求在开发电脑登录钱包。
2. 根据资产实际所在网络选链和币。用户当前Ethereum USDT可直接选择 **Ethereum / USDT / MetaMask**；其他组合见场景表。Tron使用TronLink且需txCheck能力。具体手机钱包与硬件钱包必须逐项验收，不能由桌面测试推定。
3. 连接自己的付款钱包，填写并完整核对自己控制的HL接收地址；同地址也要确认，不同地址需额外确认。选择目标为默认Perps，不把HyperEVM、Spot余额当成这笔保证金入账。
4. 从所选资产10单位的小额获取实时可执行报价，核对最低到账与费用；若当前报价不可用，按实际规则处理。另备对应原生Gas：Ethereum/Arbitrum/Base/Optimism为ETH，Polygon为POL，BNB为BNB，Tron为TRX/资源。EVM显示真实原生余额并预检当次交易估费；非零余额不保证未来全部费用足够。Tron每次合约调用能量费用上限150 TRX，带宽另计，实际费用以钱包为准。
5. 本人在钱包分别确认必要的精确授权与付款。部分USDT类旧非零不足额度需先清零；USDC按精确授权策略执行。报价过期且尚未付款可重新获取，旧链上授权不会自动撤销；若签名/广播结果未知或已有hash，恢复原单核验，不另建订单重付。
6. 等待匹配来源付款最终确认（EVM finalized或Tron固化成功）、对应Relay订单和目标交易、同目标hash及接收地址的默认Perps USDC入账。Ethereum最终确认可能约15分钟或更久，HL可能先到，页面仍应按证据核验。刷新确认订单恢复并下载公开收据，再回填结果；不要发送私钥、助记词或订单访问令牌。

生产构建只在本机运行。交付源码排除私有环境、数据库、备份及钱包资料。市场测试还需域名HTTPS、供应商连通与正式配置、目标服务器/容器验证、真实资金闭环和异常支持入口。验证一条路线不代表全部九条及所有钱包已完成真人验收。

## 资金验收填写
由用户在钱包签名，系统记录并核验，禁止填入私钥或助记词。

- 本应用订单号：待填
- 来源网络 / 币种 / 钱包及浏览器版本：待填
- 来源付款交易：待填
- 目标 HL 交易：待填
- 输入金额 / 最小到账 / 实际入账：待填
- 刷新恢复与订单收据：待核验
- 是否可开始受控市场试点：尚未判定

## 公网部署准备（rc3）

用户希望在其他设备连接钱包，并让测试用户通过域名访问。已增加独立public Compose、Caddy自动HTTPS配置、无秘密env模板、启动前环境预检及完整部署手册。Node24部署预检18/18通过，Compose静态语义及独立审查通过；应用资金路径未改动，原113项应用验收仍见上文。本轮没有读取本机私有环境、迁移订单数据库、购买域名/服务器或公开开发电脑。

rc3当时只完成部署准备，未执行目标Docker/Caddy/DNS/TLS/公网连通/备份恢复/钱包资金验收。用户后续确认拥有perpex.ai，域名及服务器由外部团队管理；当前安排见下方rc4记录、[交接入口](DEPLOYMENT-HANDOFF.md)和[公网部署手册](PUBLIC-DEPLOYMENT.md)。

## Perpex 本地验收与外部交接（rc4）

2026-10-12（America/Los_Angeles）：页面标题、页眉和应用品牌配置改为 Perpex；资金代码、钱包调用、订单模型、浏览器恢复键与数据库未变。保留内部 Compose 项目/卷名以兼容持久化数据。新增管理员交接入口，明确现有反向代理和端口占用不能直接套单跳 Caddy 模板。

- 14:59 PDT，Node24执行原113项应用回归，7文件全通过；18项部署预检全通过；strict TS + Vite + server构建退出0。
- 协议组发现live-smoke断言失败可能打印订单accessToken；已改为固定错误文案和boolean断言，不回显响应体或令牌。15:01 PDT新增两项故障注入回归（创建失败/幂等令牌不一致）均通过，子进程输出不含合成凭据。它们只使用tests内隔离fetch桩，不接主网，不改变产品运行数据。
- 本次npm audit --omit=dev查询成功：0个已知生产依赖漏洞。开发依赖12项问题沿用前次审计记录，未在本轮重复全量audit；依赖锁文件未改。
- 14:59:35 PDT（21:59:35.676Z）production-smoke全程通过：真实Relay路线/报价、HL账户读取、未付款订单/访问隔离、同库进程重启、在线VACUUM INTO与完整性/0600权限/防覆盖、独立目录恢复及原令牌/幂等恢复。临时进程和测试数据库已清理。
- 当次仅报价100 USDT → expected 99.749626 / minimum 98.752129 USDC；该快照不是用户订单承诺。没有连接钱包、签名或广播；新建的测试订单始终未付款。
- 合成Compose配置静态检查通过：Perpex品牌、建议域名、默认暂停10–100、后端无宿主端口、仅Caddy80/443、原固定数据卷。
- 本机8787使用新构建和原数据/secret重新启动；浏览器实际标题与页眉为Perpex、真实路线可见、692px页面无横向溢出、控制台无warn/error。只确认本次品牌与正常加载，沿用rc2桌面/手机布局和其余交互证据；未把窄屏布局当成手机钱包支持。截图：[rc4页面](screenshots/perpex-rc4.jpg)。

独立复核：[前端与交接](team/PERPEX-HANDOFF-FRONTEND.md)、[协议及测试脚本](team/PERPEX-HANDOFF-PROTOCOL.md)、[安全交接复核](team/PERPEX-HANDOFF-REVIEW.md)。本机Docker daemon未运行，故没有容器启动/Caddy validate/TLS/目标盘恢复实测。外部团队还需提供暂停HTTPS环境，完成目标环境验收；用户本人签名小额资金闭环后再决定市场测试范围。此次交付不代表这些待办已完成。
