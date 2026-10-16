export type OrderStatus = 'awaiting_signature' | 'source_pending' | 'bridging' | 'verifying_credit' | 'completed' | 'attention' | 'expired';
export interface Route {
  id: string; label: string; sourceChain: string; sourceChainId: number;
  sourceToken: string; symbol: string; decimals: number; walletType: 'evm' | 'tron';
  available: boolean; reason?: string; gasSymbol?: string; assetNote?: string;
}
export interface QuoteRequest { routeId: string; amount: string; sourceAddress: string; recipient: string }
export type WalletTransaction =
  | { kind: 'evm'; chainId: number; to: string; data: string; value: string }
  | { kind: 'tron'; transaction: unknown; contractAddress?: string };
export interface Quote {
  id: string; routeId: string; sourceAddress: string; recipient: string; amount: string;
  amountBaseUnits: string; expectedReceive: string; minReceive: string; expiresAt: string;
  provider: string; fees: {label: string; amount?: string; symbol: string; description?: string}[];
  /** Verified Relay order hash for wallet-side calldata binding; legacy quotes may omit it. */
  protocolOrderId?: string;
  estimatedSeconds?: number; transaction: WalletTransaction;
  approval?: {token: string; spender: string; amount: string}; warnings: string[];
}
export interface Evidence { type: string; reference: string }
export interface OrderEvent { at: string; status: OrderStatus; message: string }
export interface TrackingCheck {
  /** Server time when the latest source/route check finished, not a funds timestamp. */
  attemptedAt: string;
  /** Last successfully completed check, including valid pending/attention results. */
  succeededAt?: string;
  result: 'ok' | 'unavailable';
}
export interface Order {
  id: string; createdAt: string; updatedAt: string; quote: Quote; status: OrderStatus;
  sourceTxHash?: string; destinationTxHash?: string; providerOrderId?: string;
  creditedAmount?: string; statusMessage: string; events: OrderEvent[]; evidence?: Evidence[];
  /** Absent on legacy or never-checked orders; updatedAt is not a substitute. */
  trackingCheck?: TrackingCheck;
}
/** Server-only provider state. Must never originate from browser input. */
export type ProviderData = Record<string, unknown>;
export type ProviderQuote = Omit<Quote, 'id'> & { providerData: ProviderData };
export type StoredQuote = Quote & { providerData: ProviderData };
export type TrackedOrder = Order & { providerData: ProviderData };
export interface SourceVerification { valid: boolean; pending?: boolean; reason?: string; providerOrderId?: string }
export interface TrackingUpdate {
  status: OrderStatus; statusMessage: string; destinationTxHash?: string;
  providerOrderId?: string; creditedAmount?: string; evidence?: Evidence[];
  /** Internal adapter cursor only; never accepted from or exposed to browsers. */
  providerDataPatch?: ProviderData;
}
export interface Account { address: string; perpsUsdc: string; withdrawableUsdc: string; observedAt: string }
export interface ProviderAdapter {
  getRoutes(): Promise<Route[]>;
  getQuote(input: QuoteRequest): Promise<ProviderQuote>;
  verifySourceTransaction(quote: StoredQuote, txHash: string): Promise<SourceVerification>;
  trackOrder(order: TrackedOrder): Promise<TrackingUpdate>;
  getAccount(address: string): Promise<Account>;
}
export interface AppConfig {
  appName: string; network: 'mainnet'; routes: Route[]; limits: { minAmount: string; maxAmount: string }; paused: boolean;
  /** Public Reown dashboard identifier; omitted when WalletConnect is not configured. */
  walletConnect?: { projectId: string };
}
