# Perpex 自有域名公网部署手册

本手册把现有应用部署到一台 Linux 云服务器：Internet → Caddy HTTPS → Node 24 应用 → SQLite 持久卷。钱包签名仍在访问者的浏览器内完成。先以**暂停新入金**状态部署并检查正式域名，再由用户本人进行小额资金验收；市场试点条件见 [ACCEPTANCE.md](ACCEPTANCE.md)。

用户确认已有 perpex.ai 品牌域名，由外部团队管理服务器与 DNS。本次先完成本地验收并交付该团队，建议入口为 deposit.perpex.ai，尚未配置 DNS、部署公网、签发证书或进行真实钱包转账。管理员须确认目标主机、域名解析和实际代理拓扑后实施；无需为本项目另买域名。交接入口见 [DEPLOYMENT-HANDOFF.md](DEPLOYMENT-HANDOFF.md)。

## 1. 文件、配置与边界

| 文件 | 用途 |
| --- | --- |
| `deploy/compose.public.yaml` | 独立公网部署；仅 Caddy 发布 TCP 80/443，应用不发布宿主端口 |
| `deploy/Caddyfile` | 自动 HTTPS、唯一可信代理、覆盖客户端转发头 |
| `deploy/.env.public.example` | 无真实密钥的配置模板；复制后的 `.env.public` 必须私密保存 |
| `scripts/check-public-env.mjs` | 启动前校验域名、origin、代理跳数、secret 格式、暂停值和限额 |
| `scripts/backup.mjs` | SQLite 一致快照及完整性检查 |

应用采用固定 Compose 项目名 `perpdock-public`。数据卷名分别为 `perpdock-public-funding-data`、`perpdock-public-caddy-data`、`perpdock-public-caddy-config`，迁移源码目录时仍复用这些卷。不要使用 `-p` 改项目名、改卷名、增加应用副本，或运行 `down -v`。一台主机只部署这一份实例。

默认 `PAUSE_NEW_ORDERS=true`、最低10、单笔最高100来源稳定币单位。最高金额是每笔输入金额，**不是日累计限额，也不是邀请访问权限**。当前没有邀请码或登录门禁；解除暂停后，知道网址的人都可请求新报价。受控测试期间必须有人值守，若要求严格限定访问者，应先加服务器侧入口访问控制并验证钱包兼容性。

