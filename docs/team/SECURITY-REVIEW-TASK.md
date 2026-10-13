# 独立协议代码审查任务
负责人 risk_security。本任务不修改你自己写的后端，请独立审核 protocol_architecture 的 server/providers/**、server/chain/**、tests/protocol.test.ts。所有发现写 SECURITY-REVIEW.md，阻断项需带真实代码位置、触发场景与建议，不编造漏洞。
重点：Relay quote中的payer/refund/recipient/token/amount/orderHash/solver签名互相绑定；Tron固化交易匹配和未确认行为；来源转账日志；HL credit归属；API失败/响应大小/超时；getOrderId独立实现与官方SDK差分及缺失检查；实际quote过期语义。
不要绕过原负责人所有权直接改协议代码；给MD发现并通知root和协议组文档路径。可写 tests/security-review.test.ts 做可复现回归测试（失败测试请明确说明）。检查通过同样写覆盖范围和残余限制。
