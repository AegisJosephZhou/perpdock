# Perpex rc5 主控审查与交付记录

日期：2026-10-12，America/Los_Angeles。用户要求由团队主动补齐主要入金场景，不再等待逐项提示；本轮在既有真实Tron入口上实现Ethereum USDT及其余经过核实的EVM稳定币路线。团队以MD明确接口、所有权、问题复现和审查结果，root统一集成及验收。无钱包代签，无真实资金广播，无外部服务器/DNS修改。

## 实际交付范围

七网络九路线：Ethereum USDT/原生USDC，Arbitrum USDT0/原生USDC，Base/Optimism/Polygon原生USDC，BNB Binance-Peg USDT，Tron USDT。后端对实际主网配置、来源RPC及可执行Relay协议报价进行校验；钱包根据编译白名单再次核对chain/token/decimals/depository/protocolOrderId及规范ABI，付款后必须有最终确认的匹配来源Transfer与HL默认Perps同单入账证据。

前端分开网络/资产，支持实际发现的多钱包选择，检查EVM真实原生余额与当次Gas估值；区分零余额、未知读数和不可用路线。加入交易所、手机、未支持资产、未到账指引；离线/账户/链切换使旧上下文失效。严格本机恢复和浏览器级锁阻止未决付款切换订单后重付。每条资产完整精度，BNB18位不按6位缩放。

独立模块与交叉审查见 [后端](SCENARIO-BACKEND.md)、[钱包与安全](SCENARIO-SECURITY.md)、[前端](SCENARIO-FRONTEND.md)、[独立协议复核](SCENARIO-REVIEW.md)。

## 已发现问题及修复闭环

| 编号 | 问题 | 修复及验证 |
|---|---|---|
| P2-E1 | 查看另一历史订单可能绕过原unknown付款 | 全本机严格扫描、服务器强完成证据、全局Web Lock及跨标签同步；未知/失败恢复保守阻断，旧hash上报可继续 |
| P2-S1 | 空字符串坏存储被当成空数组 | 仅null回退；坏JSON不覆写，不进入新付款；严格存储15项测试通过 |
| P1-R1 / P2-S2 | EIP6963公告触发再次请求形成同步/异步循环 | 页面会话只请求发现一次，先置标志后dispatch；实际EventTarget及App完整发现/连接回归通过 |
| P2-R2 | 重复查询所有已完成历史容易触发限流 | 仅页面内存缓存服务端强完成证据，以id+token隔离；未知状态每次现场读取，完成态停止轮询；25完成历史+未知单回归通过 |
| P2-SR1 | 多链smoke旧fixture缺walletType使日志测试提前失败 | 补实际Tron类型并固定测试routeId；两项到达预期错误分支且不泄漏测试凭据 |
| 协议防御补强 | ABI地址高位非规范填充需要明确拒绝 | 规范重编码对照；来源调用、报价和钱包校验一致，相关后端回归通过 |

在本轮已审查范围内没有保留未修复的P0/P1/P2资金安全阻断。该结论不是对所有钱包、供应商或真实资金流程的保证。

## 最终执行结果

- Node v24.19.0，16:02 PDT，`npm test`：15文件、345项全部通过，无跳过；测试监听本机端口需要当前工具环境允许loopback，最初受沙箱限制的EPERM不被当成产品缺陷或通过证据。
- `npm run test:deployment`：18项全部通过。`npm run build`：strict TypeScript、Vite与服务端编译全部成功；主JS 552.75 kB/gzip171.16 kB，仍有大于500 kB的构建提示。
- 使用合成无秘密配置执行Docker Compose静态解析通过：六项RPC环境键、默认暂停10–100、后端无宿主端口、仅Caddy80/443、原固定数据卷名称均保持。没有启动容器或访问Docker daemon。
- `npm audit --omit=dev`：0个已知生产依赖漏洞。依赖锁未改；开发测试SDK的历史12项问题仍记录在ACCEPTANCE，不声称全依赖零问题。
- `npm run test:production`：23:02:52.341Z全部通过；最终生产构建真实九路线配置/报价/未签订单/访问隔离/幂等，全九单同库进程重启恢复，在线VACUUM INTO及完整性/权限/防覆盖/独立目录恢复。临时进程和数据已清理，原用户运行库未用于smoke。具体报价快照见 [ACCEPTANCE](../ACCEPTANCE.md)。
- 主网RPC真实读取已确认六EVM链chainId、对应token decimals与代码、depository代码、finalized区块；协议捕获样本只在tests/fixtures，不在生产作为fallback。服务端健康gate继续动态决定路线可用性。
- 最终本机8787使用原`.env`、订单密钥及DATA_DIR重启到新构建；没有删除/迁移原订单或重置凭据。

## 浏览器验收

对现有本机页面重新加载实际生产构建。Ethereum USDT默认、同链USDC、Arbitrum USDT0、BNB18位映射资产与BNB手续费、Polygon原生USDC与POL手续费、TronLink与TRX均按实际选择显示；无注入钱包错误有明确提示。帮助包含交易所先提至自有钱包、手机钱包接口及localhost限制。非法接收地址禁止确认/报价；本机空历史与返回入口正常。

1440×1000、390×844及恢复默认692px视口均无水平溢出；控制台warn/error为空。已保存 [当前页面](../screenshots/perpex-rc5.jpg)、[桌面](../screenshots/perpex-rc5-desktop.jpg)、[手机布局](../screenshots/perpex-rc5-mobile.jpg)。结束时Ethereum USDT、金额及接收地址空白、归属确认未勾选；未注入模拟钱包或伪造付款成功页面。

## 必须保留的验收边界

用户在自己的设备签名。外部团队尚未部署HTTPS或验证目标Docker/Caddy/证书/备份恢复；具体移动钱包、硬件钱包及九条路线的真实资金闭环均未做。当前应用面向默认Perps，不支持Solana、USDC.e、法币、原生ETH/SOL或交易所直接转入合约，也没有接通WalletConnect二维码。EVM Gas预检只是当前调用估算，不能保证后续费率或L2额外费用。恢复保护依赖同浏览器同源存储，不能覆盖主动清除数据或其他设备。

交付源码包采用显式白名单，排除实际.env、数据/备份、私钥证书、node_modules与构建产物；外部团队从源码构建并执行 [部署手册](../DEPLOYMENT-HANDOFF.md)。只有目标环境及用户小额验收后才决定市场测试范围。
