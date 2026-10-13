# 公网部署准备任务

用户希望不在开发电脑登录钱包，给网站绑定域名供其他设备及测试用户访问。用户确认暂无域名和云服务器，需要新建。尚未指定域名、预算、注册账户或服务器权限；未授权具体费用购买，不能声称已上线或偷偷暴露开发电脑。保持现有本机生产服务及资金路径。

## 方案与边界
准备 Linux 单实例 VPS 的完整部署：现有 Node24 + SQLite 持久卷，Caddy自动HTTPS。DigitalOcean Basic 1vCPU/2GiB/50GiB官方当前$12/月（不含税/备份/域名），只是参考配置，不先创建收费资源。域名Cloudflare Registrar候选，具体可注册性与价格未查。使用用户自己的账户登记。目标地区待服务可用性与用户群选择，不能承诺可绕过第三方地域限制。

Sites skill确认托管服务运行于Cloudflare Workers；当前应用依赖node:sqlite和常驻poller，无法原样运行，不为图快仅公开静态前端或临时迁移后端。

本轮只准备可核查部署材料，不连接钱包，不签名，不广播，不读取私有.env，不部署公网、不购买域名或实例。先允许用户在公网访问和做目标环境测试，之后本人钱包小额验收；不能让运维文档要求部署前完成必须在公网进行的验收。

## 分工
- product_delivery：仅拥有 deploy/compose.public.yaml、deploy/Caddyfile、deploy/.env.public.example、docs/PUBLIC-DEPLOYMENT.md。准备无需重写应用的独立public Compose（必须从项目根 `docker compose --env-file deploy/.env.public -f deploy/compose.public.yaml ...`），app build context `..`，只给Caddy发布80/443；funding不能发布宿主端口，指定TRUST_PROXY_HOPS=1且只有Caddy入口。Caddy使用APP_DOMAIN，覆盖转发IP/Proto避免伪造。容器持久卷应用/caddy证书，依赖健康检查。默认PAUSE_NEW_ORDERS=true供部署验收，MAX_AMOUNT=100供邀请测试。环境样例秘密留空，PUBLIC_ORIGIN可由https+APP_DOMAIN派生避免不一致。域名只填主机名，不含协议路径。不要生成真实密钥入源码。文档具体步骤/DNS A记录/只DNS模式/80和443放行/SSH限管理员IP/持久卷备份不能down-v。provider keys仍由用户服务器秘密文件填写。禁止收集助记词。
- risk_security：只读独立审查上述部署文件及现有server安全策略。拥有docs/team/PUBLIC-DEPLOYMENT-REVIEW.md。检查Compose启动/挂载路径、Caddy变量替换、转发头、唯一入口、secret不会打日志/归档、暂停切换不影响在途、备份说明。不要修改应用。根代理负责验证命令及归档，不需重复原113项资金测试。
- root：任务调度、官方价格核查、预检脚本（如需要）、Compose静态校验/代理配置校验、归档及最终部署边界。原来源及成果见docs/ACCEPTANCE.md。

技术沟通都写MD，工具消息仅指向文档。完成报告写命令、确实通过的检查、尚未执行的服务器/HTTPS/资金验收。没有Docker daemon不能声称容器跑通。

## 根代理集成说明
已为Docker构建上下文补上 `**/.env` / `**/.env.*` / `**/backups` 排除规则；Git只放行deploy/.env.public.example。请前端文档只用docker compose config --quiet验证，不打印展开后的真实secret。默认本机.env和现有DATA_DIR均未读取或修改。Docker Compose v5.1.0可做静态合并检查，Docker daemon未运行；不能声称容器/证书已通过。

建议新服务器上保留稳定Compose项目名，避免更换目录误建空数据卷；备份路径只写服务器专用目录，不把订单数据库放入源码归档。备份后按文档复制到服务器外安全位置，避免单机失效全丢。

## 预检落点（root实施，产品组接入）
根代理将提供 scripts/check-public-env.mjs，并复制到Docker runtime。public funding环境需含 APP_DOMAIN、PUBLIC_ORIGIN、NODE_ENV=production、TRUST_PROXY_HOPS=1、ORDER_TOKEN_SECRET、PAUSE_NEW_ORDERS、MIN_AMOUNT/MAX_AMOUNT。public funding command设置 `["sh", "-c", "node scripts/check-public-env.mjs && exec node dist/server/index.js"]`；Caddy depends_on funding service_healthy，使无效domain/secret在对外Caddy启动前拒绝。脚本只读环境，不输出secret、不加载本机.env。普通原有本地compose不执行此专用预检。域名会拒绝空白/协议/路径/端口/示例域名/localhost/IP；只接受真实DNS形态ASCII域名。此举只校验配置，不宣称验证域名所有权。

预检实现已落盘：scripts/check-public-env.mjs；专项测试 tests/public-deployment.test.mjs / npm run test:deployment，Docker build也将执行。请安全组复核域名注入阻断、错误不回显秘密；只为public topology检查，不影响原本机流程。

根代理已完成18项预检测试，等待public Compose/Caddy样例落盘做静态语义验证；请产品组先保存配置，再补齐长文档，使验证能并行开始。

## 根代理静态验证结果
- Node24.19.0运行 `node --test tests/public-deployment.test.mjs`：18/18全部通过。
- Docker Compose v5.1.0以显式模板env文件及合成测试域名/秘密作 `config --format json`（只在内存解析，未输出展开值），检查构建上下文/挂载/唯一公有端口80和443/后台无ports/只读及cap限制/固定项目名/单跳代理/预检入口/先健康再启动Caddy/默认暂停和上限100，全部通过；域名或secret为空均拒绝配置。
- 测试域名 `funding.perpdock.com` 只是语法样本，不代表已拥有、已购买或可注册。RDAP工具查询未得到足以确认的结构化记录，域名状态和最终价格仍需注册商确认。
- 目前Docker daemon未运行且没有Caddy可执行文件；容器启动/Caddy解析/TLS签发/公网连通/目标服务器备份恢复均尚未验证。原本机8787与用户数据未改动。

根代理已读完整docs/PUBLIC-DEPLOYMENT.md并核对命令/挂载/密钥生成/暂停重建/备份步骤。Caddy实际解析本机未执行（没有Caddy执行器且Docker daemon未运行），请手册末表将“待根代理补充解析结果”写明“未执行，目标服务器运行validate后再启服务”。购买/注册状态仍全部未开始，等待用户域名选择与云账户。
