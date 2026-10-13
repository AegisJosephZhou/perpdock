# 主要入金场景：钱包与资金安全扩展建议

Ethereum当前实现与独立审查见ETHEREUM-SECURITY.md。root已在SCENARIO-EXPANSION.md授权本组基于shared审核表实施多链钱包；下方矩阵仍保留建议与最终实测的区别。原则是逐条开放验证过的chain+token，不能把钱包“支持某链”当作这条资金路线已支持。

## 本轮新增接口契约（前端可据此接入）

- `listEvmWallets(): { id: string; name: string }[]`：同步发现本页面已注入/已公告的EIP-1193 provider；id仅当前页面会话有效，name是显示用途，不保证品牌身份。不连接、不发eth_requestAccounts。不提供二维码。MetaMask优先排序，之后Rabby及其他发现的provider。
- `connectEvm(walletId?: string): Promise<string>`：无参继续原默认优先级；传参必须匹配listEvmWallets的id，不存在即拒绝，不默默改连另一家。连接成功后所有操作pin同实例。
- `sourceNativeBalance(route: Route, source: string): Promise<string>`：仅审核表EVM路线；同已选provider的eth_getBalance/latest，18位原生币格式字符串；账户/链前后复核。Tron请勿调用。异常reject，不伪造0。
- `preflightPayment(quote: Quote, route: Route): Promise<void>`：付款前只读校验。对EVM核对route/quote/context、当前token余额/allowance、native balance及本笔已审核deposit的eth_estimateGas×eth_gasPrice估算；已知不足/0Gas/读取失败均reject；返回值没有余额数字，也不是保证交易必成。Tron保持已有真实余额/allowance路径，不引入未经核实原生Gas估算。App必须在executeOrderPayment之前调用，以免已知未签名前失败被标unknown；钱包sendPayment内部仍复核。
- `approveExact`内部对每笔approve(0)/approve(amount)在请求前做原生Gas余额与本笔估费检查，receipt与额度正确后才下一步。各笔估费只是当时估算，不覆盖整个多笔总预算，不设置实际钱包gas字段。
- `switchEvmChain(chainId)`保持签名：仅允许registry中的chainId；遇钱包明确4902时使用registry公开元信息请求添加网络，再切换并实读确认，不接受用户/报价RPC URL。
- 现有connectTron、getAllowance、sendPayment等签名不变。前端新测试须mock新增只读接口；旧钱包测试provider会补eth_getBalance/eth_estimateGas/eth_gasPrice，保持调用实际付款函数。

金额按registry真实decimals做BigInt转换，BNB映射USDT18位不截成6位；如果root单独决定业务输入精度上限，再由shared合同统一，不在钱包静默截断。

## 钱包实现已落盘（2026-10-12，可集成）

新增接口均按上方契约实现。`client/wallets.ts`现在以shared审核registry核对chain/token/decimals/symbol/depository，使用每条实际chainId发送；BNB 18位不经过6位换算。公开protocolOrderId与规范deposit ABI仍严格绑定，真实Relay附带的gas/fee字段仍不会直接转发。旧Tron执行分支保留。

EIP6963/legacy发现返回会话内稳定id，支持明确选择provider；未知id不回退，连接拒绝不替换原已选实例。4902添加网络只用registry的公开RPC/浏览器/原生币元信息，再实读chainId；畸形hex quantity拒绝。sourceNativeBalance读真实同provider原生余额；preflightPayment与实际EVM发送前均复核token余额、allowance、native余额及当前单笔Gas估算。审批每笔也估算检查，额度清零成功但Gas用尽时不会发下一笔。按root新增registry.approvalPolicy，审核USDT/USDT0在非零不足时先清零，原生USDC直接一次精确授权，不按symbol猜策略；Tron原行为保留。尚未引入permit。

估费不等于保证总费用足额：每次仅检查当前call的estimateGas×gasPrice，L2数据/结算费和后续费用波动可能要求更多原生币。没有给钱包传自定gas/fee上限，最终费用与授权仍由钱包确认。无法估计时在签名前阻止，不能伪造0或宣称安全足额。App须在executeOrderPayment之前调用preflightPayment；钱包中的复核是再次保护，执行marker之后异常仍按保守unknown处理。

