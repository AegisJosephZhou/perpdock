# 2026-10-12 用户授权：按原型改真实入金产品
用户看完原型评审后说“改”。root 按现有真实可用项目进行产品化，不是另做demo，不扩大到交易/B端控制台。参考源：桌面 HL入金通道 可点击原型.html，可只读文本；评审在 ../../../../work/prototype-review-notes.md（实际workspace work下）。浏览器安全策略禁止直接打开本地HTML，不可绕过或原样另起服务器执行。我们重写自己应用的React界面，预览自己的已授权HTTP应用。

## 所有权/协作
- product_delivery：只负责 client/App.tsx、client/styles.css、必要的纯展示组件 client/components/** 和 docs/team/REDESIGN-FRONTEND.md。不改wallets/api/payment/server，保留真实执行逻辑。
- protocol_architecture：独立评审新UI的金额/真实路线/账本状态映射、示例金额污染、主网资源文案，报告 docs/team/REDESIGN-PROTOCOL.md。只读源代码，不修改前端；可写必要tests但先在MD协调。
- risk_security：tests/redesign-ui.test.tsx，隔离jsdom的React UI流程回归，拥有测试文件；root安装jsdom。不得把测试stub放到运行时或浏览器页面，不请求签名。
- root：依赖、集成、浏览器真实只读验收、截图、文档与打包。所有实质沟通通过MD，工具只通知MD路径。

## 视觉与交互目标
原型的米白 #F5F6F4、炭黑 #14181F、深绿 #0E7C66；品牌PerpDock。移动优先，主内容单列 max-width约520px，桌面也专注单个入金流程，去掉工程后台侧栏。响应式宽度，不固定844px高度、不加假的手机外壳。系统中文字体和系统等宽字体，无新外部字体/第三方资源。清楚的52px主按钮和易读文本。

两个主要页面：①存入Hyperliquid（填写、报价、签名确认）；②入金进度（已提交/恢复/成功/异常）。未付款订单仍在第1页，支付记录或sourceTx出现后切第2页；从本机历史恢复正确页；可以安全返回入金/历史但不能导致重复付款或丢弃原记录。正在操作禁止导航切单。无来源或无接收确认不准签名。

入金页从/到卡片：真实来源网络、钱包连接、真实余额、金额、25%/50%/全部快捷键（BigInt精确并按源精度取整，全部不超过min真实余额/服务端单笔上限；按钮在余额未知时禁用；明确另需TRX）；目标HL默认Perps USDC净到账大数，无报价显示—；最低到账；收款0x地址可完整查看/编辑、可连接EVM取得，显式确认，与Tron源T地址分开；收款权益折叠成次要信息而非主面板。完整地址长行换行不溢出。

费用/路线用真实quote，主摘要只来源→HL默认Perps，不硬编码Arbitrum；细节可折叠，保留最低额、provider、网络费/TRX、警告、120秒本应用签名窗口倒计时。不要写固定0.2%/30秒/5USDC，不添加模拟数据。正式动作依次报价→确认报价创建订单→精确授权→钱包付款；视状态显示当前主按钮，至少下一步钱包动作清楚。继续使用executeOrderPayment、getAllowance、approveExact等原生产路径、防双击ref/跨标签锁/持久化，不能为简化视觉删安全约束。授权完成≠付款成功。fee_limit最高150TRX且授权付款分开费用，付款前可看到。报价过期提供重新报价，已有hash/unknown不新付。

进度页显示本单动态源数量/预计或实际目标数量、完整接收地址、订单号、源tx、真实状态时间线、最近更新时间、原hash继续核验、下载凭证、历史记录入口。只有backend completed+hypercore_credit显示已核实到账；报价过期不等于已广播订单失败；不许假倒计时成功、不许承诺不会丢失/自动退款/通知/客服未实现。说“可在此浏览器的订单记录恢复”；异常提示不要再次付款。有已签名未知标记时禁止新付款，保留原恢复入口。

首版无交易/持仓/AI客服/B端费用收益页；不放无法执行的返回合作钱包/通知按钮。历史用可访问的独立面板或页面；完成后可开始新入金。

## 测试要求
root已安装jsdom及@types/jsdom开发依赖，并将vitest include扩展为tsx，client/index.html标题/主题色改为PerpDock。其他client内容归前端负责人。
root将安装jsdom dev用于隔离组件测试；risk_security可用ReactDOM createRoot + act + jsdom，不必增加testing-library。覆盖：未连接/非法接收不可报价；真实读数渲染；25/50/全部限额/精度；动态quote最小到账；awaiting签名页；source_pending/unknown转进度并防再次付；completed无证据不显示到账；历史恢复与两屏导航；拒签可重试/过期阻断沿用已有执行测试。可mock api与wallet方法仅tests。frontend完成后root跑全测试build，使用已有127.0.0.1:8787生产服务浏览器看真实余额+390/1440尺寸；真实资金验收继续待用户本人签名。
