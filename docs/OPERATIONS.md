# 部署与运行手册

## 适用边界
单实例 Node 服务 + SQLite 持久卷。钱包签名在用户浏览器内完成；服务器只报价、存单与读取状态。可先以暂停新入金状态部署公网并完成目标环境检查，再开启受控小额资金验收；对外市场试点前必须完成 docs/ACCEPTANCE.md 的资金验收。公网域名和自动HTTPS配置见 [PUBLIC-DEPLOYMENT.md](PUBLIC-DEPLOYMENT.md)。本工程不包含资金托管/人工代签/自动退款服务。

rc5 默认Ethereum主网USDT，共审核七网络九路线，含6条EVM网络8个链币组合及原Tron USDT。精确资产与合约说明见 [场景清单](SCENARIO-COVERAGE.md)。原生USDC、USDT0、Binance-Peg USDT不得混同，BSC为18位。EVM可选注入钱包，原生Gas按来源使用ETH/BNB/POL，Tron使用TronLink/TRX。每条路线资金闭环仍需本人验收；公网尚未部署。

## 配置
从 `.env.example` 建立未提交的 `.env`。生产必须设置：
- `ORDER_TOKEN_SECRET`：至少32字符的高熵稳定随机值。只在密钥管理器/安全环境变量保存；不可更换后丢弃原值，否则已有订单无法恢复，服务会拒绝启动。
- `PUBLIC_ORIGIN`：市场测试域名的HTTPS origin，例如 `https://funding.example.com`。不要在真实配置中保留示例域名。
- `RELAY_API_KEY`、`TRONGRID_API_KEY`：自己的服务商凭据。开发只读请求曾可免密成功，这不构成供应商永久免费/可匿名访问的承诺。API拒绝访问或schema变化会停报价。
- 源链RPC：`ETHEREUM_RPC_URL`、`ARBITRUM_RPC_URL`、`BASE_RPC_URL`、`OPTIMISM_RPC_URL`、`POLYGON_RPC_URL`、`BNB_RPC_URL`。仅服务端运营配置，默认公开端点见env样例。必须能读取对应主网chainId、代码/decimals、交易/收据及finalized/canonical区块；禁止用户请求传URL。新报价健康成功缓存60秒、失败15秒，单网络/token故障独立关闭其路线。不可将含 API 令牌的完整 URL 写入日志、错误消息、客户端或聊天。公共 RPC 不构成可用性保证，限流/异常时应保留待核验状态，不能跳过最终确认。
- `DATA_DIR`：可持久写入的专用目录。包括funding.sqlite、WAL和SHM。运行时不可用只读临时目录代替。
- `MIN_AMOUNT` / `MAX_AMOUNT`：稳定币单位的业务限额配置最多6位小数，默认10/1000；这不改变实际token付款按6或18位转换；不得超过协议适配器审核范围。后台同样校验，不信任前端。

## 启动
本地可直接 `npm ci && npm run build && npm start`。Node 24 LTS为目标生产运行时。

Docker环境：
```sh
docker compose up --build -d
docker compose logs -f funding
```

Compose只将8787端口绑定宿主机127.0.0.1，数据在`funding-data`卷；应用以非root用户运行，只读根文件系统。切勿用`docker compose down -v`删除含用户/在途订单的卷。

以上为原本地 Compose。外部服务器按 [公网手册](PUBLIC-DEPLOYMENT.md) 显式使用 `deploy/compose.public.yaml` 与服务器私密 `.env.public`，避免误用另一份配置和数据卷。用户资金验收使用管理员提供的 HTTPS 环境，不要求用户在开发电脑登录钱包。

本次开发主机Docker daemon未运行，因此Dockerfile/Compose交付的是部署配置；容器启动验收必须在具备Docker daemon的目标机器或CI执行，不能将Node直接启动测试当成容器测试。

## HTTPS与反向代理
在服务前配置自有TLS终结代理，转发到127.0.0.1:8787。代理必须覆盖客户端提供的转发头，例如Nginx：
```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 45s;
}
```
只有确认应用唯一入口为该可信代理、后端端口不直连公网时，才设置`TRUST_PROXY_HOPS=1`以正确识别客户端IP限流。否则保持留空。若还有CDN/其他代理，不可直接增加信任跳数；需单独设计可信代理规则。

## 暂停与恢复
设置`PAUSE_NEW_ORDERS=true`并使新环境生效，会阻止新报价及新建订单；已经创建的订单仍可查询、补交原交易哈希并继续后台核验。修改环境文件本身不会实时热加载生产进程；Docker 环境必须按公网手册重新创建 funding 容器，单纯 `restart` 不会载入新值。暂停不能撤回已广播交易。

