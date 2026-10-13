import type { Route } from './types.js';

/** Reviewed public allowlist. Changes to token/chain semantics require a new route id.
 * Identity sources and read-only evidence: docs/SCENARIO-COVERAGE.md.
 * Runtime credentials and operator RPC URLs never belong in this file. */
export interface ReviewedEvmSource {
  route: Route;
  protocolChain: string;
  depository: string;
  publicRpcUrl: string;
  explorerUrl: string;
  finalityWarning: string;
  approvalPolicy: 'reset-if-needed' | 'exact';
}
export const REVIEWED_EVM_SOURCES: readonly ReviewedEvmSource[] = [
  {
    "route": {
      "id": "ethereum-usdt-hypercore",
      "label": "Ethereum USDT → Hyperliquid Perps USDC",
      "sourceChain": "Ethereum",
      "sourceChainId": 1,
      "sourceToken": "0xdac17f958d2ee523a2206206994597c13d831ec7",
      "symbol": "USDT",
      "decimals": 6,
      "walletType": "evm",
      "available": true,
      "gasSymbol": "ETH",
      "assetNote": "Ethereum 主网 Tether USDT。"
    },
    "protocolChain": "ethereum",
    "depository": "0x4cd00e387622c35bddb9b4c962c136462338bc31",
    "publicRpcUrl": "https://ethereum.publicnode.com",
    "explorerUrl": "https://etherscan.io",
    "finalityWarning": "Ethereum 最终确认及本应用入账核验可能需要约15分钟或更久，HyperCore 可能先到账，请勿重复付款。",
    "approvalPolicy": "reset-if-needed"
  },
  {
    "route": {
      "id": "ethereum-usdc-hypercore",
      "label": "Ethereum USDC → Hyperliquid Perps USDC",
      "sourceChain": "Ethereum",
      "sourceChainId": 1,
      "sourceToken": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "symbol": "USDC",
      "decimals": 6,
      "walletType": "evm",
      "available": true,
      "gasSymbol": "ETH",
      "assetNote": "Circle 原生 USDC；不接受 USDC.e 或其他同名资产。"
    },
    "protocolChain": "ethereum",
    "depository": "0x4cd00e387622c35bddb9b4c962c136462338bc31",
    "publicRpcUrl": "https://ethereum.publicnode.com",
    "explorerUrl": "https://etherscan.io",
    "finalityWarning": "Ethereum 最终确认及本应用入账核验可能需要约15分钟或更久，HyperCore 可能先到账，请勿重复付款。",
    "approvalPolicy": "exact"
  },
  {
    "route": {
      "id": "arbitrum-usdt-hypercore",
      "label": "Arbitrum One USDT0 → Hyperliquid Perps USDC",
      "sourceChain": "Arbitrum One",
      "sourceChainId": 42161,
      "sourceToken": "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
      "symbol": "USDT0",
      "decimals": 6,
      "walletType": "evm",
      "available": true,
      "gasSymbol": "ETH",
      "assetNote": "此合约为 Arbitrum USDT0，Relay 可能仍标为 USDT。"
    },
    "protocolChain": "arbitrum",
    "depository": "0x4cd00e387622c35bddb9b4c962c136462338bc31",
    "publicRpcUrl": "https://arbitrum-one.publicnode.com",
    "explorerUrl": "https://arbiscan.io",
    "finalityWarning": "Arbitrum One 源链最终确认及本应用入账核验可能延迟，HyperCore 可能先到账；以链上最终结果为准，请勿重复付款。",
    "approvalPolicy": "reset-if-needed"
  },
  {
    "route": {
      "id": "arbitrum-usdc-hypercore",
      "label": "Arbitrum One USDC → Hyperliquid Perps USDC",
      "sourceChain": "Arbitrum One",
      "sourceChainId": 42161,
      "sourceToken": "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      "symbol": "USDC",
      "decimals": 6,
      "walletType": "evm",
      "available": true,
      "gasSymbol": "ETH",
      "assetNote": "Circle 原生 USDC；不接受 USDC.e 或其他同名资产。"
    },
    "protocolChain": "arbitrum",
    "depository": "0x4cd00e387622c35bddb9b4c962c136462338bc31",
    "publicRpcUrl": "https://arbitrum-one.publicnode.com",
    "explorerUrl": "https://arbiscan.io",
    "finalityWarning": "Arbitrum One 源链最终确认及本应用入账核验可能延迟，HyperCore 可能先到账；以链上最终结果为准，请勿重复付款。",
    "approvalPolicy": "exact"
  },
  {
    "route": {
      "id": "base-usdc-hypercore",
      "label": "Base USDC → Hyperliquid Perps USDC",
      "sourceChain": "Base",
      "sourceChainId": 8453,
      "sourceToken": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      "symbol": "USDC",
      "decimals": 6,
      "walletType": "evm",
      "available": true,
      "gasSymbol": "ETH",
      "assetNote": "Circle 原生 USDC；不接受 USDC.e 或其他同名资产。"
    },
    "protocolChain": "base",
    "depository": "0x4cd00e387622c35bddb9b4c962c136462338bc31",
    "publicRpcUrl": "https://base.drpc.org",
    "explorerUrl": "https://basescan.org",
    "finalityWarning": "Base 源链最终确认及本应用入账核验可能延迟，HyperCore 可能先到账；以链上最终结果为准，请勿重复付款。",
    "approvalPolicy": "exact"
  },
  {
    "route": {
      "id": "optimism-usdc-hypercore",
      "label": "Optimism USDC → Hyperliquid Perps USDC",
      "sourceChain": "Optimism",
      "sourceChainId": 10,
      "sourceToken": "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
      "symbol": "USDC",
      "decimals": 6,
      "walletType": "evm",
      "available": true,
      "gasSymbol": "ETH",
      "assetNote": "Circle 原生 USDC；不接受 USDC.e 或其他同名资产。"
    },
    "protocolChain": "optimism",
    "depository": "0x4cd00e387622c35bddb9b4c962c136462338bc31",
    "publicRpcUrl": "https://optimism.publicnode.com",
    "explorerUrl": "https://optimistic.etherscan.io",
    "finalityWarning": "Optimism 源链最终确认及本应用入账核验可能延迟，HyperCore 可能先到账；以链上最终结果为准，请勿重复付款。",
    "approvalPolicy": "exact"
  },
  {
    "route": {
      "id": "polygon-usdc-hypercore",
      "label": "Polygon PoS USDC → Hyperliquid Perps USDC",
      "sourceChain": "Polygon PoS",
      "sourceChainId": 137,
      "sourceToken": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
      "symbol": "USDC",
      "decimals": 6,
      "walletType": "evm",
      "available": true,
      "gasSymbol": "POL",
      "assetNote": "Circle 原生 USDC；不接受 USDC.e 或其他同名资产。"
    },
    "protocolChain": "polygon",
    "depository": "0x4cd00e387622c35bddb9b4c962c136462338bc31",
    "publicRpcUrl": "https://polygon-bor-rpc.publicnode.com",
    "explorerUrl": "https://polygonscan.com",
    "finalityWarning": "Polygon PoS 源链最终确认及本应用入账核验可能延迟，HyperCore 可能先到账；以链上最终结果为准，请勿重复付款。",
    "approvalPolicy": "exact"
  },
  {
    "route": {
      "id": "bsc-usdt-hypercore",
      "label": "BNB Chain Binance-Peg USDT → Hyperliquid Perps USDC",
      "sourceChain": "BNB Chain",
      "sourceChainId": 56,
      "sourceToken": "0x55d398326f99059ff775485246999027b3197955",
      "symbol": "USDT",
      "decimals": 18,
      "walletType": "evm",
      "available": true,
      "gasSymbol": "BNB",
      "assetNote": "Binance-Peg USDT（BSC-USD），18 位精度的映射资产。"
    },
    "protocolChain": "bnb",
    "depository": "0x4cd00e387622c35bddb9b4c962c136462338bc31",
    "publicRpcUrl": "https://bsc-rpc.publicnode.com",
    "explorerUrl": "https://bscscan.com",
    "finalityWarning": "BNB Chain 源链最终确认及本应用入账核验可能延迟，HyperCore 可能先到账；以链上最终结果为准，请勿重复付款。",
    "approvalPolicy": "reset-if-needed"
  }
];
export function reviewedEvmSource(routeId: string): ReviewedEvmSource | undefined {
  return REVIEWED_EVM_SOURCES.find(source => source.route.id === routeId);
}
