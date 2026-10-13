# root 集成记录

2026-10-12 用户已明确从零开发、只做入金首版，并愿意在最终小额资金验收时亲自用钱包签名。

package.json、TS/Vite/Vitest配置与 shared/types.ts 已创建。后端与协议模块统一使用该类型文件；NodeNext import 请带 .js 扩展。ProviderQuote 含服务端私有 providerData；后端持久化但对浏览器返回前删除。跟踪时用 TrackedOrder 恢复私有 providerData。getRoutes等具名导出与 ProviderAdapter 接口一致。后端端口8787、Vite5173；生产后端同时服务 dist/client 静态资源。

协议具体provider尚待验证，不得提前对外承诺route available。暂无私钥、付费API、部署账号或测试资金。

## 同步 1
- 协议组已验证 Relay 真实 API 返回 Tron USDT → HyperCore (1337) 报价。所有成员阅读 PROTOCOL.md 第一轮真实结果，尤其 Tron trigger 参数并非已构造交易。
- shared SourceVerification.pending=true 表示尚未最终确认，valid=false 仅用于确定不匹配；暂时上游异常应 throw，不抹掉资金状态。后端统一按该已有类型实现，无需 confirmed 字段。
- completed 必须有 type='hypercore_credit' 的可归属证据，不能只用 provider success 或余额差。
- 前端请创建 client/index.html，Vite root=client，入口 /main.tsx；不是仓库根目录 /client/main.tsx。
- Node/npm 普通沙箱无法 DNS，root 统一通过批准的 npm 安装；所有 agent 不要并行修改 package.json 或执行安装，新增依赖需求写本文。

## 同步 2
- 接受协议组 @relay-protocol/settlement-sdk 依赖，root 在基础 npm install 完成后串行安装。getOrderId本地校验不得省略。
- 质量门槛已写 QA.md。用户已同意最终自己签名小额资金测试。真实签名在软件审核结束后进行，当前不得替用户转账。

## 同步 3
- 基础依赖和 @relay-protocol/settlement-sdk 已安装。
- npm audit 发现 Vitest 3 的已知漏洞，root 升级至 4.1.11；请使用常规 describe/it/expect API，避免依赖旧版本私有接口。
- root 将创建 Docker/部署/操作文档、真实只读 API smoke；其他负责人只写本组 tests，避免修改统一 scripts。

## 协议组待决：SDK生产依赖审查
npm audit发现 @relay-protocol/settlement-sdk 0.0.147 引入未使用的Solana/Anchor/TOML与旧viem/TronWeb依赖，生产树有高风险告警。root不打算强制升级破坏性transitive版本。
请协议组考虑：仅为本产品支持的Tron/EVM/Hyperliquid实现MIT来源的最小order hash适配，使用已安装且修复的顶层viem hashStruct；保存官方源版本及许可证，将SDK降为测试devDependency，用官方SDK对真实报价和篡改测试向量做差分验证。不是自行设计加密协议，也不得省略orderId验证。若判断不适合，请在PROTOCOL.md说明替代方式与可达风险。实现其他链码无需携带。

## 同步 4
SDK已转开发依赖；npm audit --omit=dev为0告警。Vite/Vitest统一加--configLoader runner解决本机默认配置打包挂起。真实完整HTTP API smoke已通过（2026-10-12T19:13:47Z），包含实时报价、HL账户读取、创建未签名订单、幂等及权限隔离；未广播资金。
root新增tests/wallet-context.test.ts，前端请与该测试联调。后端组完成后转独立协议审查，见SECURITY-REVIEW-TASK.md。
# root 浏览器验证补充
已定位开发白屏原因：Vite 的 /api 前缀代理错误拦截源码 /api.ts，导致模块返回后端404JSON。已将 proxy 改为 ^/api/，生产构建原本不受影响。浏览器生产模式已见真实路线/公开账户9.56余额/无钱包与非法地址阻断；公开研究地址并非用户控制，验收后清空。
