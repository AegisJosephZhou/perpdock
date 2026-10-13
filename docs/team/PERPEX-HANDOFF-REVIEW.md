# Perpex 上线交接独立审查

负责人：risk_security。依据 `work/branding/TEST-HANDOFF-TASK.md` 与 `TEST-HANDOFF-ROOT-NOTES.md`，只读检查；不改应用、不读真实 `.env`/运行数据库、不执行全量测试、不启用 Docker daemon、不连接钱包。交接目标为外部管理员进行**暂停新入金的目标环境部署**，不等于真实资金或市场开放通过。

## 已完成的基线检查

### 品牌与持久化边界

将现有源码与 `hl-funding-v0.1.0-rc3-deploy-source.zip` 中对应文件做内存逐字节对照。首轮检查 server/shared/client核心/package 共21份文件：当时唯一差异是 `server/index.ts` 默认 `appName` 由 HL Funding 改为 Perpex；public Compose 的 APP_NAME 另改为 Perpex。两处都只影响品牌元信息。原订单token生成、localStorage key、支付锁、chain/provider核验、SQLite位置/结构未变。

固定 `perpdock-public` 项目/数据卷/镜像等内部名称未全局替换，避免误建空卷或破坏原恢复路径。前端 App/index 品牌修改和交接入口文档待产品组保存后完成最终对照。

### 生产与开发依赖

已读 package.json / lock 边界、Dockerfile与运行时import列表，执行 `npm ls --omit=dev --depth=0`，退出码0。生产直接依赖为 express、express-rate-limit、helmet、react、react-dom、viem、zod。server源码、两个runtime运维脚本没有导入 Relay settlement SDK、TronWeb、tsx、Vite、Vitest、jsdom 等开发/测试依赖。

Docker采用两个阶段：构建阶段 `npm ci` 并构建/运行测试；runtime重新 `npm ci --omit=dev`，只复制dist、backup与public预检脚本，以node用户执行编译产物。测试fixture不作为生产API备用数据；浏览器TronWeb来自用户钱包注入，不通过生产server导入完整TronWeb包。不能在仅安装production依赖后要求执行依赖tsx的live-smoke；该类验收应在完整源码验证环境进行。

此前生产audit=0与全量开发依赖12项问题为旧验收记录，本组没有重跑网络audit，不能把历史结果说成本轮重新验证。开发依赖问题需要维护；Docker省略dev不能消除构建/测试阶段的依赖风险，也不应盲目audit fix --force改协议SDK。最终以root本轮审计结果和确实运行的验证为准。

### 源码归档排除

`.dockerignore` 包含嵌套 `.env` / `.env.*` / backups，`.gitignore` 只放行两个无秘密模板。Docker COPY为明确源码目录及必要配置，runtime只拿产物与两个脚本。**这些忽略文件不自动约束zip打包**，rc4必须另查实际成员清单。

独立只读检查既有rc3归档84个成员：无node_modules/data/dist/.git/backups/test-results、真实env、sqlite/DB/WAL/SHM、pem/key、log路径；无符号链接。此结果只证明rc3，不替代rc4检查。建议root归档继续采用明确允许文件/目录，保留 `.env.example` 与 `deploy/.env.public.example`，排除任何真实env、运行库、数据库、证书私钥、备份与临时测试输出；生成最终sha256后再核对包内品牌/手册版本。不要把源码中的公共测试交易hash误当成私钥，也不要以“看不到secret字符串”替代路径排除。

### 已知部署未验证边界

public拓扑仍为Internet → Caddy → 单实例Node24/SQLite，funding不公开端口，默认暂停且单笔10–100 USDT。已有Nginx/CDN/负载均衡不能直接增加代理跳数或把APP置于另一条直达路径；需由外部管理员提供实际拓扑后验证来源IP与TLS边界。

Docker daemon不可达，无容器启动/Caddy实际解析/正式DNS与HTTPS/目标盘权限与备份恢复的实测结论。开发机Node24生产进程和临时库恢复通过，也不能替代Linux容器与目标服务器验收。外部先提供受控的HTTPS暂停环境，之后由用户本人在其钱包执行小额验收，不要求用户在开发电脑登录钱包或让管理员代签。

