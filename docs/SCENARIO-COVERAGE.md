# Perpex 首版入金场景与验收范围

目标：用户把自己已有的钱包稳定币转为自己 Hyperliquid **默认 Perps 账户的 USDC 保证金**。本应用负责路线报价、钱包发起、订单保存与链上入账核验；不托管用户私钥，不运营平台充值余额。

## 链与资产清单

每项绑定明确 chainId、token 合约和精度；同名资产不能替代。当前代码共八个网络、十条路线：8 条 EVM、Tron USDT 和 Solana 原生 USDC。2026-10-22 新增 Solana 的范围、协议核验和待验收条件见 [Solana 说明](SOLANA.md)；其余路线保留原实现。最新自动化结果见 [验收记录](ACCEPTANCE.md)。代码支持不代表本轮已经部署或完成各钱包的真人资金验收。

| 网络 | 资产 | 精度 | 手续费币 | 区分事项 |
|---|---|---:|---|---|
| Ethereum 主网 | USDT、原生USDC | 6 | ETH | USDT仅ERC-20审核合约 |
| Arbitrum One | USDT0、原生USDC | 6 | ETH | 上游有时仍把USDT0标为USDT；USDC.e不在此范围 |
| Base | 原生USDC | 6 | ETH | 不把其他桥接USDT当成这条路线 |
| Optimism | 原生USDC | 6 | ETH | 旧USDT与新USDT0合约不同，本版不混接 |
| Polygon PoS | 原生USDC | 6 | POL | 不接受USDC.e |
| BNB Chain | Binance-Peg USDT（BSC-USD） | 18 | BNB | 映射资产；不是Tether在Ethereum发行的ERC-20原币 |
| Tron | TRC-20 USDT | 6 | TRX | 使用TronLink付款 |
| Solana | 原生 USDC | 6 | SOL | Phantom / Solflare 浏览器扩展；需独立 0x 收款地址 |

完整合约白名单见 `shared/route-registry.ts` 、`shared/solana.ts` 与 Tron provider 常量。EVM固定depository按每链审核，不允许任意链沿用同地址。

资产身份依据：[Circle官方USDC合约表](https://developers.circle.com/stablecoins/usdc-contract-addresses)、[USDT0官方部署表](https://docs.usdt0.to/technical-documentation/deployments)、[Tether支持协议](https://tether.to/en/supported-protocols/)、[BNB Chain官方SDK资产区分](https://github.com/bnb-chain/mpp-sdk)、[Relay输入核验规范](https://docs.relay.link/references/api/api_core_concepts/input-validation)。金额精度另由链上decimals()实测，symbol只用于显示，不作为可信身份。

## 用户流程与边界

| 场景 | 本版行为与支持边界 |
|---|---|
| 资产已经在钱包 | 选真实来源网络和资产，选钱包，读取真实余额，填完整HL地址，报价后按来源链执行必要授权及付款；Solana 无 allowance 授权 |
| 同时安装多个钱包 | 可从实际发现的provider选择；连接后余额、链、授权和付款固定同provider |
| 钱包未安装/锁定/拒绝连接 | 明确提示检测不到或连接未获准，不自动重复弹窗 |
| 手机使用 | EVM 可使用已配置的 WalletConnect；Tron 使用 TronLink。Solana 本轮仅支持浏览器扩展，手机及硬件钱包未验收；检查持久存储/Web Locks |
| 当前只有localhost测试页 | 明确地址只在当前电脑可访问，不能让另一台手机访问127.0.0.1；待部署方提供HTTPS地址 |
| 资产在交易所 | 先提到自己控制的受支持链钱包，网络/币合约一致并准备原生手续费，再连接入金。不得直接转USDT给平台或路由合约 |
| Solana USDT、USDC.e、原生ETH/SOL、法币或未列出的币链 | 说明本版暂未接入；不生成报价/付款地址，不伪装可用 |
| 已有HL账户 | 填自己控制的HL主账户地址，核对完整地址；付款钱包可相同也可不同 |
| 新HL地址、余额为0 | 保留真实查询结果和报价，不承诺激活费用或到账时间；确认自己控制地址 |
| 不同付款/收款地址 | 必须二次确认；不自动勾选所有权确认 |
| HyperEVM/Spot/子账户或API代理地址 | 本次目标仅默认Perps；不能把其他资产位置当作保证金入账，不建议填不控制的地址 |
| 钱包切错链/账户 | 报价、授权与付款受阻；切换正确网络后重新确认；晚到旧请求不能覆写新上下文 |
| 金额空白、负数、指数、超精度、低于最小/高于上限 | 在签名前拒绝；所有金额用字符串与BigInt按真实token精度转换 |
| Token余额不足 | 显示真实不足，签名前再读；“全部”只针对该token，不虚构扣除固定Gas |
| Gas为0/不足/无法读取 | 展示对应ETH、BNB、POL、TRX 或 SOL 说明；EVM先读取余额及当次交易估费，未知不显示为0，估算不保证未来足额 |
| 已有足额授权 | 不重复发授权交易；付款仍独立确认 |
| USDT旧授权非零不足 | 清零→成功回执与额度核对→精确授权→成功核对；每一步复核链、账户、到期 |
| 报价过期或批准后过期 | 只在尚未付款时重新报价；旧链上授权不会自动撤销；不能静默用旧报价继续付款 |
| 明确拒签、未返回hash | 可重新尝试；不将未知错误当成拒签 |
| 网络错误或钱包返回不明 | 保存unknown/signing标记，停止新付款，先查看原钱包交易记录 |
| 已有hash但后台上报失败 | 第一时间保存hash；恢复后仅上报同一交易并继续核验 |
| 刷新、关闭页面、断网、跨标签 | 保留订单凭据与独立付款标记；全本机未结清付款持续显示，不因切到别单而绕回重付 |
| 本机存储损坏/禁用/额度满/孤立marker | 严格阻断新付款，保留原记录；不给“清除数据重试”指引 |
| 数据被用户清除或换设备 | 本机保护不能覆盖另一设备；保存订单收据和公开交易hash供核查。公开hash不能代替私有订单访问凭据 |
| 交易加速/取消/替换nonce | 核对钱包实际交易；已绑定hash不允许任意覆盖。遇替换记录不匹配进入人工核查，不再次发起同一笔入金 |
| 源链未最终确认、RPC故障、链重组 | 保持待核验；不以latest、收录或总体余额变化宣称完成；受影响来源暂停新报价 |
| Relay延迟/失败/报告退款 | 保存原订单继续核查；失败不代表资金已退回，不自动重付或代用户退款 |
| Relay显示成功但HL未匹配到账 | 继续核验指定地址的默认Perps账本；只有源付款、协议记录和目标交易入账证据齐全才完成 |
| 服务维护或单条路线不可用 | 真实可用性与原因；单链失败不伪造成功或拖成其他链可用，旧订单仍可查 |

## 交付证据应区分

- 单元/隔离测试：覆盖真实应用代码的错误分支，但其中钱包/RPC测试响应只存在tests。
- 主网只读：真实链和路由服务、签名报价核验、未签名订单、生产进程重启与SQLite备份恢复；不发生资产转移。
- 用户资金验收：需用户在自己设备的钱包亲自批准和付款，再核对HL到账。完成前不能标作已验收。
- 部署：本机进程与交付配置已准备不等于Docker、域名、TLS、公网设备已部署成功。

当前最终验收结果以 `docs/ACCEPTANCE.md` 本轮记录为准；具体源链和钱包每项状态不可由“支持列表”推断为已完成真实付款。
