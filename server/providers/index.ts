import type { ProviderAdapter } from '../../shared/types.js';
import { getRoutes, getQuote, verifySourceTransaction, trackOrder, getAccount } from './relay.js';
export { getRoutes, getQuote, verifySourceTransaction, trackOrder, getAccount };
export const provider: ProviderAdapter = { getRoutes, getQuote, verifySourceTransaction, trackOrder, getAccount };
