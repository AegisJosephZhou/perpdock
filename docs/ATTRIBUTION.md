# Dock 第一方渠道归因

这是一项默认关闭、尽力记录的推广配套功能。它不改变报价、签名、付款或到账验证，不代表网站已经启用分析。浏览器来源标签可伪造，随机 tab 会话不等于独立真人或已验证客户；这些数据不能自动推导收入、CAC、LTV 或因果增量。

## 配置与链接

管理员仅在正式环境配置和发布后才能开启：

```dotenv
ATTRIBUTION_ENABLED=true
ATTRIBUTION_CAMPAIGNS=x_cn_launch_20261021,x_en_launch_20261021,partner_example_pilot1,test_attribution
```

默认未设置或设为 false 时，不创建分析数据库，不向浏览器提供采集配置，不保存来源。启用但 campaign 配置缺失/非法也不采集。campaign 是明确白名单，最多 100 个；每个为 1–64 个小写字母、数字、下划线/连字符，以字母或数字开头。不要在 campaign 中放姓名、钱包地址、令牌或其他个人数据；白名单由管理员审核。

示例渠道链接（示例不表示实际合作或已开启采集）：

```text
https://dock.perpex.ai/?utm_source=x&utm_medium=organic_social&utm_campaign=x_cn_launch_20261021&lang=zh
https://dock.perpex.ai/?utm_source=partner&utm_medium=referral&utm_campaign=partner_example_pilot1&lang=en
```

`source` 仅为 `x`、`partner`、`community`；X 对应 `organic_social`，其他对应 `referral`；语言来自实际 UI 语言，只有 `zh`/`en`。未知 campaign、重复营销参数、错误组合或额外采集字段均不归因。其他普通页面参数不上传；完整 URL/referrer 从不写入分析。

上述限制只覆盖本应用的归因存储与日志；现有 CDN/反向代理是否记录访问 URL/query/referrer 需由部署团队单独检查，不能据此断言整条部署链都不记录 URL。

首次合法来源在 tab 会话内固定，30 分钟后到期；刷新可通过 sessionStorage 恢复，跨设备/跨浏览器/被复制的标签页不能当作同一个人。切换 UI 语言不改写既有会话首次语言。存储被禁用时使用内存；关闭采集时只清本功能的 sessionStorage 项，不碰资金恢复记录。

## 记录与隔离

- `/api/attribution/landing` 是唯一浏览器采集入口，只接受 `{sessionId,campaign,source,medium,lang}`。它有独立的每 IP 每分钟 20 次额度和 1 KiB JSON 限制，正常 landing 不消耗资金 API 额度。没有客户端“付款/成功”事件接口，也没有公开报告接口。
- 成功报价在既有服务校验和订单库保存成功之后记录；订单从 quote ID 继承来源。建单、源链最终确认、经证据核验的默认 Perps 到账由服务端持久化状态驱动。重试、刷新、重复上报使用首次时间/唯一键去重；失败报价、pending、缺少到账证据、未知来源不会计为成功。
- landing 请求丢失而报价成功时，可保存该报价的合法来源，但 `landing_at` 留空，报告单列 missing landing。没有把后来的报价伪造为一次已观察页面浏览。
- 数据独立保存在 `DATA_DIR/attribution.sqlite`，不修改 `funding.sqlite`、资金事件、订单凭据或旧订单。分析仅存来源、随机 session ID、内部 quote/order ID、route ID 和服务器时间，不存金额、钱包、资金交易哈希、令牌、原始错误或 URL。内部 ID 仍是私有分析资料，不应直接公开数据库。
- 采集故障/锁冲突最多等待 25 ms，然后停止该进程后续采集，并仅记录固定 `attribution_unavailable` 诊断；资金业务继续。修复后重启方可恢复。资金与分析不构成同一个事务，因此故障会少计，不会通过回填猜测成功。
- 最多保存 10,000 个 session、50,000 个成功 quote、50,000 个 order；满容量时丢弃新的分析行并增加有限容量计数，既有订单阶段仍可更新。30 天以上的 session 与其关联分析按首次观察时间在启动及最多每天一次的写入时清理；资金库不受影响。旧 cohort 的后续阶段也随其删除，报告覆盖因此受限。删除复用 SQLite 页面，不自动 VACUUM 大文件。

## 离线脱敏报告

在有权限的本地环境，从管理员提供的一致分析备份或原分析库进行只读查询；不要拷贝正在运行的 SQLite 主文件而遗漏 WAL。无需网络、钱包、资金库或订单令牌。使用仓库已安装的 Node 24 和 tsx：

```sh
node --import tsx scripts/attribution-report.ts --database /private/path/attribution.sqlite --from 2026-10-22 --until 2026-10-29
```

日期为 UTC，`from` 包含、`until` 不包含；PDT 的运营日需另行对应时间边界。本版按首次会话观察日期和 campaign/source/medium/lang 输出聚合，后续阶段截至本次读取；不要当作按事件日计算的转化率。输出含观察到的 landing 会话、缺 landing 的会话、成功报价、建单、已确认来源交易、已核验完成单及完成会话数；没有原始标识或资金字段。

未归因和旧订单不在报表中；`test_*` 和 `internal_*` campaign 自动排除。团队测试请专用这些前缀，不能用正式营销 campaign 后宣称自然用户转化。session 仍不区分机器人或同人多 tab，因此完成会话数不是客户数。报告容量丢弃计数是整个分析库生命周期值，不是所选 cohort 的值。数据库缺失/不兼容时报不可用而非输出 0；空 cohort 仅表示无已记录归因会话，不表示网站无人使用。

本次开发只验证隔离数据；实际部署开关、生产数据与站点转化均未读取或启用。