## 待本轮文件落地后收口

- 前端只做可见PerpDock → Perpex，且与rc3差异无业务变化。
- 新交接文档保留目标环境待办、桌面TronLink支持边界、手机待验收、用户本人资金签名、暂停后部署的顺序。
- root最终rc4包的实际文件清单、无秘密模板与sha256；若本组未独立读取成包，必须明确由root验证，不提前称本组检查完成。

## 前端与新交接入口复核

产品组文件落盘后，重新对照相同21份核心文件：差异仅 `client/App.tsx`、`client/index.html`、`server/index.ts`。前两个文件的唯一变化分别为页眉文字与页面title中的PerpDock → Perpex；server唯一变化仍为默认appName。styles、钱包/付款/API、shared、provider/chain、package/lock均与rc3一致。没有新增主站链接、请求、假数据、测试旁路或业务条件。

已读 `DEPLOYMENT-HANDOFF.md` 全文并只读检查本地链接：目标文件全部存在。其目标环境 → 用户本人小额签名 → 决定市场试点的顺序正确；明确建议子域名未配置、已有代理须另审、不可代签、桌面TronLink/txCheck/Web Locks边界、手机待实机验证、默认暂停/每笔限额不等于访问控制、未知付款保留原订单。原public手册已经由root更新为已有perpex.ai的背景，与本次目标一致。

两个允许归档的env模板已读取：真实secret与provider key均为空。public模板默认暂停，普通根模板仍是本地开发配置，不应被运维误作public部署；新入口清楚指向public手册与 `.env.public`。

### 交付前文档收口项

1. **root待完成项**：当前读取的 `docs/ACCEPTANCE.md:41` 仍让用户在开发机 `http://127.0.0.1:8787` 解锁TronLink；与本轮用户“不在开发电脑登录钱包”冲突。主控任务已安排更新，请最终改为外部团队提供并验收通过的HTTPS环境，并保留不得把仅页面部署等同资金通过的边界。
2. **非阻断文案清理**：新入口仍解释“旧部署手册尚未选域名/购买”的历史，但root已改手册，可直接只写当前perpex.ai/待子域名确认状态，减少交接团队困惑。内部完成记录的历史说明不影响资金路径。

除上述明确文档收口与最终成包核验外，本轮没有新增代码安全发现；可准备交接外部运维作暂停部署，不能宣布目标服务器或资金验收完成。

## 独立审查完成记录

新交接入口中的历史购买背景已清理，第2项关闭。另复核root对 `scripts/live-smoke.ts` 的修正：token比较改为布尔断言，quote/create失败只用固定错误消息；差异没有引入资金操作，消除了失败时将响应/token输出到日志的路径。该修复由协议组提出并关闭，本组不重复联调。

主控记录本轮Node24 113/113应用测试、18/18部署预检、build与生产audit=0，以及2026-10-12T21:59:35.676Z隔离production-smoke通过。以上是root统一执行证据，本组仅核对记录与实现边界，未自行重跑。只读链路会在临时应用DB创建未付款订单，不能描述成所有数据库完全只读。

**结论：代码及当前交接方案可以交给外部管理员进行暂停部署；本轮未发现新增代码安全阻断。** 正式交付包发出前，root还需将ACCEPTANCE的钱包验收入口同步成外部HTTPS，并完成其负责的rc4成包成员清单/sha256验证；这些是交付收口要求，不要求再次修改钱包或资金代码。本组报告可先纳入最终包，成包检查由root执行并记录，避免因等包而使报告无法入包。

外部管理员仍须完成目标Linux容器/代理/Caddy/DNS/TLS/端口/供应商/持久化备份恢复验收；之后才由用户本人进行真实签名与到账闭环，手机钱包另测。不能以本报告、构建成功或生产依赖audit=0宣布真钱/市场开放通过。
