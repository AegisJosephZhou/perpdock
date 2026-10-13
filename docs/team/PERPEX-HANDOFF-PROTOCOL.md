# Perpex 上线交接：协议与联调脚本独立复核

审查者 protocol_architecture；2026-10-12。只读审查 scripts/live-smoke.ts、scripts/production-smoke.mjs、README、docs/API.md、docs/CONTRACT.md，并核对现有订单/协议与验收手册。未读真实.env或运行库，未执行任何联调、签名、广播或资金测试；由root统一运行。

## 结论与当前范围

两个脚本均没有钱包连接、私钥、sign/sendRawTransaction或其他广播调用，不调用`/orders/:id/transaction`，不伪写completed。其网络资金链路止于真实路线/账户查询和报价。它们确实会经应用POST /quotes、POST /orders写入未付款测试记录，因此“只读”指主网资金，不等于应用数据库只读。没有新增资金逻辑阻断；发现1项测试脚本错误日志收口和2项交接注意，见下。

### P2-H1：live-smoke失败断言可能打印测试订单访问令牌（请root修正后再跑）

位置 `scripts/live-smoke.ts:43`：`assert.equal(repeat.body.accessToken, created.body.accessToken)`在断言失败时，Node AssertionError会输出actual/expected，即两个订单查询令牌。production-smoke已用boolean比较加固定文案避免此问题；live版本应同样改为 `assert.ok(repeat.body.accessToken === created.body.accessToken, 'Idempotent retry did not recover the same order credential.')`。建议也不将整份可能含accessToken的created.body作为assert错误消息（目前38行），改固定安全消息。

这不是私钥泄漏或资金广播漏洞，但测试交付日志不应携带订单凭据。本组只报告，由root修改其scripts所有权。

### 交接注意H2：live-smoke默认会写既有8787后端，不具备自身隔离

`live-smoke.ts`默认SMOKE_BASE_URL=http://127.0.0.1:8787，amount固定100USDT且断言paused=false。当前本机8787有需要保留的运行数据，因此root本轮应显式将SMOKE_BASE_URL指向**独立临时DATA_DIR/secret的服务端口**；不能把它作为“只读检查”直接跑到原用户运行库，也不能在外部暂停部署上运行它后因预期失败误判部署不可用。暂停目标环境用health/config/account/static/CSP检查即可；完整quote/create联调只在授权的隔离未暂停环境运行。正式用户付款不使用脚本中的两个公开研究地址。

### 交接注意H3：资金验收步骤需指向外部HTTPS环境

截至首次读取，docs/ACCEPTANCE.md“用户小额验收操作”第1步仍要求本机127.0.0.1:8787，与本轮用户不在开发电脑登录钱包的边界不同。请root在交付前将当前操作入口改为外部团队提供、已完成暂停部署验收的HTTPS域名；文中保留旧本机记录可以作为历史证据，但不作为接下来用户的签名步骤。建议域名deposit.perpex.ai尚未部署，不可写成现已可访问。

## 两个脚本的真实覆盖

| 脚本 | 主网调用 | 新增应用状态 | 隔离/不覆盖的部分 |
|---|---|---|---|
| live-smoke.ts | Relay chains/validated quote、HL账户info经正式API | 一份100USDT真实报价和一个awaiting_signature订单；同幂等键再次create复用同单，读取无token拒绝/有token恢复 | 自身不建临时数据库，不启动服务；须由root提供隔离SMOKE_BASE_URL。不签名、不广播、不上报hash；不能证明实际执行/到账 |
| production-smoke.mjs | 同上，经真实Node24生产入口 | 独立临时数据库中同一未付款订单；重启、备份恢复后仍为awaiting_signature或expired，无sourceTxHash | mkdtemp、随机内存secret、随机loopback端口；同库重启与VACUUM INTO/独立恢复；清理自己目录/子进程。覆盖Node24进程，不是Docker/Caddy/DNS/TLS验收 |

production-smoke直接运行dist/server/index.js，不通过npm start的.env加载；DATA_DIR和ORDER_TOKEN_SECRET明确覆盖到临时值。它继承当前进程环境以读取显式供应商key，但不读取磁盘.env、不打印child输出或token。固定100USDT只在报价上使用，不涉及真实资产支出。用于检查结果的`status:'passed'`和`transactionBroadcast:false`是测试报告字段，不是订单入账状态。

脚本均创建无sourceTxHash订单；OrderService.refresh无sourceTxHash直接返回，因此这些订单不会由后台轮询自行变成bridging/completed。真实源hash只能由后续用户签名后另行上报，脚本中无此动作。production恢复还主动拒绝未付款订单出现资金状态，过期仅允许expired。

