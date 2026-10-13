# 公网部署独立安全与运行审查

负责人：risk_security。边界：只读部署配置与 server；不读取私有 `.env`，不创建收费资源、不暴露开发电脑、不连接钱包。所有发现由相应文件负责人处理，本组不修改应用。

## 首轮基线审查与需要同步的事项

当前 `deploy/` 新配置仍在编写，尚未判定最终文件通过。已读 `Dockerfile`、既有 `compose.yaml`、`.dockerignore`、`.gitignore`、`server/index.ts`、`server/app.ts`、`server/security.ts`、`server/order-service.ts`、`server/store.ts`、`scripts/backup.mjs` 和 `docs/OPERATIONS.md`。

1. **请 root 修正文档顺序冲突**：`docs/OPERATIONS.md` 的首段目前要求「部署前必须完成 docs/ACCEPTANCE.md 的资金验收」。本轮明确先部署暂停入金的网站、再做目标环境和本人小额验收，旧句会形成循环依赖。应区分「暂停状态的公网部署」与「开放新入金/市场试点」。
2. **暂停必须重建容器应用新环境**：运维步骤需用完整 public Compose 命令的 `up -d --force-recreate funding` 等使新环境生效；`docker compose restart` 不会载入修改后的 environment。应用的暂停检查只在新报价/新建订单处，查询、原 hash 上报、refresh、后台 poller 不受该开关阻断；已存在幂等请求仍返回原订单是恢复行为。[Docker 官方 restart 说明](https://docs.docker.com/reference/cli/docker/compose/restart/)。
3. **真实密钥不应出现在诊断输出**：最终命令请使用 `docker compose ... config --quiet`；普通 `config`/`config --environment` 会输出插值结果。样例密钥留空；不要要求把 `.env.public`、`docker inspect` 全量输出或备份文件发到聊天。现有 HTTP 应用日志只输出请求ID、方法、路由模板、状态和时长，不输出 body/header/query。[Compose 插值说明](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)。
4. **域名环境变量需要预检**：Caddy 的 `{$APP_DOMAIN}` 在解析前替换，可扩成多个 token/行；除“不含协议路径”，应拒绝空白、换行、冒号、斜杠和示例域名，接受普通域名/子域名（国际化域名先用 ASCII punycode）。主机名不是不可信访客输入，但错填会改变 Caddy 解析或让 PUBLIC_ORIGIN 不一致。[Caddy 环境变量说明](https://caddyserver.com/docs/caddyfile/concepts#environment-variables)。
5. **私有入口前提**：`TRUST_PROXY_HOPS=1` 只适用于直接 Internet → Caddy → funding；无 CDN/orange-cloud、额外代理或公开 backend 端口。来源 IP 与 proto 必须由 Caddy 覆盖。独立网络上不要加入其他不可信容器。云防火墙仍需核实80/443与受限SSH，不能以 UFW 配置代替验证 Docker 发布端口的实际暴露。[Caddy 反向代理](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[Docker 防火墙](https://docs.docker.com/engine/network/packet-filtering-firewalls/)。

## 基线已确认的保护

- 生产要求稳定 token secret；数据库保存密钥指纹，换错密钥拒绝恢复，不静默使旧订单失效。订单按 Bearer token 隔离，公开响应不含 providerData。
- API no-store、来源检查、16KB JSON 上限、每IP限流、严格请求 schema；静态只服务 dist/client，数据与密钥不作为静态文件路径。
- 应用 Docker runtime 为非root、只读根文件系统、独立可写数据卷；HTTP health 只代表存活，不代替供应商或目标链验收。
- SQLite WAL / FULL synchronous；备份用 VACUUM INTO 与 integrity_check，拒绝覆盖既有目标。需另存原 token secret；不能将运行中的 DB 单文件直接复制作为一致备份。

最终 Compose / Caddy / 部署手册检查及结论待文件完成后追加。

## 预检与秘密排除规则复核

已复核 root 新增 `scripts/check-public-env.mjs`、Docker runtime COPY 以及 `tests/public-deployment.test.mjs`。脚本不加载 `.env`，只读显式进程环境，错误为固定文本，不回显值。域名逐 label 校验阻止空白/换行/路径/端口/通配符进入 Caddy；origin 必须精确为该域名 HTTPS；强制生产模式与单跳代理、明确 pause 布尔值、6位精度且有序的限额。secret 仅做 base64url 长度/字符检查，熵仍依赖文档的密码学随机生成步骤，不能把格式有效等同随机安全。

独立执行 `npm run test:deployment`：**18/18 通过**，含 hostname 注入、origin/proxy错配、拒绝值不泄露、暂停与限额。未连接网络或钱包，没有读取真实密钥。public Compose 是否确实调用脚本并等待健康状态，仍待最终文件检查。

`.dockerignore` 已排除多层 `.env` / `.env.*` / backups；`.gitignore` 对 `deploy/.env.public.example` 唯一显式放行，真实部署文件保持忽略。Dockerfile只 COPY 所需源码/脚本，runtime只带dist与两个运维脚本；没有 COPY 仓库根所有内容到runtime。正式源码归档仍需 root 用文件清单验证排除数据库、实际环境文件、备份、证书私钥及 node_modules。

## 运行边界补充

- PAUSE_NEW_ORDERS 是应用接单开关，不能撤回已签交易或链上授权；保留在途核验，异常未知不能删库、改成功状态或重付。
- 当前没有测试邀请码/登录授权。网址不公开宣传并不构成访问控制；暂停解除后，能访问域名的人即可请求新报价。邀请阶段应由运维控制入口/访问范围，单笔100 USDT也不是日累计风险限额。
- 环境变量秘密对主机root / Docker管理员可见；管理这台服务器即持有订单恢复secret与供应商凭据的权限。限制SSH管理员、Docker组与备份访问者，后续多人运维可改文件式 secret；不需要因此重写本轮应用。
- 单实例本机内存限流会随重启重置，不是抗DDoS方案；现有 health 仅存活，需另监控异常率、磁盘空间、积压订单/最长核验时长及备份新鲜度。暂停部署可先验证HTTPS/健康/公开只读接口，资金开放再逐步验收。

## 已落盘 Compose / Caddy 静态复核

已读 `deploy/compose.public.yaml`、`deploy/Caddyfile`、`deploy/.env.public.example`，目前未发现配置层的阻断问题：

| 检查项 | 结果 |
| --- | --- |
| 路径 | 从项目根显式 `--env-file deploy/.env.public -f deploy/compose.public.yaml`，build context `..` 指向项目根，Caddyfile挂载 `./Caddyfile` 指向deploy文件夹，Dockerfile取根路径，语义一致 |
| 入口 | funding无ports；仅Caddy发布80/443 TCP；同一专用bridge，保留外联供应商能力；Caddy admin关闭 |
| IP/协议 | 覆盖Host与X-Forwarded-Host为配置域名、X-Forwarded-For/X-Real-IP为连接远端、Proto为https，删除Forwarded；配合funding单跳trust，符合直接Caddy拓扑 |
| 域名/预检 | 两服务取同一APP_DOMAIN；PUBLIC_ORIGIN由https派生；funding command先运行预检再exec应用；Caddy等待funding健康；初次错误配置不开始正常代理 |
| 持久性 | 显式稳定project与三个volume name，应用数据与Caddy证书/配置分开持久化；funding非root、两服务只读rootfs、tmpfs临时文件；未挂Docker socket |
| 日志/样例 | local日志轮转10MB×3；样例secret为空；Caddy未启用access日志；应用日志无body/header/query；禁止运维输出完整插值配置仍适用 |
| 默认试点边界 | PAUSE_NEW_ORDERS默认true、MAX_AMOUNT默认100，MIN_AMOUNT默认10；无自动付款、自动退款或通知承诺 |
| 备份挂载 | /backups来自预建的服务器目录，create_host_path=false可防Docker悄悄创建错误目录；需实际确认UID1000写权限。路径必须位于源码发布目录外，副本需另存异机 |

root已修正 `docs/OPERATIONS.md` 首段，可先暂停部署再做受控资金验收；首轮第1项关闭。Compose解析与Caddy适配器执行由root统一做；本组没有Docker daemon运行证据，不能称容器、证书或端口隔离实测通过。最终操作手册尚待落盘后检查暂停/备份/恢复命令。

## 最终手册复核与结论

已复核落盘后的 `docs/PUBLIC-DEPLOYMENT.md` 全文，首轮需要落实的操作项均已覆盖：

- 首次配置只在目标服务器产生secret，Python使用48字节随机数，拒绝覆盖已有/歧义字段、不打印值，并写0600；保留原密钥以恢复既有订单。
- 全部Compose命令显式指定同一env/public文件；普通config输出改为quiet；域名预检与Caddy validate分开，不能把前者当成Caddy解析通过。
- 先暂停部署、跨设备HTTPS/页面/端口验证、目标环境恢复演练，再由用户本人监督小额资金验收，顺序不再循环。
- 开放与暂停使用 `up -d --no-deps --force-recreate funding` 并核查实际 `/api/config`；明确不是restart、不是撤回已签交易；保留在途跟踪。
- 备份写入已预建且归1000:1000所有的服务器专用目录；脚本一致快照、0600、拒绝覆盖，要求异机加密副本与密钥分存；运行中单文件复制被禁止。
- 恢复先暂停、备份现状、停单实例，原DB/WAL/SHM一起保留后再离线替换；检查快照、恢复属主与原密钥，启动后只读查旧订单，并核对快照之后可能缺失的订单。没有把回滚数据库说成回滚链上资金。
- 明确单笔限额不是访问门禁或日累计限额；未承诺自动退款、告警投递、全天值班；证书私钥/备份同样受控；移动镜像标签要记录真实digest。

**独立结论：本轮公网部署材料可交付，未发现需要阻断「保持暂停的新服务器部署准备」的剩余问题。** 该结论是配置和运维方案审查，不是已部署、更不是开放真实资金的验收结论。本组独立执行的命令只有部署专用18项测试；根代理另记录了Node24同组测试及Compose静态语义检查。没有重复113项资金回归，没有读取任何私有env，没有启动公网服务或钱包交易。

尚未完成且必须留在最终验收表中的项目：目标Linux镜像构建/容器启动、Caddy实际解析、真实DNS/TLS签发与续期、公网端口隔离/伪造转发头检查、目标机器卷权限与备份恢复、钱包兼容及用户本人签名的小额资金闭环。健康接口成功和本次静态通过均不能替代这些验证。