本配置只适用于 Internet → Caddy → funding 一层代理。不要启用 Cloudflare 代理/CDN，不要增加其他代理，不要公开 8787/5173/2019 端口，也不要把不可信容器加入应用网络。Caddy 覆盖来源 IP、Host、Proto 等头；应用按 `TRUST_PROXY_HOPS=1` 识别来源。代理规则参考 [Caddy 官方说明](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。

## 2. 准备服务器与域名

1. 由现有管理团队确定有权限使用的 Linux 主机和域名，建议使用 deposit.perpex.ai 子域名。2 GiB 内存可作为初期部署参考，仍需在目标机器验证镜像构建、稳定性、供应商连通和磁盘容量；这不是容量承诺。主机地区还需符合用户和第三方服务的实际可用范围。若现有服务器的80/443已被其他站点占用，不要直接启动本配置覆盖或争抢端口；使用独立主机，或先另行审查现有反向代理接入方案。
2. 按 [Docker Engine 官方安装指引](https://docs.docker.com/engine/install/) 安装 Docker Engine 与 Compose 插件。下面命令假定管理员已具备 Docker 权限；Docker 组与主机管理员均可访问容器秘密，只授予必要人员。
3. 云防火墙允许公网 TCP 80/443；SSH 仅允许管理员固定 IP，使用 SSH 密钥。检查实际公网暴露端口，不能只以 UFW 配置代替云防火墙和外部验证。备份目录、Docker socket、应用端口不得公开。
4. 为选定主机名添加 DNS A 记录，指向这台 VPS 的公网 IPv4。若使用 Cloudflare，选择 **DNS only / 仅 DNS（灰云）**。仅在 IPv6 路由和防火墙都已配置时添加 AAAA；错误的 AAAA 会影响访问及证书验证。
5. 将源码交付包放到服务器的 `/opt/perpdock` 或其他管理员控制目录，进入该项目根目录。只上传源码交付包，不上传开发机 `.env`、订单数据库或钱包资料。后续所有命令均在项目根目录执行，始终显式指定同一份 env 与 public Compose 文件。

Caddy 为真实域名自动申请证书，需要正确 DNS 及可达的 80/443；证书数据保存在持久卷。详情见 [Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)。主机时间应准确；出现证书错误时先修复 DNS、端口或时间，不能跳过浏览器证书校验。

## 3. 首次创建服务器私密配置

以下步骤仅用于**尚未配置的新服务器**，不要覆盖已有 `.env.public` 或原订单密钥：

```sh
umask 077
test ! -e deploy/.env.public && cp deploy/.env.public.example deploy/.env.public
chmod 600 deploy/.env.public
sudo install -d -m 0700 -o 1000 -g 1000 /var/backups/perpdock
```

备份目录必须事先创建；Compose 禁止自动创建此绑定目录。UID/GID 1000 对应本 Dockerfile 使用的官方 Node 镜像 `node` 用户。若之后更换运行用户，应同步修改目录所有者，不要使用 `chmod 777`。

在服务器本地编辑 `deploy/.env.public`：

- `APP_DOMAIN` 填已注册且 DNS 指向本机的 ASCII 主机名；不含 `https://`、端口、路径、空格或换行。不接受 localhost、IP 或示例域名；国际化域名需先转为 ASCII punycode。本预检只校验形态，不证明域名所有权。
- `PUBLIC_ORIGIN` 自动从 `https://` 与 `APP_DOMAIN` 生成，不另行设置；代理跳数固定为 1。
- `RELAY_API_KEY`、`TRONGRID_API_KEY` 填自己的供应商凭据。历史只读请求可匿名成功不能证明目标环境可免密长期使用。含 `$` 的值应用单引号包裹，避免 Compose 插值。
- 首次保持 `PAUSE_NEW_ORDERS=true`、`MIN_AMOUNT=10`、`MAX_AMOUNT=100`。`BACKUP_DIR` 默认为 `/var/backups/perpdock`，变更时必须同步准备该绝对路径。

用下面命令在服务器产生一次应用密钥；它只写入空白字段，不打印密钥，检测到已有值会停止。需要服务器有 Python 3。该密钥用于订单访问凭据，**不是钱包私钥或助记词**：

```sh
python3 - <<'PY'
from pathlib import Path
import secrets

p = Path('deploy/.env.public')
lines = p.read_text().splitlines()
slots = [i for i, line in enumerate(lines) if line.startswith('ORDER_TOKEN_SECRET=')]
if len(slots) != 1 or lines[slots[0]] != 'ORDER_TOKEN_SECRET=':
    raise SystemExit('Refusing to overwrite an existing or ambiguous order secret.')
lines[slots[0]] = 'ORDER_TOKEN_SECRET=' + secrets.token_urlsafe(48)
p.write_text('\n'.join(lines) + '\n')
p.chmod(0o600)
print('Order secret saved without displaying its value.')
PY
```

将原密钥另存于用户控制的安全密钥管理器，并与数据库快照保持对应。更新镜像、暂停/恢复、换服务器时不得随意重新生成；数据库会检查密钥指纹，换错会拒绝启动。不要将 `.env.public`、密钥、完整 `docker inspect`、数据库或备份发到聊天、截图或源码仓库。

## 4. 先验证配置，再以暂停状态启动

```sh
docker compose --env-file deploy/.env.public -f deploy/compose.public.yaml config --quiet
docker compose --env-file deploy/.env.public -f deploy/compose.public.yaml build funding
docker compose --env-file deploy/.env.public -f deploy/compose.public.yaml run --rm --no-deps funding node scripts/check-public-env.mjs
docker compose --env-file deploy/.env.public -f deploy/compose.public.yaml run --rm --no-deps --entrypoint caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose --env-file deploy/.env.public -f deploy/compose.public.yaml up -d
docker compose --env-file deploy/.env.public -f deploy/compose.public.yaml ps
docker compose --env-file deploy/.env.public -f deploy/compose.public.yaml logs --tail 100 funding caddy
```

只用 `config --quiet`；普通 `config` 或 `config --environment` 会展开真实秘密。构建会执行已有自动化测试和专用部署预检测试。预检通过后应用启动并建立数据库；Caddy 等待应用健康再启动。启动顺序依据 [Compose 健康依赖](https://docs.docker.com/compose/how-tos/startup-order/)。`depends_on` 不会在后续应用故障时自动关闭 Caddy，故障时仍应监控并排查。

首台服务器应记录构建版本及实际拉取的 Caddy 镜像 digest，后续发布先验证再升级。当前 `caddy:2-alpine` 是可移动标签；不能把它当成不可变版本。发布过程中不要同时修改 DNS、代理层数和应用版本。

从**另一台设备及网络**检查：

1. 真实域名以 HTTPS 打开，证书可信、界面及静态资源正常，HTTP 自动跳转 HTTPS；没有浏览器安全警告。
2. `/api/health` 返回成功，`/api/config` 的 `paused` 为 `true`，`limits.minAmount` / `maxAmount` 为 `10` / `100`。健康接口仅证明应用进程存活，不证明入金供应商或目标链健康。
3. 暂停提示清楚，新报价被阻止；应用端口 8787、开发端口 5173 和代理管理端口 2019 不对公网开放。仅配置预期的公开入口。
4. 目标浏览器具备安全上下文和 Web Locks；钱包扩展/内置浏览器可被识别。此时无需连接或签名来证明页面可以部署。
5. 验证日志无秘密、重建容器后数据库仍保留、备份脚本成功；资金开放前还需在暂停环境完成一次恢复演练。

不得把开发机直接运行的 Node 测试当成目标服务器的容器、HTTPS 或备份恢复验收。

## 5. 小额资金验收与重新暂停

完成上面的目标环境检查后，由用户明确安排本人钱包小额测试与异常处理人员。将 `.env.public` 的 `PAUSE_NEW_ORDERS` 改为 `false`，限额保持 10–100来源稳定币单位，并重新创建应用容器：

```sh
docker compose --env-file deploy/.env.public -f deploy/compose.public.yaml config --quiet
docker compose --env-file deploy/.env.public -f deploy/compose.public.yaml up -d --no-deps --force-recreate funding
docker compose --env-file deploy/.env.public -f deploy/compose.public.yaml ps
```

重新检查 `/api/config` 的实际暂停值，再按 [ACCEPTANCE.md](ACCEPTANCE.md) 执行首次小额转账、到账证据、刷新/跨标签页恢复等验收。金额取有效报价允许的小额值；Tron 钱包另需足够 TRX/资源支付授权及付款成本，界面报价不代表最终链上资源费用。不得替用户输入助记词、代签、代发或把测试金额说成退款保证。

关闭本次测试时，将 `PAUSE_NEW_ORDERS=true` 并执行同一组重建命令。**编辑 env 文件或单纯 `restart` 都不足以载入新的容器环境。** 暂停只阻止新报价和新订单，既有订单可查询、上报原交易 hash、继续后台核验；重建会有短暂服务中断。暂停不能撤回已经签名或广播的交易、不能撤销链上授权。

未知资金状态时保留订单与凭证，停止扩量并按 [OPERATIONS.md](OPERATIONS.md) 排查；不要删库、手改到账状态或要求再次付款。当前没有自动退款、自动告警投递和全天值班能力。通过一次小额测试不代表可以无上限公开推广。

## 6. 一致备份、恢复与更新

运行中的数据库通过备份脚本生成快照，不能直接复制一个仍在写入的 `funding.sqlite`：

```sh
deployment_backup_name="funding-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
docker compose --env-file deploy/.env.public -f deploy/compose.public.yaml exec -T funding node scripts/backup.mjs "/backups/$deployment_backup_name"
```

脚本使用 `VACUUM INTO` 并检查 SQLite 完整性，拒绝覆盖同名文件。默认快照保存在宿主机 `/var/backups/perpdock/`，文件权限为 0600；记录成功时间、版本与文件名，不公开文件内容。按经授权的方式定期复制到服务器外的加密存储，另存对应的原订单密钥；仅保留在同一 VPS 不能防止整机丢失。Caddy 数据卷含证书私钥，同样只允许管理员及受控备份访问。

恢复演练和故障恢复遵循以下顺序：

1. 设为暂停并按第 5 节重建应用；先对当前仍可读取的数据库做一份新的快照。保存当前发布版本、原密钥、目标快照文件名与时间。
2. 停止应用：`docker compose --env-file deploy/.env.public -f deploy/compose.public.yaml stop funding`。这时 Caddy 可能返回 502，属于明确维护窗口。确认没有第二个 funding 实例连接同一数据卷。
3. 由管理员在离线状态挂载 `perpdock-public-funding-data`，先将原 `funding.sqlite` 及存在的 `funding.sqlite-wal` / `funding.sqlite-shm` **一起保留到独立目录**，不要删除。检查所选快照的 `PRAGMA integrity_check` 为 `ok`，再将其复制为数据卷根目录的 `funding.sqlite`，属主 1000:1000，权限 0600。不得遗留属于旧数据库的 WAL/SHM，也不得覆盖运行中的数据库。
4. 恢复对应的**原** `ORDER_TOKEN_SECRET`，确认暂停仍为 true，再执行 `docker compose --env-file deploy/.env.public -f deploy/compose.public.yaml up -d funding`。检查健康、密钥匹配及保留浏览器中原订单的只读查询，禁止新付款来验证恢复。
5. 恢复后的后台会重新读取在途订单，但快照时间之后的新订单可能缺失。结合保留的原数据、用户订单号和公开链上凭证完成核对；未解释的缺失或异常解决前不要解除暂停。备份完整性成功不等于资金对账已完成。

上述离线数据替换应先在独立演练卷演练，不能将首次尝试直接作为生产恢复。当前部署材料未在目标服务器完成恢复演练。

发布更新时先暂停、做一致备份并记住上一个镜像版本，再构建/拉取已验证镜像和重新创建应用。保留同一数据卷与原密钥；若版本包含数据格式变化，应先验证前后兼容和恢复计划。回滚应用代码不能自动回滚资金或数据库。修改 Caddy 配置后先 `validate`，再重建 Caddy；管理 API 已关闭，不能依赖 `caddy reload`。

## 7. 监测与本轮交付记录

至少关注进程/HTTPS、5xx 和 429、供应商认证/超时、积压订单与最长核验时长、磁盘空间、最近备份和恢复演练时间。应用日志已避免记录请求体、访问令牌和秘密；对外求助时仍需检查并仅提供必要的脱敏片段。单实例内存限流会随重启重置，不是抗 DDoS 服务。

| 检查 | 本轮结果 |
| --- | --- |
| 部署文件与环境模板 | 已准备；模板秘密为空，默认暂停，单笔上限100来源稳定币单位 |
| public env 专项测试 | 根代理及安全组独立运行，18/18 通过 |
| Compose 静态语义 | 根代理以合成测试配置验证构建/挂载路径、唯一 80/443 入口、预检命令、健康依赖、固定卷名与暂停限额；通过。未读实际秘密 |
| Docker 容器启动 | 未验证；开发机 Docker daemon 未运行 |
| Caddy 配置实际解析、TLS、公网连通 | 未执行；目标服务器先运行 `caddy validate` 再启服务，真实 DNS/TLS、公网端口隔离和转发头需另行验证 |
| 目标服务器备份恢复、钱包资金闭环 | 未执行；不能以静态检查代替 |

根代理已完成手册复核，安全组最终审查未发现阻断「保持暂停的部署准备」的问题。该结论不等于服务器部署或真实资金验收通过。持续记录见 [部署任务记录](team/PUBLIC-DEPLOYMENT.md) 与 [独立审查](team/PUBLIC-DEPLOYMENT-REVIEW.md)。本手册不包含注册商购买操作、云服务器购买授权或真实账户凭据。
