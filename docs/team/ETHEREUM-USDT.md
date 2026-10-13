# Ethereum 主网 USDT → HyperCore：rc5 开发任务

用户要立即测试入金，持有 MetaMask 里的 Ethereum 主网 USDT。必须增加真实路线，不能要求先转Tron，也不能只改按钮。保留Tron路线和旧订单恢复。真实钱包签名/付款只由用户本人完成。

共同要求：所有实质沟通/发现记录在MD，工具消息只指向文档；禁止读取/输出真实.env、密钥或钱包资料；测试桩仅在tests；不要替用户签名/广播。不在现有8787运行数据库造测试单，root统一独立临时库联调。工作目录 /Users/aegis/Documents/Codex/2026-10-12/kan/outputs/hl-funding。

新路线契约：id `ethereum-usdt-hypercore`，chainId=1，walletType=evm，symbol=USDT，decimals=6，token 0xdAC17F958D2ee523a2206206994597C13D831ec7（先通过官方资料/真实链元信息核实）。默认优先Ethereum路线；destination=HyperCore 1337、默认Perps USDC，保持现有8位账本精度与强到账证据。

## protocol_architecture：后端实现与协议测试

拥有 server/providers/relay.ts、server/chain/ethereum.ts（新增）、相关独立测试 tests/ethereum-*.test.ts；必要时调整原协议测试但勿弱化。可读其他代码，勿改client/shared/order-service。

1. 获取真实Relay /chains /quote/v2 Ethereum→HyperCore 响应并核实官方文档/部署合约，保存测试fixtures去秘密公开样本。root也会获取一次真实快照供共用，见后续本MD。
2. 扩展来源链分派，不能把Tron校验直接跳过。保留严格orderId重算、solver签名、代币/decimals/付款人/接收人/金额/退款去向/无未知调用/精确授权。EVM原生value必须0，deposit calldata按真实协议解析绑定订单，pin审核合约，requestId全步骤一致。
3. 增加Ethereum真实来源交易核验：通过可靠HTTPS RPC，chainId=1，tx/from/to/input/value匹配quote与order，receipt成功、精确USDT Transfer到depository；以finalized标签确认且核对canonical block/hash，未确认返回pending，RPC异常不能判成功；不能仅靠provider success。
4. trackOrder按quote.routeId分派源验证和chainId，证据类型按源链生成；目标HL账本强核验原样保留。各路线独立availability，不能Ethereum失败带关Tron。
5. 真实链HTTP/RPC不可用fail-closed，外部RPC URL只服务端配置，不来自用户请求。记录默认RPC选择/超时/最终确认延迟，root同步部署与CSP。
6. 测试篡改报价、源交易/receipt/chain/block/Transfer错误、pending、老Tron兼容、源链追踪分派。只运行自己的必要测试，root最后全量。
7. 结果 docs/team/ETHEREUM-BACKEND.md。若真实Relay路线不支持或接口形态有阻断先写清，不编造响应。

## risk_security：EVM钱包实现+独立复核

拥有 client/wallets.ts、tests/ethereum-wallet.test.ts（新增）。先读现有EVM分支，它尚未作为开放路线实际验收。

1. 用MetaMask完成Ethereum USDT精确授权和付款，主网chainId=1；优先正确MetaMask provider，禁止连接MetaMask却被另一个钱包签名。钱包/account/chain切换和到期均须阻止不匹配签名。
2. Ethereum USDT非零不足授权需先approve(0)再精确approve(amount)，每一步receipt成功后继续；用户拒绝/失败不能视为付款。禁止无限授权，绑定审核spender与USDT。
3. 校验EVM付款calldata/to/value/amount/source/order上下文，广播hash必须第一时间持久保存；钱包eth_sendTransaction可能已广播但结果未知时保持恢复锁，绝不重付。沿用原安全框架。
4. meaningful tests覆盖精确清零授权、错误spender/calldata/value/chain/account、reverted receipt、签名未知与hash处理；RPC使用钱包provider时与当前钱包一致。无真实钱包调用。
5. 后端落地后只读独立审查（不编辑agent后端文件），结果 docs/team/ETHEREUM-SECURITY.md，资金风险发现交owner修复。

## product_delivery：前端真实双路线

拥有 client/App.tsx、必要client/styles.css、tests/ethereum-ui.test.tsx；不改wallets/server/shared。

1. 真实config提供Ethereum/Tron双路线，默认按返回顺序Ethereum优先；清楚写Ethereum主网USDT，MetaMask/Rabby付款、ETH手续费；Tron继续显示TronLink/TRX。
2. 连接EVM付款钱包后可在HL地址为空时填入同一0x地址，但不可自动勾选归属确认；支持用户填写不同地址并保持二次确认。无需让同一个MetaMask重复连接才能取收款地址。
3. 错误链时引导切换Ethereum主网；在错误链上不允许报价/付款。切换路线清理旧余额/报价/确认/allowance上下文，旧订单恢复必须回到原路线，付款未知时不得切换逃逸。
4. 删除硬编码Tron路线文案，费用/进度由真实route/quote渲染；没有假余额、成功或倒计时进度。不改已审查到账证据语义。
5. 写必要UI回归：双路线选择、ETH fee文案、错误链阻断、同地址填入但未确认、原Tron保留、旧订单恢复；与walletagent约定现有函数签名保持。
6. 结果 docs/team/ETHEREUM-FRONTEND.md。不要运行全量套件或更新最终验收数字，由root统一。

## root集成

统一review差异、README/API/CONTRACT/deploy文档/CSP/环境配置、真实10/100USDT报价与新路线隔离production smoke、全量测试/build、浏览器路线检查、保持旧数据重启、新rc5打包。订单服务和shared若需修改由root处理。不要将真实报价/测试桩当用户资金已到账；只能交付到可由用户亲签验收这一步。
