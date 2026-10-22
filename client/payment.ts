import type { Order, Quote } from '../shared/types.js';
import { api, errorMessage, persistSavedOrder, savedOrderForPayment, withOrderPaymentLock, type SavedOrder } from './api.js';
import { isWalletRejection } from './wallets.js';
import { newFunnelAttempt, reportOrderStage, trackFunnel } from './funnel.js';

interface PaymentFlow {
  saved: SavedOrder;
  expectedQuoteId: string;
  validate: (quote: Quote) => void;
  sign: (quote: Quote, onHash: (hash: string) => void) => Promise<string>;
  onSaved: (current: SavedOrder, entries?: SavedOrder[]) => void;
  onOrder: (order: Order) => void;
  onProgress: (message: string) => void;
}

/** The same production path owns locking, durable intent and recovery before any wallet call. */
export async function executeOrderPayment(flow: PaymentFlow): Promise<void> {
  const { saved } = flow;
  function remember(next: SavedOrder) {
    const entries = persistSavedOrder(next);
    flow.onSaved(next, entries);
  }
  await withOrderPaymentLock(saved.id, async () => {
    const latestSaved = savedOrderForPayment(saved.id);
    if (!latestSaved || latestSaved.accessToken !== saved.accessToken) throw new Error('订单恢复凭据不可用，已阻止付款。');
    if (latestSaved.submission) {
      flow.onSaved(latestSaved);
      throw new Error('本订单已有付款操作记录，请先继续核验，勿重复付款。');
    }
    const latest = await api.order(saved.id, saved.accessToken);
    flow.onOrder(latest);
    if (latest.status !== 'awaiting_signature' || latest.sourceTxHash || latest.quote.id !== flow.expectedQuoteId) throw new Error('订单状态已变化，当前不可发起新的付款。');
    flow.validate(latest.quote);
    // If either storage write fails, execution cannot reach the signing provider.
    remember({ ...saved, submission: { state: 'signing' } });
    flow.onProgress('请核对钱包内的付款内容并签名。');
    const attemptId = newFunnelAttempt();
    reportOrderStage(saved, 'signing');
    let hash: string | undefined;
    let broadcastReturned = false;
    try {
      hash = await flow.sign(latest.quote, (txHash) => {
        hash = txHash;
        remember({ ...saved, submission: { state: 'submitted', txHash } });
        // Solana saves its signature before RPC broadcast; this is not a broadcast success.
        trackFunnel('payment_reference_observed', { attemptId, walletType: latest.quote.transaction.kind });
      });
      broadcastReturned = true;
      reportOrderStage(saved, 'broadcast');
      flow.onProgress('交易已提交，正在保存链上凭证。');
      flow.onOrder(await api.report(saved.id, saved.accessToken, hash));
    } catch (error) {
      const rejected = !hash && isWalletRejection(error);
      trackFunnel(broadcastReturned ? 'source_report_failed' : hash ? 'payment_outcome_unknown' : rejected ? 'signing_rejected' : 'signing_failed',
        { attemptId, walletType: latest.quote.transaction.kind });
      const next: SavedOrder = rejected ? { ...saved, submission: undefined } : { ...saved, submission: { state: 'unknown', ...(hash ? { txHash: hash } : {}) } };
      flow.onSaved(next);
      try { remember(next); } catch { /* Memory retains the hash; the durable signing marker remains conservative. */ }
      throw new Error(`${errorMessage(error)}${hash ? ' 交易编号已保留。请用下方“继续核验”上报，不要重复付款。' : !rejected ? ' 付款结果尚不确定，请先检查钱包交易记录。' : ''}`);
    }
  });
}