已新增tests/multichain-wallet.test.ts，使用tests/fixtures/multichain的公开真实8路线deposit calldata，provider RPC只在tests隔离。覆盖全部8条EVM真实捕获调用、BNB第18位最小单位、registry篡改、0Gas/不足Gas/token不足/估费错误、估费后chain/account/到期变化、清零后Gas耗尽、Base USDC审批回执、显式钱包选择、late announce、未知id/拒签不回退、4902安全添加、无效网络编号。

运行4个钱包文件：multichain-wallet、ethereum-wallet、wallet-context、wallet-execution，**95/95通过**（新增多链33 + Ethereum38 + 原Tron/上下文24），随后typecheck通过。不是全工程最终验收数字。尚未替用户连接或签名任何真实钱包，手机实机资金兼容性仍待本人验收。后端/前端多链最终落盘后继续只读交叉复核。

随后按root审批策略复核新增5条原生USDC非零不足额度各只发一次精确approve回归，同4钱包文件**100/100通过**（多链38 + Ethereum38 + 原Tron/上下文24），typecheck通过。

## 多链后端与严格存储helper独立审查

已只读复查relay.ts、evm.ts、ethereum wrapper、evm-rpc.ts、shared registry及8条真实quote fixtures/协议回归。未发现新链绕过chain/token/decimals、跨链复用source hash、绕过finalized或放松HL默认Perps证据的问题。RPC健康检查按网络与token分缓存，chainId/finalized/code/decimals失败分别关闭对应路线；旧单依旧能核验；60秒成功、15秒失败缓存只是短期观察，不是持续可用保证。服务端RPC秘密未进入shared或钱包addChain；通用HTTP错误不回显URL。

严格存储helper已经覆盖全列表、独立marker、孤立marker和超过20单的付款记录，原每单付款协调器未变弱。**P2-S1（请root修复）：** `client/api.ts` readLocalPaymentState仍使用 `JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')`，空字符串坏JSON会被默认为空列表，违反新helper“坏JSON一律阻止”的合同。独立marker仍能揭示孤立付款，但仅inline保存的历史记录在列表损坏为空字符串时会被当无历史，persistSavedOrder也会覆盖该坏值。建议仅null使用'[]'，空字符串必须JSON.parse失败；将`''`加入已存在malformed saved orders参数化回归。除此之外未发现需阻断的helper问题；App全局锁及孤立marker提示待前端最终落盘后复核。

**P2-S1复核关闭：** root已改为`?? '[]'`，malformed saved orders回归包含空字符串；null初始存储仍正常，损坏内容不被覆盖。

**P1-R1（本组最初编号P2-S2，同一发现）已在钱包ownership内修复：** App公告监听器刷新listEvmWallets，后者重复requestProvider可能引发provider再次公告，产生同步递归或异步无限公告循环。钱包discovery改为先安装持久公告监听器，每个页面session仅初始化发一次request，后续list只读；晚加载钱包会公告并被捕获。初始化标志在dispatch前设置，保证同步重入也只读；并未用setTimeout推迟循环。新增实际EventTarget同步/异步公告→UI刷新列表两条回归，不mock发现函数。API未改，前端无需适配；根代理要求的完整App真实发现回归由前端补充。

该修复后4钱包文件**102/102通过**（多链40 + Ethereum38 + 原Tron/上下文24）。当时全局typecheck只报前端正新增的tests/scenario-ui.test.tsx中sequence初始化两处；钱包文件无类型错误，需前端完成后由root最终收口。

App已先行只读审查：全局锁`hl-funding.active-payment.v1`包住全本机严格扫描/服务端完成证据核对/本机快照复核/预检/原付款协调器，与单订单锁不同名；报价、建单、授权同样检查未决记录。检查失败/孤立marker阻止新资金动作；历史可浏览、已付款仍可report/refresh，不被新付锁封死。预检在executeOrderPayment前，已知余额/估费失败不先写unknown。该设计关闭P2-E1的代码路径，待前端组件回归覆盖跨订单及storage事件后正式关闭。

## 最终独立复核收口（2026-10-12）