恢复时先检查凭据、供应商配置、测试报价和异常订单，确认原因解除后再设false。禁止通过删除数据库、手改completed状态或重发付款来“修复”未知在途资金。

## 备份
在有数据库读取权限的环境运行：
```sh
node scripts/backup.mjs /secure-backups/funding-2026-10-12.sqlite
```
脚本通过SQLite `VACUUM INTO`取得一致快照并做integrity_check，拒绝覆盖既有文件。示例路径必须换成自己可写且受保护的备份位置。另行备份`ORDER_TOKEN_SECRET`；开发时是data/order-token.key，生产来自密钥管理器。

恢复：先暂停并停止原服务，保留现状备份，将快照恢复为DATA_DIR/funding.sqlite，确保不存在属于另一数据库版本的WAL/SHM旁文件，恢复原密钥，再启动核验。不得直接覆盖正在运行的数据库。恢复后后台会读取并重新核验在途订单，只读查询不会再次转账。

## 监测与异常处置
- `/api/health`只证明进程存活，不证明上游或路线健康。另用`/api/config`检查路线是否开启，定期只读报价探测外部依赖。
- 关注HTTP 5xx/429、上游认证错误、连续查询失败、長时间`source_pending/bridging/verifying_credit/attention`。日志仅记录请求ID、路由、状态码、时长，不记录令牌和请求体。
- 用户已付款时，先索取本应用订单号和公开交易哈希；不索取助记词、私钥或钱包授权截图中的秘密。
- `source_pending`：按订单原路线排查。EVM要按订单来源核对对应chainId、token、付款from/to/input/value、成功收据及精确token Transfer 及 canonical/finalized 区块；仅 receipt 成功或供应商 success 不够。Tron 要核对交易固化、执行成功和匹配 USDT 事件；未知时等待查询，不能让用户再付。
- `bridging`：按Relay requestId追踪，不把超时当作退款。
- `verifying_credit`：核对Relay目标hash与同收款地址HL账本、默认Perps、USDC及最小额。入到现货或证据不足不得手动标成功。
- `attention`：保留原始订单与两端凭证，向实际路由服务方处理。平台不承诺所有异常都能立即退款；退款记录也应独立链上核验。

Ethereum 最终确认及本应用核验可能约15分钟或更久；HL 有可能先到账而页面仍等待来源最终确认。这不是重复付款的理由，也不能因等待时间长而手动改成功。界面不把 Relay 的1秒处理估计当作总到账时间，不能据此设置1秒超时告警。具体依据见 [Ethereum 官方说明](https://ethereum.org/roadmap/single-slot-finality/)，实际核验以链上证据为准。

排查协议标识时区分应用订单号、Relay requestId 和 `Quote.protocolOrderId`：最后一项为重算验签后的协议 order hash，绑定EVM付款calldata；不是供应商查询用 requestId。新EVM报价含该字段，旧 Tron 订单缺省仍应能恢复，不能据此删除或重建旧单。

## 市场试点前
完成用户签名小额资金闭环、浏览器版本覆盖、目标环境部署验收和备份恢复；明确测试用户范围、单笔限额、有人处理异常的支持入口。当前版本不含多租户伙伴账单、自动告警投递或7×24值班服务，扩量前补齐。

资金验收按路线分别记录，不能用一条路线或另一人的历史只读证据代替本单资金闭环。USDT 精确授权可能包含“旧额度归零 → 新额度授权 → 付款”多笔链上交易，均由用户本人核对与签名，并另备对应ETH/BNB/POL/TRX；不承诺固定 gas 费用。手机布局通过不等于手机钱包签名和恢复已通过。

## 用户端常见异常

未结清unknown/signing/submitted付款会在全本机范围阻断新入金，允许查看历史与继续上报原hash。记录损坏、孤立marker或查询失败也保守阻断；不要让用户清缓存来解锁。只有服务器强入账证据结清原单，不能靠本地改状态。不同设备/主动清除数据超出本机保护边界，保存订单收据与公开交易hash协助核查，不向聊天索取访问令牌。

交易所直接提币不执行路由所需approve/deposit；应先提到本人受支持链自托管钱包，不能直接转到平台或depository。未支持Solana、USDC.e、原生币兑换、法币入金给明确指引，不指导向未知地址转账。钱包加速/取消导致hash替换时保留原单进入人工核查，不能任意覆盖已绑定hash或重发入金。
