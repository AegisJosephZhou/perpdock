# 入金运营底账与离线报告

资金底账始终独立保存在 `DATA_DIR/funding.sqlite`。本功能不依赖渠道归因或漏斗采集开关，不建立公开运营查询接口，不访问生产钱包，也不改变付款、源链验证、目标到账证据或自动轮询的安全规则。

## 一笔订单的记录

`orders.payload` 保存订单快照，`order_events` 保存状态/提示变化历史，`quotes` 保存原报价。新增字段均为可选 JSON 字段，既有表结构、订单令牌、幂等键和源交易唯一规则不变，不需要重建数据库。旧单读取和恢复继续兼容。

新报价记录 `observedAt` 及当时报价使用的服务端路线信息 `sourceAsset`（来源链、chain ID、币种、代币合约/mint、精度）。订单保存来源路线、付款和接收地址、金额、预期/最低到账、源/目标交易标识、当前状态、实际核验到账金额及证据。目标 hash 可能先于完整到账核验出现；只有绑定本单收款人和目标账本、足额金额的既有完成守卫通过，才是核验完成。

| 阶段 | 字段 | 时间含义 |
|---|---|---|
| 报价 | `quote.observedAt` / `timings.quoteObservedAt` | 服务端取得并验证报价后的观察时间 |
| 建单 | `createdAt` | 服务端建单时间 |
| 签名开始声明 | `clientStages.signing.observedAt` / `receivedAt` | 浏览器声明时间 / 服务端接收时间；不证明签名已完成 |
| 广播调用返回声明 | `clientStages.broadcast.observedAt` / `receivedAt` | 浏览器声明钱包或发送调用成功返回；不证明链上可见、最终确认或到账 |
| 上报源交易 | `timings.sourceSubmittedObservedAt` | 既有 transaction API 接受并初步核验源交易标识的服务端时间 |
| 来源最终核验 | `timings.sourceConfirmedObservedAt` | 服务端首次观察到通过来源最终核验 |
| 目标到账核验 | `timings.creditVerifiedObservedAt` | 服务端首次通过本单目标账本完成核验 |
| 目标账本原始时刻 | `timings.destinationLedgerAt` | 精确匹配的 HyperCore 账本条目的原始时间，与轮询观察时间分开 |

`updatedAt` 会随查询或提示更新，不能作为阶段时间。`trackingCheck` 是最近查询的新鲜度，不是资金时钟。状态消息改变可以追加同状态事件；计算当前状态停留时长时，只在真正状态变化时重新计时。

阶段可能缺失或跳过。例如第一次上报源交易时已经最终确认，就不会制造一个早先的 source_pending 时间。旧订单可以从已有状态历史、报价表创建时间推导服务端观察时间；没有历史证据的签名、广播和账本时刻保持 null，不以 updatedAt 或迁移当天时间填补。只读报表在内存中推导；订单随后正常写入时可保留已有观察时间，离线报告本身不写回数据库。

## 授权客户端阶段记录

服务端方法为：

```ts
service.recordClientStage(orderId, accessToken, {
  stage: 'signing' | 'broadcast',
  eventId: 'UUIDv4',
  observedAt: '2026-10-22T12:34:56.789Z'
})
```

只有持有原订单访问令牌的调用者可以记录。只接受上述三个字段，拒绝 hash、金额、收款人、资金状态和 `completed` 等其他阶段。交易标识仍只走原 transaction API 和原验证路径。

每单每阶段只保留首次被接受的声明及服务端接收时间，最多两条，避免重复刷新和重试扩大数据。相同 eventId 的相同记录幂等；相同 eventId 用于其他阶段或不同声明时间会冲突。阶段上报可乱序，原始声明/接收时间都保留，不伪造顺序。未来超过5分钟或非规范 UTC ISO 时间被拒绝；在范围内的客户端时钟仍不可信，不用于资金完成率或完成耗时。

客户端只在钱包/发送方法成功返回之后上报 broadcast；Solana 在广播前保存签名的回调不属于该事件。该阶段也不代表节点接受或交易最终确认。失败或缺少这类可选记录不能阻断资金恢复，不能触发自动重付。

阶段方法与提交/刷新共享订单锁；存储事务还合并已保存的客户端阶段，避免慢查询的旧快照覆盖声明。它不更新资金状态、状态事件或 updatedAt。全量漏斗观察者在底账提交后收到独立克隆；观察者抛错或异步拒绝不会改变已提交的资金业务。

## 只读 JSON / CSV 报告