前端第6节声明最终落盘后，重新阅读实际App全局锁、恢复helper、强完成缓存和对应组件测试，并独立运行 `tests/scenario-ui.test.tsx` + `tests/local-payment-state.test.ts`：**2文件37/37通过**（场景组件22 + 严格存储15）；随后 `npm run typecheck`通过。早先前端在建测试的sequence初始化错误已消失。本组自己的4钱包文件最新102/102通过；不与root全工程测试重复合并成最终验收数量。

- **P2-E1关闭**：unknown A→历史未付款B、unknown A→已完成B均不能新建/新付；另标签保存unknown与全局锁占用均阻止新付款。历史查看和原交易上报保留。只有服务器真实返回且满足hasVerifiedCredit的订单能结清，缺证据completed、恢复失败、坏存储/孤立marker保持阻断。严格扫描不依赖选中订单。
- **P1-R1关闭**：钱包同步及异步公告回归均通过；真实App测试没有mock发现/连接函数，模拟同步EIP6963扩展、再次公告与4秒列表轮询后仍只发一次发现请求，且连接落到该provider。没有把递归转成定时循环。
- **P2-R2关闭**：仅页面内存缓存经服务端核验的完成订单，以id+accessToken为键；没有本地“相信已完成”flag，没有缓存unknown/失败/未付状态。完成态停止自动轮询，25已完成订单+未知单回归中，完成项单页只读一次、未知项反复核验，状态经强证据完成后才放行。并发相同订单读取复用当次promise，后续未决读取不复用旧结果。
- **P2-S1关闭**：空字符串坏JSON不被视为空记录，保留损坏数据且阻止新付；35项root存储/付款回归中的对应安全断言未弱化，本组重跑其中15项严格存储也通过。

在本次读到的多链后台、钱包执行、严格恢复及最终App范围内，未发现尚未处理的P0/P1/P2资金安全阻断。主要边界仍是：钱包provider与服务器RPC被信任；Gas预检只是当前单调用估算；本机同源恢复不能覆盖人为清空数据或别的设备；所有真钱授权/付款及实际手机钱包兼容验收仍由用户本人完成。根代理负责全量测试、真实只读生产smoke、浏览器验收和最终打包，本报告不宣称已签名或已到账。

## 建议在本轮落地的优先顺序

1. **共同registry替代散落常量**：所有开放路线固定routeId、chainId、protocolChain、审核depository、token地址/精度/显示名称、native gas名称、来源验证器/最终确认策略、官方浏览器前缀。前后端依据同一审核清单做独立校验；上游/客户端config不能自行增加资产、spender、链或decimals。后端实时验证Relay元信息与registry匹配，某路线不满足只关闭本路线。
2. **收口本机所有未知付款**：先修ETHEREUM-SECURITY.md的P2-E1，再扩更多路线。用户在历史页查看别单，不能静默绕过A未知付款直接生成B当重试。优先采用单未结清入金策略；若产品明确允许多笔并发，则至少在新建前强制显示所有待核查订单，并让用户明确确认是另一笔独立入金，而非恢复原付款。当前用户需求未要求并发入金，严格策略更易验证。
3. **可用钱包能力与Gas预检**：在实际签名前核对当前account、chain、token balance、allowance、native balance；显示具体缺失项。预检和报价都不发送交易。错误或超时不能显示“余额为0/网络不支持/付款失败”。
4. **钱包明确选择与手机能力检测**：本版本可以先覆盖MetaMask与Rabby注入provider的选择和一致性，以及手机钱包内置浏览器的能力检测/恢复。不要在没有WalletConnect配置与真实集成时显示可扫码连接。
5. **每条开放路线一份真实报价验签fixture + RPC finality能力回执**，再共享通用钱包的金额/授权/付款/恢复测试。不能仅添加下拉项就标可用。

## 场景与交付行为矩阵

