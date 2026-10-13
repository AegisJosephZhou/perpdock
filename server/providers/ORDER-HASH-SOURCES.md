# Relay order hash 来源记录

`order-hash.ts` 为本项目独立编写的受限 v1 协议编码适配，使用 viem `hashStruct`，不自行设计哈希算法或签名算法。只支持本产品需要的 Tron、EVM、HyperCore 地址编码，拒绝额外 calls、fees 和未知版本。

协议事实来源：
- https://docs.relay.link/references/api/api_core_concepts/input-validation （2026-10-12 访问）
- npm `@relay-protocol/settlement-sdk@0.0.147`，`dist/order/index.js` 的 v1 EIP-712 字段定义、`dist/utils.js` 的协议地址编码，用于独立实现的互操作差分验证。
- 官方 npm 元数据：author `Uneven Labs`，license `MIT`，repository `https://github.com/relayprotocol/settlement-protocol/packages/sdk`。

该 npm 包未附 LICENSE 文本，仓库/许可证 GitHub API 本次返回404；这里不冒造缺失的版权声明，也不复制其实现文本。仅记录协议互操作必需的类型名、字段名、字段顺序和数据编码。完整 SDK 仅保留开发测试依赖，其原包未修改。

重要编码：Tron 为经 Base58Check 验证后的 21 bytes（含41前缀）；HyperCore token identifier 保留原始 bytes 长度，不擅自补齐 EVM 20 bytes；orderId 是 EIP-712 `hashStruct(Order)`，不是加 domain 的完整 `hashTypedData`。solver 签名使用 EIP-191 对 orderId raw bytes 签名。