## 真实小额资金验收的最小证据

必须使用**本应用新建的当前有效订单**与用户自己控制的Tron/HL地址，不得拿公开历史记录或开发研究地址代替：

1. 保存订单号、源Tron地址、目标HL 0x地址、quote.amount / amountBaseUnits / minReceive、provider和原quote有效期；TronUSDT6位、目标USDC展示允许8位。批准人核对地址归属，所有钱包操作由用户本人完成。
2. 授权/付款区分：精确授权到经核验depository；已有非零不足额度可能先清零。授权成功不能作为付款/到账证据。需要真实付款txHash，并由后端核验同订单depositErc20参数、USDT、付款人、金额及orderId，Tron固化receipt成功且匹配USDT Transfer。
3. Relay同requestId必须绑定同sourceTxHash，并提供目标hash与正确Tron→HyperCore链路；provider success本身不足以通过。
4. HL默认Perps账本中同目标hash、同recipient、USDC、destinationDex空串（或已支持的internalTransfer）、正额且>=minReceive；实际金额写入creditedAmount，订单evidence中的hypercore_credit绑定recipient:destinationTxHash。权益余额变化、HyperEVM/现货余额、另一笔历史credit不接受。
5. 记录源tx、目标tx、最低/实际到账、检查时间和收据；刷新/关闭重开能恢复原订单，原hash继续核验不产生第二次付款。未知结果只恢复，不重付；缺证据保留核验中/attention，不手改completed。

## 小额金额和链费要求

- 当前应用路线最低10USDT；公网模板业务限额10–100USDT（每笔，并非日累计/邀请门禁）。首次可从10USDT请求实际报价，**需当前服务限额与供应商报价同时允许**，不是保证每次10USDT都可执行，也不是目标到账固定10USDC。脚本的100USDT报价不设定用户测试金额。
- 源钱包需另有足够TRX/能量/带宽资源。每次合约调用的Energy预算上限150TRX；Bandwidth另计，真实收费由钱包/执行决定。清零、授权、付款可能三次调用，不能把150TRX说成整单总手续费或要求一定烧掉150TRX。
- 120秒是应用签名窗口（可能取更早协议deadline），不是到账/退款倒计时。已签名/已广播但未知时保留原订单与hash，即使窗口过期也继续核验，不再付一笔。
- 目标HTTPS/CSP、Web Locks、桌面TronLink注入及txCheck能力、供应商目标地区访问、备份恢复必须先在外部环境验收。手机与真实钱包覆盖仍待测。解除暂停只用于约定的小额窗口，由用户本人签名，之后重新暂停；暂停不撤销已有链上授权/交易。

金额/字段依据为当前正式代码与部署配置；Tron资源术语依据 https://developers.tron.network/docs/set-feelimit 、https://developers.tron.network/docs/resource-model （同日已核对）。真实签名、主网付款与到账证据尚未由本审查产生。

## root 修正复核与执行证据收口（2026-10-12 15:00 PDT后）

已按root要求读取 `work/branding/TEST-HANDOFF-ROOT-NOTES.md` 和修订后的live-smoke.ts。

**P2-H1关闭。** token相等断言现为boolean assert.ok + 固定安全文案，失败不会将actual/expected令牌写入AssertionError；quote/create失败消息不再拼接整份response。文件头已明确仅对主网资金只读、会创建应用未付款订单且要求隔离后端。没有新增签名、广播、上报hash或伪写完成的代码。

**H2本轮执行方式已满足。** root统一记录production-smoke于2026-10-12T21:59:35.676Z成功，以其覆盖live-smoke基础链路，未在原8787数据库重复造单。该脚本本身的临时DATA_DIR/随机secret/随机loopback/清理逻辑已独立读码确认；此次运行结果依据root执行记录，不是本组重复执行。真实报价快照100USDT→expected99.749626/min98.752129仅为观察，不是用户测试价格承诺。

当前可将代码交给外部团队作**保持暂停的目标环境部署与验证**；不代表Docker、目标HTTPS/代理、真钱包与资金闭环已通过。`DEPLOYMENT-HANDOFF.md`已清楚指向外部HTTPS环境、桌面TronLink、用户本人签名及10USDT起的实际报价核验。最后读取时README/ACCEPTANCE仍在root同步中，H3需在打包前落实到验收操作入口；不要求为此改资金逻辑。

除已关闭的测试日志问题，没有新增资金逻辑代码发现。本组未运行测试/联调、未访问真实环境文件或数据库、未进行钱包操作。