| 场景 | 用户可见行为与安全决策 | 本轮最小验证 |
|---|---|---|
| 只装MetaMask或只装Rabby | 发现正确provider并显示所选钱包；连接、余额、切链、授权、付款使用同一对象 | 分别注入各provider，其他对象不得被调用 |
| 同装多个钱包/晚加载 | 推荐默认MetaMask，但允许显式选择；连接后禁止因为全局ethereum改写而换钱包。rdns/isMetaMask是自报标识，不能称身份认证 | EIP6963前后加载、同rdns多实例、legacy冲突、用户换provider后清除draft确认 |
| 钱包未装/锁定/未授权/拒绝 | 分开显示未检测到钱包、需解锁、未批准连接、用户已取消；不擅自重复弹窗。只在明确拒绝且无hash时解除本次付款标记 | 无provider、空accounts、4001、4100、4900/4901、重复点击 |
| 错误网络/网络未添加 | 显示目标链名称与chainId，用户操作触发切链；未确认正确链前不能报价或签名。是否自动添加链需使用审核registry的公开RPC，不取报价URL | wrong chain、拒绝切链、切链后账户改变、RPC返回畸形chainId |
| 多账户/硬件钱包签名较慢 | 当前账户与订单payer不一致就阻止；收款地址始终完整展示。硬件钱包归于provider能力，未实测不宣称兼容 | accountsChanged、链变更、长时间钱包窗口、hash返还前后过期 |
| 手机普通浏览器 | 未注入provider则解释需在受支持的钱包浏览器打开，给正式站点URL复制；不声称已连接，不以UA字符串假定可用 | 无注入、应用切后台、重载后原订单恢复、断网恢复 |
| 手机钱包内置浏览器 | 检查provider、HTTPS、持久storage、Web Locks；任一付款安全能力缺失即阻止发送并给可行替代。具体钱包/系统版本只有实测后才能列入已验证名单 | iOS/Android需真人亲签前只读兼容验收；隔离测试模拟缺失locks/storage/事件 |
| USDT已有非零不足授权 | reset0→成功有效receipt→额度0→精确授权→成功receipt→精确额度；每一步重新核对账户/链/到期 | 中间revert、timeout、取消、错误receipt、切链、reorg后额度异常，不自动继续 |
| USDC/其他审核token | 精确批准固定spender，不引入permit或无限授权；是否需要归零是registry明确策略，不从symbol字符串猜 | 不同token审批策略、足额不发交易、授权额度被撤销、旧审批仍留链上 |
| 代币足够、Gas为0或不足 | 显示需要该源链原生Gas币。ERC20余额足够不等于能交易；已读到native balance为0可阻止。估费失败显示无法评估，不冒充余额不足 | 0Gas、部分Gas、source balance变化、估费RPC失败、费用上涨 |
| 多步授权的Gas预算 | 先告知最多清零+授权+付款三笔分别消耗Gas。可用estimateGas与当前fee给有时间戳的估算；尚未批准前deposit估算可能失败，不据此判路线不可用 | 每一步独立估算/receipt后刷新；不把报价gas字段直接用作钱包交易上限 |
| 输入金额与快捷全部 | 严格十进制字符串→route.decimals→BigInt，不用浮点数换算。ERC20全部只指token，不扣虚构固定Gas；原生币入金另设模型，当前不开放 | 最小/最大/超精度/指数/负数/空值/千分位；6与18位差异 |
| 同名假币/USDC.e/跨链同地址 | 清楚显示网络、token合约、发行/封装名称。读取余额/approve/deposit/源Transfer全部绑定相同registry元组 | 同symbol不同合约、同地址不同链、上游decimals/token替换、Native USDC与桥接USDC错配 |
| BNB等18位“USDT” | 不沿用当前6位校验；必须独立核实发行/封装资产性质、链/合约/精度与官方证据。来不及全链路验收则排除，不显示假可用 | 18位最小单位金额差分；同数值在不同precision不得复用quote |
| 签名拒绝 vs 发送结果未知 | 4001且无hash可重试；其他发送错误保留unknown。页面关闭/到期不等于失败；返回hash立即保存，后续仅核验同一hash | 超时、畸形hash、广播成功但网络断、report失败、storage失败、撤销窗口后晚到hash |
| 同订单双击/多标签 | 每单Web Lock和独立持久标记；另标签拒绝发送；新建其他订单也检查未结清全局策略 | 锁占用、storage事件、两个不同订单竞争、历史切换绕过 |
| 本机storage损坏/禁用/额度满 | 不将损坏记录默认为“无历史付款”；付款前必须可持久保存。独立submission键也需扫描，不能只依赖截断的最近20单列表 | JSON坏数据、保存一半失败、订单列表被另一标签覆盖、孤立submission键 |
| 不同设备/清除浏览器数据 | 诚实说明本地保护边界；提供下载订单凭证和源hash，恢复凭据应单独设计加密/令牌导入。不能说凭一个公开txhash可访问任意私有订单 | 缺accessToken、错误token、丢失storage、下载文件不含服务端密钥 |
| HL同地址/其他自有地址/新户 | 可填付款0x地址，但仍显式确认控制权；其他地址二次确认；新户费用/最低额只采用实际可验证报价，不硬编码激活时点保证 | 不同recipient、0地址、失效checksum、旧报价接收人不可改、账户查询不可当到账 |
| HyperEVM/Spot已有币 | 永远说明本单目标默认Perps USDC；“HL地址有币”不是保证金完成凭证 | 只有余额变化、Spot/HyperEVM事件、错误Dex、错fillhash、少于minReceive都不得完成 |
| 交易所直提/托管钱包 | 这条路径要求钱包签approve与deposit；请先提到本人受支持链的自托管钱包。不能给平台充值地址或让用户直接转USDT到depository | 页面明确来源类型提示；没有地址生成/兑换所API密钥/自动提币流程 |
| RPC/Relay故障、退款、换交易nonce | 原单持续核查，暂停受影响新路线。替换/取消交易hash必须手动上报且通过本单calldata核验；不允许换hash覆盖已绑定订单 | 超时/429/重组、取消tx/错nonce替换、已绑定hash不可覆盖、退款状态无自动重付 |