对管理员提供的一致 SQLite 备份执行，不要拷贝运行中主库而遗漏 WAL。命令只打开资金库的只读快照，设置 query_only，不调用 Store 构造器、不迁移、不清理、不执行链查询或付款。使用 Node 24 和项目依赖：

```sh
node --import tsx scripts/orders-report.ts \
  --database /private/path/funding.sqlite \
  --from 2026-10-22 --until 2026-10-23 --format json

node --import tsx scripts/orders-report.ts \
  --database /private/path/funding.sqlite \
  --from 2026-10-22T07:00:00.000Z --until 2026-10-23T07:00:00.000Z \
  --format csv --route solana-usdc
```

先由当前路线配置确认 `--route` 的精确ID；示例ID不是路线可用性保证。日期边界为 UTC、左闭右开，按订单创建时刻选择 cohort。PDT 日界示例为当日07:00Z至次日07:00Z，跨夏令时日期需另行换算。状态来自当前数据库快照，不是对历史日末状态的重演。

构建产物和 runtime 容器也可直接使用 `node dist/scripts/orders-report.js --database /private/path/funding.sqlite --from 2026-10-22 --until 2026-10-23 --format json`，不需要在容器中安装 tsx。仍应读取一致备份，并在私有位置保存输出；不要挂载或调用公开运营API。

JSON 包含一单一行 `rows`、总体 `summary`、`byRoute` 和 `byCreatedDayUTC`。CSV 仅输出一单一行及同样的字段，不混入汇总行。默认省略钱包地址、原始订单/报价ID、源/目标交易hash、访问令牌、状态原文、证据和私有上游数据；`orderRef` 为订单ID的短 SHA-256 引用，仍是私有运营资料，不是匿名公开数据。金额、路线、时间也不应公开上传。

如处理具体订单确需完整标识，在受控本地目录添加 `--include-sensitive`，会增加订单ID、付款/收款地址、源/目标交易hash和provider订单ID。令牌、密钥、上游payload和消息原文始终不导出。CSV 对每格加引号并转义引号，对公式起始字符及其前置空白/控制字符加文本前缀，避免表格软件执行公式。

## 指标口径

- `observedCompletionRate` = 同一来源确认队列中已有完整完成证据的订单数（`sourceConfirmedCompletedOrders`）/ 已上报来源交易且已有来源最终核验观察时间的订单数。`verifiedCompletedOrders` 单独保留全部证据完整的完成单，其中缺少来源确认时间的旧单计入 `verifiedCompletedWithoutSourceTimingOrders`，不加入该完成率的分子或分母。它不是所有访客的转化率。未签名、未上报源交易或仅客户端声明的订单不进入该分母。
- `matureObservedCompletionRate` 使用来源确认至少经过观察窗口的同类订单作为分母；默认30分钟，可用 `--maturity-minutes` 调整。窗口只是运营观察条件，未完成不自动成为失败；空分母为 null，不是0。
- 完成耗时分别统计建单→核验完成、服务器接受源hash→核验完成、源最终核验→核验完成，以及目标账本时刻→服务端核验完成。输出有效样本数、平均、nearest-rank P50/P95；缺失或负时长不混入样本。服务器观察耗时包含用户等待、轮询、索引和网络延迟，不称为实际链上转账耗时。
- `stalled` 是已有源hash、尚未completed且当前金融状态持续超阈值的核查候选，默认30分钟，可用 `--stale-minutes` 调整；不是已证明失败，不是再次付款指令。
- `requiresAttention`、`queryUnavailable`、过期且未上报源hash、客户端声称广播但服务端没有源hash分别列示。过期未上报不证明未付，浏览器未知付款仍需原单恢复。
- `attention` 中可能包含源交易不匹配、Relay退款报告、延迟或需要人工核查；没有将它整体当成终态失败。报告不计算未经验证的失败率或退款成功率。
- `timingAnomaly` 标出明显时间倒序/未来观察。旧字段缺失保留 null；没有将未知阶段或未知生产业务数据置为0。

全量订单底账报告包含旧订单及未归因订单，与只覆盖合法来源会话的渠道归因报告不同。报告没有收入、CAC/LTV、独立真人识别或精确源链广播/区块时刻。这些不从订单数、hash或客户端事件推断。

## 验证范围

隔离测试覆盖旧表/JSON兼容、离线读取不变更文件与schema、同阶段幂等和乱序、授权/输入拒绝、慢验证期间声明保留、客户端伪造完成拒绝、目标账本时间绑定、观察者故障隔离、统计分母/百分位、CSV公式中和与默认脱敏。未读取生产底账、未部署、未连接真实钱包或发送交易。
