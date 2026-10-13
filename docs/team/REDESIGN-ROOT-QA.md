# root 改版验收计划与记录

改的是现有真实前后端应用，不运行用户HTML的演示脚本。旧版本完整源归档为 hl-funding-v0.1.0-rc1-source.zip，可用于变更对照。后台及钱包底层执行逻辑此次保持原实现；UI状态和防误导展示由独立评审复核。

## 验收清单（下方记录执行结果）
- strict typecheck / production build / 全部自动化回归，包括新增jsdom React界面测试。
- 实际127.0.0.1:8787浏览器：默认未连接、无扩展连接错误、无效HL地址、公开研究地址真实余额、空历史、390/1440px布局及无横向溢出；无真实钱包注入，不伪造付款/完成页面截图。
- 新构建静态资源/CSP、生产依赖audit；后端若无代码变动，沿用已完成的Node24/真实API/备份恢复证据，不重复主网报价来增加无效订单。
- 页面记录动态金额/最低到账/精确授权/恢复链路由隔离React测试和原支付执行回归覆盖。真TronLink签名与资金闭环依然需要用户本人完成。
- 最终更新README/ACCEPTANCE和截图，并重新打包rc2，排除.env、运行库、node_modules。

## 特别检查
root审阅正在改版的App，建议完成态显示进一步绑定：creditedAmount >= quote.minReceive、合法destinationTxHash、hypercore_credit.reference 精确等于 recipient:destinationTxHash（大小写标准化）；不要只检查正数及type。有后台异常completed时，进度摘要也不能直接回显含“已到账”的statusMessage，要显示“等待入账证据核验”。请frontend实现，测试组增加这几项坏响应的UI回归。这是展示层防回归，不改现有后端判断。
复制出来的旧“completed金额不足时回退expectedReceive”不允许进入新页面；只有明确creditedAmount及可绑定证据才显示已到账。awaiting没有本机submission留存入页，unknown，即使order读取错误也不能露出新付款。拒签仅在明确没有hash时允许重试。详情中“签名窗口”与“预估处理时间”分开，已广播订单不显示“报价失效=付款失败”。

## 初步资金路径对照
已逐字节对照rc1源码归档，server/**、shared/**、client/api.ts、client/payment.ts、client/wallets.ts均无变化。此次独立复核集中于App展示/状态迁移和隔离测试，原协议/签名/持久化回归仍随全组执行。

13:31本地首轮 strict typecheck通过；此时CSS仍在收尾，最终构建/浏览器验收待完整落盘后执行。

## 最终集成结果

- 最终全量：Node24.19.0运行 `node node_modules/vitest/vitest.mjs run --configLoader runner`，7文件113/113通过，无skip/预期失败（20:31:33 UTC）。其中UI回归25项，独立安全审查已通过。
- `npm run build` exit0，strict typecheck/Vite453 modules/服务端编译均通过；主JS547.52kB，gzip168.89kB，体积提示仍存在，无新增构建错误。
- `npm audit --omit=dev --json`：0 vulnerabilities。新增jsdom及类型仅为devDependencies，不进入生产runtime。
- 新版HTTP200、安全响应头/CSP有效；浏览器1440与390px布局通过，手机document.scrollWidth=clientWidth=390。新截图已保存在docs/screenshots/redesign-*.jpg并实际检查。
- 浏览器无TronLink时明确报扩展缺失；非法接收地址不允许报价；订单记录空态及返回正常。真实公开研究地址在20:30:44 UTC返回权益/可提9.56，读后清空地址，未勾选归属、未签名。控制台warning/error为空。
- 两项独立展示审查收口：completed金额/最低额/recipient/hash证据绑定；本机有hash但后台awaiting/expired显示等待核验原交易。前端资金执行文件与后台文件均保持rc1原内容。
- 实际钱包签名、广播、HL资金到账仍待用户本人测试；不宣称资金端到端通过。新版服务继续在127.0.0.1:8787运行，未发布公网。