## 复用代码建议与ownership边界

- `getReviewedRoute(route)`返回registry条目并比较传入route的不可变字段；EVM钱包采用条目chainId/token/decimals/depository/approvalStrategy，去掉当前函数体内chain1/USDT硬编码。保留 `validateQuoteContext` 与规范ABI重编码绑定protocolOrderId；不要接受任意config提供的合约。
- `sendEvm`接受已验证chainId，仍只调用一次eth_sendTransaction并立即保存hash。其所需data必须由已审查模块生成；不接纳任意第三方交易bundle、authorizationList、permit、accessList。
- `readFundingReadiness`可汇总token balance、native balance、allowance、chain与账户，但结果必须携带context key（provider实例+routeId+account+quoteId）和观察时间。UI异步旧结果不得覆盖新选择；签名前再核对。
- `approvalStrategy: reset-if-nonzero-insufficient | exact`与token配套；receipt校验的to来自该已审核token，不是全局USDT常量。不能放松回执字段防御检查。
- 跨订单保护建议由root扩client/api.ts/payment.ts和前端组扩App统一实现，钱包组不自行写多份状态。应有独立浏览器级资金操作锁和未决扫描；completed状态应来自服务端证据复核，别以本地flag自行解锁。完成旧订单的submission记录可保留用于审计，但必须保存已核实状态供筛选，而不是让旧submitted永久阻塞所有新单。
- 源链验证器泛化需保留每条链finalized策略及RPC能力测试。不能把Ethereum“约15分钟”的提示套给所有EVM链，也不能把L2 sequencer收录直接叫作与Ethereum相同的最终确认。

## 本轮上线验收应保留的事实边界

代码/模拟provider测试证明安全分支；真实/quote验证证明服务当前提供路线；RPC只读确认metadata与finalized能力。三者都不等于真人钱包已签名、某手机已兼容或真实资金已到HyperCore。未经亲签验收的项在支持矩阵标“协议及只读验证通过，钱包资金流程待本人验收”。不能把所有链或钱包数量当作目标而放松pin和证据。

参考一手规范（2026-10-12读取）：[EIP-6963](https://eips.ethereum.org/EIPS/eip-6963)说明多provider发现及自报身份边界；[EIP-1193](https://eips.ethereum.org/EIPS/eip-1193)定义provider事件与错误；[Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/)定义余额、估费、交易与区块读取；[W3C Web Locks](https://www.w3.org/TR/web-locks/)是跨同源执行环境锁定能力规范。这些规范不是本产品对所有浏览器/移动钱包已实测兼容的证明。
