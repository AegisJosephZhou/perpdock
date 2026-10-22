import { useI18n, formatTime } from './i18n.js';
import { startAttribution } from './attribution.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatUnits, isAddress, parseUnits } from 'viem';
import type { Account, AppConfig, Order, OrderStatus, Quote, Route } from '../shared/types.js';
import { api, errorMessage, loadSavedOrders, persistSavedOrder, readLocalPaymentState, savedOrderForPayment, STORAGE_KEY, SUBMISSION_PREFIX, type SavedOrder } from './api.js';
import { executeOrderPayment } from './payment.js';
import GaslessReadiness from './GaslessReadiness.js';
import OrderProgress from './OrderProgress.js';
import WalletConnectDialog from './WalletConnectDialog.js';
import perpexLogo from './assets/brand/perpex.png';
import hyperliquidLogo from './assets/brand/hyperliquid.svg';
import ethereumLogo from './assets/brand/ethereum.svg';
import arbitrumLogo from './assets/brand/arbitrum.png';
import baseLogo from './assets/brand/base.svg';
import optimismLogo from './assets/brand/optimism.svg';
import polygonLogo from './assets/brand/polygon.svg';
import bnbLogo from './assets/brand/bnb.svg';
import tronLogo from './assets/brand/tron.svg';
import { approveExact, connectEvm, connectTron, disconnectEvm, evmProvider, getAllowance, getEvmChain, listEvmWallets, preflightPayment, sendPayment, sourceBalance, sourceNativeBalance, switchEvmChain, validateQuoteContext, walletAddressEquals } from './wallets.js';

const networkLogos: Record<number, string> = {
  1: ethereumLogo, 42161: arbitrumLogo, 8453: baseLogo, 10: optimismLogo,
  137: polygonLogo, 56: bnbLogo,
};

const labels: Record<OrderStatus, string> = { awaiting_signature: '等待钱包签名', source_pending: '确认源链付款', bridging: '兑换与跨链处理中', verifying_credit: '核验合约账户入账', completed: '已核实到账', attention: '需要进一步核查', expired: '报价已过期' };
const brief = (address: string) => address.length > 20 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
const time = formatTime;
function SymbolIcon({ kind = 'arrow' }: { kind?: 'arrow' | 'wallet' | 'shield' | 'refresh' }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{kind === 'wallet' ? <><path d="M20 8V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15v12H5a2 2 0 0 1-2-2V6"/><path d="M20 12h-5v4h5"/></> : kind === 'shield' ? <><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z"/><path d="m8 12 3 3 5-6"/></> : kind === 'refresh' ? <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 8a7 7 0 0 1 12-3l3 4M4 15l3 4a7 7 0 0 0 12-3"/></> : <><path d="M4 12h15m-6-6 6 6-6 6"/></>}</svg>;
}
function explorer(route: Route | undefined, hash: string): string | undefined {
  if (!route) return;
  if (route.walletType === 'tron' && /^[a-f\d]{64}$/i.test(hash)) return `https://tronscan.org/#/transaction/${hash}`;
  const domains: Record<number, string> = { 1: 'etherscan.io', 42161: 'arbiscan.io', 8453: 'basescan.org', 10: 'optimistic.etherscan.io', 56: 'bscscan.com', 137: 'polygonscan.com' };
  return /^0x[a-f\d]{64}$/i.test(hash) && domains[route.sourceChainId] ? `https://${domains[route.sourceChainId]}/tx/${hash}` : undefined;
}

function hasVerifiedCredit(order: Order | undefined): boolean {
  if (!order || order.status !== 'completed' || typeof order.creditedAmount !== 'string' || typeof order.quote.minReceive !== 'string' || !/^\d+(?:\.\d{1,8})?$/.test(order.creditedAmount) || !/^\d+(?:\.\d{1,8})?$/.test(order.quote.minReceive) || !/^0x[0-9a-f]{64}$/i.test(order.destinationTxHash || '')) return false;
  const amount = parseUnits(order.creditedAmount, 8);
  const expectedReference = `${order.quote.recipient}:${order.destinationTxHash}`.toLowerCase();
  return amount > 0n && amount >= parseUnits(order.quote.minReceive, 8) && !!order.evidence?.some((item) => item.type === 'hypercore_credit' && item.reference.toLowerCase() === expectedReference);
}

export default function App() {
  const { t, locale, setLocale } = useI18n();
  const [config, setConfig] = useState<AppConfig>();
  useEffect(() => { if (config) startAttribution(config.attribution, locale); }, [config?.attribution, !!config, locale]);
  useEffect(() => {
    document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
    document.title = locale === 'en' ? 'Dock by Perpex · Fund Hyperliquid' : 'Dock by Perpex · 存入 Hyperliquid';
  }, [locale]);
  const [configError, setConfigError] = useState('');
  const [routeId, setRouteId] = useState('');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [recipientConfirmed, setRecipientConfirmed] = useState(false);
  const [differentConfirmed, setDifferentConfirmed] = useState(false);
  const [evmAddress, setEvmAddress] = useState('');
  const [tronAddress, setTronAddress] = useState('');
  const [chainId, setChainId] = useState<number>();
  const [balance, setBalance] = useState<string>();
  const [balanceError, setBalanceError] = useState('');
  const [nativeBalance, setNativeBalance] = useState<string>();
  const [nativeError, setNativeError] = useState('');
  const [walletOptions, setWalletOptions] = useState<{ id: string; name: string }[]>([]);
  const [walletId, setWalletId] = useState('');
  const [evmWalletName, setEvmWalletName] = useState('');
  const [walletConnectPrompt, setWalletConnectPrompt] = useState<{ uri?: string }>();
  const walletConnectAbort = useRef<AbortController | undefined>(undefined);
  const evmConnectionVersion = useRef(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [pendingPayments, setPendingPayments] = useState<SavedOrder[]>([]);
  const [recoveryProblem, setRecoveryProblem] = useState('');
  const [auditing, setAuditing] = useState(true);
  const [recoveryTick, setRecoveryTick] = useState(0);
  const [account, setAccount] = useState<Account>();
  const [accountError, setAccountError] = useState('');
  const [quote, setQuote] = useState<Quote>();
  const [order, setOrder] = useState<Order>();
  const [savedOrders, setSavedOrders] = useState<SavedOrder[]>(loadSavedOrders);
  const [credential, setCredential] = useState<SavedOrder | undefined>(() => loadSavedOrders()[0]);
  const [allowance, setAllowance] = useState<bigint>();
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [receiptHash, setReceiptHash] = useState('');
  const [clock, setClock] = useState(Date.now());
  const [balanceTick, setBalanceTick] = useState(0);
  const [connectedTick, setConnectedTick] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [orderReadTick, setOrderReadTick] = useState(0);
  const [orderReadIssue, setOrderReadIssue] = useState<{ id: string; message: string; kind: 'read' | 'refresh'; check?: string }>();
  const orderReadVersion = useRef(0);
  const refreshingOrder = useRef(false);
  const quoteRequest = useRef(0);
  const actionInFlight = useRef(false);
  const creationKey = useRef<{ quoteId: string; key: string } | undefined>(undefined);
  const recoveryVersion = useRef(0);
  // Only server-verified terminal credit is reusable, and only in this page's memory.
  const verifiedOrders = useRef(new Map<string, Order>());
  const orderReads = useRef(new Map<string, Promise<Order>>());
  const route = config?.routes.find((entry) => entry.id === (order?.quote.routeId || routeId));
  const source = route?.walletType === 'tron' ? tronAddress : evmAddress;
  const networkLogo = route?.walletType === 'tron' ? tronLogo : route ? networkLogos[route.sourceChainId] : undefined;
  const walletConnectChosen = walletId === 'walletconnect';
  const walletConnectUnavailable = walletConnectChosen && !config?.walletConnect?.projectId;
  const sourceNetwork = route?.walletType === 'evm' && route.sourceChainId === 1 ? 'Ethereum 主网' : route?.sourceChain || '付款网络';
  const networkReady = route?.walletType !== 'evm' || chainId === route.sourceChainId;
  const gasSymbol = route?.gasSymbol || (route?.walletType === 'tron' ? 'TRX' : 'ETH');
  const nativeZero = nativeBalance !== undefined && /^0(?:\.0+)?$/.test(nativeBalance);
  const intentBlocked = auditing || pendingPayments.length > 0 || !!recoveryProblem || !online;
  const networks = config?.routes.filter((item, index, routes) => routes.findIndex((other) => other.sourceChainId === item.sourceChainId && other.walletType === item.walletType) === index) || [];
  const networkRoutes = config?.routes.filter((item) => item.sourceChainId === route?.sourceChainId && item.walletType === route?.walletType) || [];
  const publicSite = location.protocol === 'https:' && /\.[a-z]{2,}$/i.test(location.hostname) && !/(?:^|\.)(?:localhost|local|test|invalid|example)$/i.test(location.hostname) ? location.origin : undefined;
  const walletCapabilityMissing = window.isSecureContext === false || !navigator.locks;
  const shownQuote = order?.quote || quote;
  const expired = !!shownQuote && Date.parse(shownQuote.expiresAt) <= clock;
  const differs = route?.walletType === 'evm' && !!source && isAddress(recipient) && source.toLowerCase() !== recipient.toLowerCase();
  const confirmed = recipientConfirmed && (!differs || differentConfirmed);
  const correctWallet = !!order && !!route && walletAddressEquals(route, source, order.quote.sourceAddress);
  const isCredited = hasVerifiedCredit(order);
  const orderStatus: OrderStatus | undefined = order?.status === 'completed' && !isCredited ? 'verifying_credit' : order?.status;
  const localHash = credential?.submission?.txHash;
  const paymentAttempted = !!credential?.submission || !!order?.sourceTxHash;
  const progressPage = paymentAttempted || (!!order && !['awaiting_signature', 'expired'].includes(order.status));
  const restoring = !!credential && !order;
  const allowanceReady = !!order && allowance !== undefined && allowance >= BigInt(order.quote.amountBaseUnits);
  const canPay = !!order && order.status === 'awaiting_signature' && !paymentAttempted && !expired && correctWallet && networkReady && confirmed && !!route?.available && !config?.paused && !intentBlocked && !nativeZero && !walletCapabilityMissing && allowance !== undefined && allowance >= BigInt(order.quote.amountBaseUnits);

  const reloadConfig = useCallback(async () => {
    setConfigError('');
    try {
      const next = await api.config(); setConfig(next);
      setRouteId((current) => current || next.routes.find((item) => item.available)?.id || next.routes[0]?.id || '');
    } catch (err) { setConfigError(errorMessage(err)); }
  }, []);
  useEffect(() => { void reloadConfig(); const id = setInterval(() => void reloadConfig(), 60_000); return () => clearInterval(id); }, [reloadConfig]);
  useEffect(() => { const id = setInterval(() => setClock(Date.now()), 1_000); return () => clearInterval(id); }, []);
  useEffect(() => {
    const discover = () => { try { setWalletOptions(listEvmWallets()); } catch { setWalletOptions([]); } };
    const connectivity = () => { setOnline(navigator.onLine); if (navigator.onLine) { void reloadConfig(); setBalanceTick((n) => n + 1); setOrderReadTick((n) => n + 1); setRecoveryTick((n) => n + 1); } };
    discover(); const id = setInterval(discover, 2_000);
    window.addEventListener('online', connectivity); window.addEventListener('offline', connectivity);
    window.addEventListener('eip6963:announceProvider', discover);
    return () => { clearInterval(id); window.removeEventListener('online', connectivity); window.removeEventListener('offline', connectivity); window.removeEventListener('eip6963:announceProvider', discover); };
  }, [reloadConfig]);
  useEffect(() => {
    let active = true; const version = ++recoveryVersion.current;
    setAuditing(true);
    void inspectLocalPayments().then((result) => {
      if (active && version === recoveryVersion.current) { setPendingPayments(result.pending); setRecoveryProblem(result.problem); setAuditing(false); }
    });
    return () => { active = false; };
  }, [savedOrders, order?.status, order?.sourceTxHash, isCredited, recoveryTick, online]);
  useEffect(() => () => { walletConnectAbort.current?.abort(); }, []);
  useEffect(() => {
    if (!evmAddress) return;
    let provider;
    try { provider = evmProvider(); } catch { return; }
    const version = evmConnectionVersion.current;
    const changed = (...args: unknown[]) => {
      if (version !== evmConnectionVersion.current) return;
      const accounts = args[0];
      quoteRequest.current++;
      setEvmAddress(Array.isArray(accounts) && typeof accounts[0] === 'string' && isAddress(accounts[0]) ? accounts[0] : '');
      setRecipientConfirmed(false); setDifferentConfirmed(false); setQuote(undefined); setAllowance(undefined); setConnectedTick((n) => n + 1);
    };
    const network = (...args: unknown[]) => { if (version !== evmConnectionVersion.current) return; quoteRequest.current++; setChainId(typeof args[0] === 'string' ? Number.parseInt(args[0], 16) : undefined); setAllowance(undefined); setQuote(undefined); setRecipientConfirmed(false); setDifferentConfirmed(false); setConnectedTick((n) => n + 1); };
    const disconnect = () => { if (version !== evmConnectionVersion.current) return; changed([]); setChainId(undefined); setEvmWalletName(''); };
    provider.on?.('accountsChanged', changed); provider.on?.('chainChanged', network); provider.on?.('disconnect', disconnect);
    return () => { provider.removeListener?.('accountsChanged', changed); provider.removeListener?.('chainChanged', network); provider.removeListener?.('disconnect', disconnect); };
  }, [connectedTick, evmAddress]);
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== window || !event.data || typeof event.data !== 'object') return;
      const action = event.data.message?.action;
      if (!['setAccount', 'setNode', 'disconnect', 'disconnectWeb'].includes(action)) return;
      quoteRequest.current++;
      setTronAddress(window.tronWeb?.defaultAddress.base58 || ''); setQuote(undefined); setAllowance(undefined); setRecipientConfirmed(false); setConnectedTick((n) => n + 1);
    };
    window.addEventListener('message', handler); return () => window.removeEventListener('message', handler);
  }, []);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY && !event.key?.startsWith(SUBMISSION_PREFIX)) return;
      setAuditing(true); setRecoveryTick((n) => n + 1);
      const entries = loadSavedOrders(); setSavedOrders(entries);
      setCredential((current) => {
        if (!current) return current;
        try { return savedOrderForPayment(current.id) || current; }
        catch { return { ...current, submission: { state: 'unknown' } }; }
      });
    };
    window.addEventListener('storage', sync); return () => window.removeEventListener('storage', sync);
  }, []);
  useEffect(() => {
    let active = true; setBalance(undefined); setBalanceError('');
    if (!route || !source || !networkReady) return;
    void sourceBalance(route, source).then((value) => { if (active) setBalance(value); }).catch((err) => { if (active) setBalanceError(errorMessage(err)); });
    return () => { active = false; };
  }, [route, source, chainId, networkReady, balanceTick, connectedTick]);
  useEffect(() => {
    let active = true; setNativeBalance(undefined); setNativeError('');
    if (!route || route.walletType !== 'evm' || !source || !networkReady) return;
    void sourceNativeBalance(route, source).then((value) => { if (active) setNativeBalance(value); }).catch((err) => { if (active) setNativeError(errorMessage(err)); });
    return () => { active = false; };
  }, [route, source, chainId, networkReady, balanceTick, connectedTick]);
  useEffect(() => {
    let active = true; setAccount(undefined); setAccountError('');
    if (!isAddress(recipient)) return;
    const id = setTimeout(() => { void api.account(recipient).then((value) => { if (active) setAccount(value); }).catch((err) => { if (active) setAccountError(errorMessage(err)); }); }, 500);
    return () => { active = false; clearTimeout(id); };
  }, [recipient, balanceTick]);
  useEffect(() => {
    if (!credential) return;
    let active = true; let nextRead: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      let terminal = false;
      const version = orderReadVersion.current;
      try {
        if (!refreshingOrder.current) {
          const latest = await readOrder(credential);
          if (!active) return;
          if (version === orderReadVersion.current) {
            terminal = hasVerifiedCredit(latest);
            setOrderReadIssue(current => current?.id === latest.id && current.kind === 'refresh'
              && current.check === JSON.stringify(latest.trackingCheck) && !terminal ? current : undefined);
            setOrder(latest); setRouteId(latest.quote.routeId); setAmount(latest.quote.amount); setRecipient(latest.quote.recipient);
          }
        }
      } catch (err) {
        if (active && version === orderReadVersion.current) setOrderReadIssue(current => current?.id === credential.id && current.kind === 'refresh'
          ? current : { id: credential.id, message: errorMessage(err), kind: 'read' });
      }
      if (active && !terminal) nextRead = setTimeout(() => void read(), 6_000);
    };
    void read();
    return () => { active = false; clearTimeout(nextRead); };
  }, [credential?.id, credential?.accessToken, orderReadTick]);
  useEffect(() => {
    let active = true; setAllowance(undefined);
    if (!order || !route || !correctWallet || !networkReady || paymentAttempted) return;
    void getAllowance(order.quote, route).then((value) => { if (active) setAllowance(value); }).catch(() => {});
    return () => { active = false; };
  }, [order?.id, route, correctWallet, networkReady, paymentAttempted, chainId, connectedTick]);

  function remember(next: SavedOrder) {
    const entries = persistSavedOrder(next); setSavedOrders(entries); setCredential(next);
  }
  async function readOrder(entry: SavedOrder): Promise<Order> {
    const key = JSON.stringify([entry.id, entry.accessToken]);
    const completed = verifiedOrders.current.get(key);
    if (completed) return completed;
    const running = orderReads.current.get(key);
    if (running) return running;
    const request = api.order(entry.id, entry.accessToken).then((latest) => {
      if (latest.id !== entry.id) throw new Error('订单身份不符');
      if (hasVerifiedCredit(latest)) verifiedOrders.current.set(key, latest);
      return latest;
    });
    orderReads.current.set(key, request);
    try { return await request; }
    finally { if (orderReads.current.get(key) === request) orderReads.current.delete(key); }
  }
  async function inspectLocalPayments(): Promise<{ pending: SavedOrder[]; problem: string; snapshot?: string }> {
    try {
      const state = readLocalPaymentState(); const snapshot = JSON.stringify(state);
      const pending: SavedOrder[] = []; let unreadable = false;
      // Bound concurrency so a long history does not flood the order API.
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(3, state.orders.length) }, async () => {
        while (cursor < state.orders.length) {
          const entry = state.orders[cursor++]!;
          try {
            const latest = await readOrder(entry);
            const attempted = !!entry.submission || !!latest.sourceTxHash || !['awaiting_signature', 'expired'].includes(latest.status);
            if (attempted && !hasVerifiedCredit(latest)) pending.push(entry);
          } catch { pending.push(entry); unreadable = true; }
        }
      }));
      return { pending, snapshot, problem: state.orphanedIds.length ? '检测到缺少查询凭据的付款记录。请保留原订单和钱包交易，请勿清除浏览器数据或再次付款。' : unreadable ? '部分订单暂时无法恢复，已暂停新入金；请先恢复原订单核验。' : '' };
    } catch (err) { return { pending: [], problem: errorMessage(err) }; }
  }
  async function withNewIntent(action: () => Promise<void>) {
    if (!navigator.onLine) throw new Error('当前已离线，请联网后恢复核验；不会自动付款。');
    if (window.isSecureContext === false || !navigator.locks) throw new Error('当前浏览器缺少安全付款能力，请使用支持 Web Locks 的新版浏览器并通过 HTTPS 打开。');
    await navigator.locks.request('hl-funding.active-payment.v1', { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error('另一个标签页正在准备或处理入金，请返回该页面核查。');
      const result = await inspectLocalPayments();
      setPendingPayments(result.pending); setRecoveryProblem(result.problem); setAuditing(false);
      if (result.problem || result.pending.length) throw new Error(result.problem || '此浏览器还有未结清的付款，请先返回待核查订单，不要另建订单重付。');
      if (result.snapshot !== JSON.stringify(readLocalPaymentState())) { setRecoveryTick((n) => n + 1); throw new Error('本机付款状态已变化，请先刷新核验。'); }
      await action();
    });
  }
  function invalidateQuote() { quoteRequest.current++; setQuote(undefined); setError(''); setNotice(''); }
  function chooseRoute(nextId: string) {
    if (actionInFlight.current || order || restoring || paymentAttempted || !config?.routes.some((item) => item.id === nextId && item.available)) return;
    setRouteId(nextId); setBalance(undefined); setBalanceError(''); setNativeBalance(undefined); setNativeError(''); setAllowance(undefined);
    setRecipientConfirmed(false); setDifferentConfirmed(false); creationKey.current = undefined; invalidateQuote();
  }
  function chooseNetwork(key: string) {
    const next = config?.routes.find((item) => `${item.walletType}:${item.sourceChainId}` === key && item.available);
    if (next) chooseRoute(next.id);
  }
  function chooseWallet(nextId: string) {
    if (actionInFlight.current || paymentAttempted) return;
    evmConnectionVersion.current++;
    setWalletId(nextId); setEvmAddress(''); setEvmWalletName(''); setChainId(undefined); setBalance(undefined); setNativeBalance(undefined); setAllowance(undefined);
    setRecipientConfirmed(false); setDifferentConfirmed(false); invalidateQuote();
  }
  async function checkSourceNetwork() {
    if (!route || route.walletType !== 'evm') return;
    const currentChain = await getEvmChain(); setChainId(currentChain);
    if (currentChain !== route.sourceChainId) {
      quoteRequest.current++; setQuote(undefined); setAllowance(undefined); setBalance(undefined); setRecipientConfirmed(false); setDifferentConfirmed(false);
      throw new Error(`请先将付款钱包切换至 ${sourceNetwork}。`);
    }
  }
  async function operation(name: string, action: () => Promise<void>) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(name); setError(''); setNotice('');
    try { await action(); } catch (err) { setError(errorMessage(err)); } finally { actionInFlight.current = false; setBusy(''); setProgress(''); }
  }
  async function connectSelectedEvm(): Promise<string> {
    evmConnectionVersion.current++;
    setEvmAddress(''); setEvmWalletName(''); setChainId(undefined); setAllowance(undefined);
    setRecipientConfirmed(false); setDifferentConfirmed(false); invalidateQuote();
    let controller: AbortController | undefined;
    try {
      if (walletConnectChosen) {
        if (!config?.walletConnect?.projectId) throw new Error('WalletConnect 尚未启用，请联系管理员完成配置，或选择浏览器钱包。');
        controller = new AbortController(); walletConnectAbort.current = controller; setWalletConnectPrompt({});
      }
      const address = controller ? await connectEvm('walletconnect', {
        projectId: config!.walletConnect!.projectId,
        chainId: route?.walletType === 'evm' ? route.sourceChainId : 1,
        onUri: (uri) => { if (walletConnectAbort.current === controller && !controller!.signal.aborted) setWalletConnectPrompt({ uri }); },
        signal: controller.signal,
      }) : await connectEvm(walletId || undefined);
      if (controller?.signal.aborted) throw new Error('已取消扫码连接，可重新尝试。');
      const currentChain = await getEvmChain();
      if (controller?.signal.aborted) throw new Error('已取消扫码连接，可重新尝试。');
      setEvmAddress(address); setChainId(currentChain);
      setEvmWalletName(walletConnectChosen ? 'WalletConnect' : walletOptions.find(item => item.id === walletId)?.name || '浏览器钱包');
      setConnectedTick((n) => n + 1);
      return address;
    } finally {
      if (controller && walletConnectAbort.current === controller) { walletConnectAbort.current = undefined; setWalletConnectPrompt(undefined); }
    }
  }
  async function connectSource() {
    if (!route) return;
    await operation('connect', async () => {
      if (route.walletType === 'tron') setTronAddress(await connectTron());
      else {
        const address = await connectSelectedEvm();
        if (!order) setRecipient((current) => current.trim() ? current : address);
      }
      setRecipientConfirmed(false); setDifferentConfirmed(false);
      setConnectedTick((n) => n + 1); invalidateQuote();
    });
  }
  async function disconnectSource() {
    await operation('disconnect', async () => {
      evmConnectionVersion.current++; setEvmAddress(''); setEvmWalletName(''); setChainId(undefined);
      setBalance(undefined); setNativeBalance(undefined); setAllowance(undefined);
      setRecipientConfirmed(false); setDifferentConfirmed(false); invalidateQuote();
      await disconnectEvm();
    });
  }
  async function requestQuote() {
    if (!route || !source || !networkReady || !isAddress(recipient) || !confirmed) return;
    await operation('quote', async () => withNewIntent(async () => {
      if (!/^\d+(?:\.\d+)?$/.test(amount) || (amount.split('.')[1]?.length || 0) > route.decimals) throw new Error(`请输入有效金额，最多 ${route.decimals} 位小数。`);
      const units = parseUnits(amount, route.decimals);
      if (units <= 0n) throw new Error('入金金额必须大于零。');
      if (config && (units < parseUnits(config.limits.minAmount, route.decimals) || units > parseUnits(config.limits.maxAmount, route.decimals))) throw new Error(`单笔支付范围为 ${config.limits.minAmount}–${config.limits.maxAmount} ${route.symbol}。`);
      if (balance !== undefined && units > parseUnits(balance, route.decimals)) throw new Error('付款钱包代币余额不足。');
      const requestId = ++quoteRequest.current;
      await checkSourceNetwork();
      if (requestId !== quoteRequest.current) return;
      const next = await api.quote({ routeId: route.id, amount, sourceAddress: source, recipient });
      if (requestId !== quoteRequest.current) return;
      validateQuoteContext(next, route, source, recipient); setQuote(next);
    }));
  }
  async function createOrder() {
    if (!quote || !route || !networkReady || !confirmed) return;
    await operation('create', async () => withNewIntent(async () => {
      const requestId = quoteRequest.current;
      await checkSourceNetwork();
      if (requestId !== quoteRequest.current) return;
      validateQuoteContext(quote, route, source, recipient);
      if (!creationKey.current || creationKey.current.quoteId !== quote.id) creationKey.current = { quoteId: quote.id, key: crypto.randomUUID() };
      const created = await api.createOrder(quote.id, creationKey.current.key);
      const entry: SavedOrder = { id: created.order.id, accessToken: created.accessToken, createdAt: created.order.createdAt };
      setOrder(created.order); setCredential(entry); remember(entry);
    }));
  }
  async function approve() {
    if (!order || !route || !networkReady || !confirmed || !correctWallet || expired || paymentAttempted) return;
    await operation('approve', async () => withNewIntent(async () => { await approveExact(order.quote, route, setProgress); setAllowance(await getAllowance(order.quote, route)); setNotice('本笔支付额度已就绪。付款仍需下一步在钱包确认。'); setBalanceTick((n) => n + 1); }));
  }
  async function pay() {
    if (actionInFlight.current || !canPay || !order || !route || !credential) return;
    actionInFlight.current = true;
    const saved = credential;
    setBusy('pay'); setError(''); setNotice(''); setProgress('正在核对订单与本机付款状态。');
    try {
      await withNewIntent(async () => {
      setProgress('正在核对资产余额与本笔网络手续费。');
      await preflightPayment(order.quote, route);
      await executeOrderPayment({
        saved, expectedQuoteId: order.quote.id,
        validate: (next) => validateQuoteContext(next, route, source, recipient),
        sign: (next, onHash) => sendPayment(next, route, onHash),
        onSaved: (next, entries) => { setCredential(next); if (entries) setSavedOrders(entries); },
        onOrder: setOrder, onProgress: setProgress,
      });
      });
      setBalanceTick((n) => n + 1);
    } catch (err) { setError(errorMessage(err)); }
    finally { actionInFlight.current = false; setBusy(''); setProgress(''); }
  }
  async function report(hash: string) {
    if (!credential) return;
    await operation('report', async () => {
      const value = hash.trim();
      if (!/^(?:0x)?[a-f\d]{64}$/i.test(value)) throw new Error('请输入完整的源链交易编号。');
      const next = await api.report(credential.id, credential.accessToken, value);
      remember({ ...credential, submission: { state: 'submitted', txHash: value } }); setOrder(next); setReceiptHash(''); setNotice('交易凭证已上报，后台将独立核验。');
    });
  }
  async function refreshOrder() {
    if (!credential || !online) return;
    const saved = credential;
    await operation('refresh', async () => {
      // In-flight GETs contain snapshots from before this explicit verification.
      // Do not let a late snapshot roll back its result or clear a fresh error.
      orderReadVersion.current++;
      refreshingOrder.current = true;
      orderReads.current.delete(JSON.stringify([saved.id, saved.accessToken]));
      try {
        const next = await api.refresh(saved.id, saved.accessToken);
        if (next.id !== saved.id) throw new Error('订单身份不符');
        setOrder(next); setOrderReadIssue(undefined); setBalanceTick((n) => n + 1);
      } catch (err) {
        setOrderReadIssue({ id: saved.id, message: errorMessage(err), kind: 'refresh', check: JSON.stringify(order?.trackingCheck) });
      } finally {
        refreshingOrder.current = false;
        setOrderReadTick((n) => n + 1);
      }
    });
  }
  function startNew() {
    if (actionInFlight.current || intentBlocked || (paymentAttempted && !isCredited)) return;
    quoteRequest.current++; setHistoryOpen(false); creationKey.current = undefined;
    setOrderReadIssue(undefined); setCredential(undefined); setOrder(undefined); setQuote(undefined); setAllowance(undefined); setRecipientConfirmed(false); setDifferentConfirmed(false); setError(''); setNotice(''); setReceiptHash('');
  }
  function chooseAmount(percent: number) {
    if (actionInFlight.current || order || balance === undefined || !route || !config) return;
    const portion = parseUnits(balance, route.decimals) * BigInt(percent) / 100n;
    const maximum = parseUnits(config.limits.maxAmount, route.decimals);
    setAmount(formatUnits(portion > maximum ? maximum : portion, route.decimals)); invalidateQuote();
  }
  function openSaved(item: SavedOrder) {
    if (actionInFlight.current) return;
    quoteRequest.current++;
    setOrderReadIssue(undefined); setOrder(undefined); setCredential(item); setQuote(undefined); setAllowance(undefined);
    setError(''); setNotice(''); setRecipientConfirmed(false); setDifferentConfirmed(false); setReceiptHash(''); setHistoryOpen(false); setOrderReadTick((value) => value + 1);
  }
  function toggleHistory(open: boolean) { if (!actionInFlight.current) setHistoryOpen(open); }
  function downloadReceipt() {
    if (!order) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), order }, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `HL-funding-${order.id}.json`; anchor.click(); URL.revokeObjectURL(url);
  }

  const quoteSeconds = shownQuote ? Math.max(0, Math.ceil((Date.parse(shownQuote.expiresAt) - clock) / 1000)) : 0;
  const mayCreate = !busy && !restoring && !intentBlocked && !walletCapabilityMissing && !!route?.available && !!source && networkReady && isAddress(recipient) && confirmed && !!amount && !config?.paused;
  // Explain the existing guards without relaxing them or consenting for the user.
  const newIntentHint = order ? undefined : (() => {
    if (busy) return '当前操作正在处理，请稍候。';
    if (!online) return '当前已离线，请恢复网络后重试。已有付款请继续核验原订单。';
    if (recoveryProblem || pendingPayments.length) return '请先通过上方待核查付款提醒恢复原订单，核验完成前不能开始新入金。';
    if (auditing || restoring) return '正在核查本机订单，请等待核验完成。';
    if (!config) return configError ? '暂时无法读取路线信息，请使用上方“重新连接服务”重试。' : '正在读取可用路线，请稍候。';
    if (config.paused) return '当前暂停新入金，已有订单仍可查询。';
    if (!route) return '当前选择的路线已不在可用配置中，请重新选择付款网络和资产。';
    if (!route.available) return route.reason || '当前路线暂不可用，请稍后重试或重新选择可用路线。';
    if (walletCapabilityMissing) return '当前浏览器缺少安全付款能力，请使用支持 Web Locks 的新版浏览器和安全访问地址。';
    if (!source && route.walletType === 'evm' && walletConnectUnavailable) return 'WalletConnect 尚未启用，请选择浏览器钱包，或联系管理员完成扫码配置。';
    if (!source) return `请先点击上方“${route.walletType === 'evm' && walletConnectChosen ? '扫码连接' : '连接钱包'}”连接付款钱包，再核对并勾选 HL 接收地址确认。`;
    if (!networkReady) return `请先将付款钱包切换至 ${t(sourceNetwork)}，再重新核对接收地址。`;
    if (!isAddress(recipient)) return '请先填写完整、有效的 HL 接收地址（0x 开头）。';
    if (!recipientConfirmed) return '请核对并勾选上方的 HL 接收地址确认，再继续报价。';
    if (differs && !differentConfirmed) return '付款与接收地址不同，请勾选第二项确认后继续。';
    if (quote && !expired && nativeZero) return `当前没有 ${gasSymbol} 支付授权与付款手续费，暂不能继续创建付款订单。请补充后刷新付款钱包余额。`;
    if (!amount) return '请先填写支付金额。';
    return undefined;
  })();
  const currentOrderReadError = orderReadIssue?.id === credential?.id ? orderReadIssue?.message : undefined;
  const progressTitle = isCredited ? '已核实到账' : localHash && !order?.sourceTxHash ? '交易编号已保留，等待核验' : credential?.submission?.state === 'signing' && !order?.sourceTxHash ? '等待钱包付款结果' : credential?.submission?.state === 'unknown' && !order?.sourceTxHash ? '付款结果待核查' : orderStatus ? labels[orderStatus] : '恢复订单中';

  return <div className="app-shell">
    {walletConnectPrompt && <WalletConnectDialog uri={walletConnectPrompt.uri} onCancel={() => { walletConnectAbort.current?.abort(); setWalletConnectPrompt(undefined); }}/>}
    <header className="site-header">
      <div className="brand"><img className="brand-logo" src={perpexLogo} width="44" height="44" alt=""/><span>Dock<small className="brand-byline">by Perpex</small></span></div>
      <div className="header-actions"><label className="language-picker"><span className="sr-only">Language / 语言</span><select aria-label="Language / 语言" value={locale} onChange={event => setLocale(event.target.value === 'en' ? 'en' : 'zh')}><option value="zh">中文</option><option value="en">English</option></select></label><span className={`network-status ${configError || config?.paused ? 'warning' : ''}`}><i/>{configError ? t('连接异常') : config?.paused ? t('暂停新入金') : config ? t('主网') : t('连接中')}</span><button className="history-button" disabled={!!busy} onClick={() => toggleHistory(!historyOpen)} aria-label={historyOpen ? t('返回当前订单') : t('订单记录')}>{historyOpen ? t('返回') : t('订单记录')}<span aria-hidden="true">{historyOpen ? '↩' : '↗'}</span></button></div>
    </header>
    <main className="funding-shell">
      <div className="page-heading"><div className="eyebrow">{historyOpen ? 'YOUR ORDERS' : progressPage ? 'FUNDING STATUS' : 'YOUR WALLET → HYPERLIQUID'}</div><h1>{historyOpen ? t('此浏览器的订单记录') : progressPage ? t('入金进度') : t('存入 Hyperliquid')}</h1><p>{historyOpen ? t('选择一笔订单，继续查看或核验付款。') : progressPage ? t('追踪这笔资金，直到默认 Perps 账户入账。') : t('由你的钱包签名，进入自己的默认 Perps 账户。')}</p></div>
      <details className="funding-help"><summary>{t("入金帮助：交易所、手机与到账问题")}</summary><div className="help-content">
        <details><summary>{t("资产在交易所")}</summary><p>{t("交易所提现不能完成本应用的授权与入金调用。请先提到自己控制的钱包，核对本页支持的网络和资产，钱包到账后再连接。不要直接向代币或路由合约转账；这里不提供平台充值地址。")}</p></details>
        <details><summary>{t("用手机或找不到钱包")}</summary><p>{t("EVM 网络可使用浏览器钱包，或选择 WalletConnect，用手机钱包扫描电脑上的连接二维码。扫码需要管理员启用；Tron 付款继续使用 TronLink。页面仍需安全访问、持久存储和 Web Locks；具体手机钱包的签名兼容性需实测。")}</p>{publicSite ? <button className="text-button" disabled={!!busy} onClick={() => void operation('copy', async () => { if (!navigator.clipboard) throw new Error('此浏览器不能复制，请手动复制地址栏的 HTTPS 网址。'); await navigator.clipboard.writeText(publicSite); setNotice('已复制当前 HTTPS 网址，不含订单查询凭据。'); })}>{t("复制当前 HTTPS 网址")}</button> : <p>{t("当前为本地或非公开 HTTPS 地址。WalletConnect 启用后，手机可扫描电脑上的配对二维码；要在手机直接打开此页面，需使用可访问的 HTTPS 网址。")}</p>}<p>{t("若钱包锁定，请先解锁；拒绝连接后可重新连接。页面不会要求助记词或私钥。")}</p></details>
        <details><summary>{t("找不到资产、网络或 HL 账户")}</summary><p>{t("可用范围以当前网络与资产列表为准。USDT0、Binance-Peg USDT 与普通 USDT 要按所在链和合约区分；不接受 USDC.e、Solana、法币或直接用 ETH/BNB/POL 入金，原生币仅支付手续费。")}</p><p>{t("接收目标仅为自己的 Hyperliquid 默认 Perps USDC 账户，不是 Spot 或 HyperEVM 钱包余额。新账户和零余额以本次真实报价的费用与限制为准；地址格式正确不证明你能控制账户，请勿填交易所收款地址。")}</p></details>
        <details><summary>{t("已经付款但还未显示到账")}</summary><p>{t("先从订单记录恢复原单、核对钱包中的原交易。最终确认及本单入账证据核验可能较晚，HL 可能先到账；签名窗口到期不代表已广播交易失败。不要另建订单重付。订单凭据保存在此浏览器，换设备或清除数据后不能保证自动恢复，下载收据也不代替访问凭据。")}</p><button className="text-button" disabled={!!busy || !online} onClick={() => void operation('reconnect', async () => { await reloadConfig(); setBalanceTick((n) => n + 1); setOrderReadTick((n) => n + 1); setRecoveryTick((n) => n + 1); })}>{t("刷新连接与只读核验")}</button></details>
        <p className="support-link"><a href="https://x.com/PerpExchange" target="_blank" rel="noreferrer noopener">{locale === 'en' ? 'Funding questions · Perpex on X ↗' : '入金问题 · Perpex X 公开账号 ↗'}</a><br/>{locale === 'en' ? 'This is a public channel. Do not post addresses, balances, order access tokens, private keys or seed phrases.' : '这是公开渠道，请勿发布地址、余额、订单访问令牌、私钥或助记词。'}</p>
      </div></details>
      {configError && <div className="message error" role="alert"><strong>{t("暂时无法加载真实路线")}</strong><p>{t(configError)}</p><button className="text-button" disabled={!!busy} onClick={() => void reloadConfig()}>{t("重新连接服务")}</button></div>}
      {config?.paused && <div className="message warning" role="status">{t("当前暂停新入金，已有订单仍可继续核验。")}</div>}
      {!online && <div className="message warning" role="status">{t("当前已离线。请保留钱包中的原交易；联网后会刷新只读状态，不会自动付款。")}</div>}
      {(pendingPayments.length > 0 || recoveryProblem) && <section className="message warning pending-payments" aria-label={t("待核查付款提醒")}><strong>{t("请先核查已有付款")}</strong><p>{t(recoveryProblem) || t('此浏览器存在未结清的付款。可以查看历史，但不能另建订单或再次付款。')}</p>{pendingPayments.map((item) => <button key={item.id} className="text-button" disabled={!!busy} onClick={() => openSaved(item)}>{t("返回待核查订单 ")}{brief(item.id)} ↗</button>)}<button className="text-button" disabled={!!busy || !online || auditing} onClick={() => { setRecoveryTick((n) => n + 1); setOrderReadTick((n) => n + 1); }}>{t("重新核查本机订单")}</button></section>}
      {walletCapabilityMissing && <div className="message warning" role="status">{t("当前浏览器缺少安全付款能力。请使用支持 Web Locks 的新版浏览器和安全访问地址；WalletConnect 也需要本页具备这些能力。")}</div>}
      {error && <div className="message error" role="alert"><strong>{t("操作需要留意")}</strong><p>{t(error)}</p></div>}
      {currentOrderReadError && <div className="message error" role="alert"><strong>{t("暂时无法读取最新订单")}</strong><p>{t(currentOrderReadError)}</p></div>}
      {notice && <div className="message success" role="status">{t(notice)}</div>}
      {historyOpen ? <section className="history-panel card" aria-label={t("本机订单列表")}>
        <div className="panel-heading"><h2>{t("最近的订单")}</h2><span>{savedOrders.length} {t("笔")}</span></div>
        {savedOrders.length ? <div className="saved-list">{savedOrders.map((item) => <button key={item.id} className={`saved-order ${credential?.id === item.id ? 'selected' : ''}`} disabled={!!busy} onClick={() => openSaved(item)}><span><strong className="mono">{brief(item.id)}</strong><small>{time(item.createdAt)}</small></span><span className="saved-state">{credential?.id === item.id && orderStatus ? t(progressTitle) : item.submission ? t('查看付款进度') : t('查看订单')} <span aria-hidden="true">→</span></span></button>)}</div> : <div className="empty-state"><SymbolIcon kind="wallet"/><h3>{t("还没有本机订单")}</h3><p>{t("确认实时入金报价后，订单会保存在这里。")}</p></div>}
        <div className="history-footer"><p>{t("订单查询凭据保存在此浏览器。清除浏览器数据或换设备后，可能无法从这里恢复。")}</p><button className="secondary full" disabled={!!busy} onClick={() => toggleHistory(false)}>{order || credential ? t('返回当前订单') : t('返回入金')}</button></div>
      </section> : restoring ? <section className="card restoring" aria-live="polite"><span className="spinner"/><h2>{t("正在恢复本机保存的订单")}</h2><p className="mono">{credential?.id}</p><p>{t("读取结果前不会发起新的付款。若已有签名，请保留钱包中的交易编号。")}</p></section> : progressPage && order ? <>
        <section className={`progress-hero ${isCredited ? 'complete' : ''}`}>
          <div className="progress-emblem" aria-hidden="true">{isCredited ? '✓' : orderStatus === 'attention' || credential?.submission?.state === 'unknown' ? '!' : '↗'}</div>
          <div className="receive-label">{isCredited ? t('实际到账') : t('预计到账')}</div><div className="hero-amount mono">{isCredited ? order.creditedAmount : order.quote.expectedReceive}<span>USDC</span></div>
          <p>{t("来自 ")}<strong>{order.quote.amount} {route?.symbol || t('源资产')}</strong>{route ? ` · ${route.sourceChain}` : ''}</p><div className={`status-badge ${isCredited ? 'success' : orderStatus === 'attention' || credential?.submission?.state === 'unknown' ? 'warning' : ''}`}>{t(progressTitle)}</div>
        </section>
        <OrderProgress order={order} credited={isCredited} now={clock} online={online} readError={t(currentOrderReadError)} localHash={localHash}/>
        {progress && <div className="working" role="status"><span className="spinner"/>{t(progress)}</div>}
        {credential?.submission && !order.sourceTxHash && <section className="recovery-box" aria-label={t("恢复付款")}><h2>{t("继续核验这笔付款")}</h2><p>{localHash ? t('交易编号已保留。继续核验会重新上报同一笔交易，不会再次付款。') : t('签名阶段的付款结果尚不确定。请检查钱包交易记录；当前订单已阻止再次付款。')}</p>{localHash ? <button className="secondary full" disabled={!!busy} onClick={() => void report(localHash)}>{t("继续核验已提交交易")}</button> : <div className="recovery-input"><label htmlFor="recovery-hash">{t("钱包中的源链交易编号")}</label><input id="recovery-hash" className="mono" aria-label={t("恢复源链交易编号")} placeholder={t("粘贴完整交易编号")} value={receiptHash} onChange={(event) => setReceiptHash(event.target.value)}/><button className="secondary full" disabled={!!busy || !receiptHash} onClick={() => void report(receiptHash)}>{t("上报凭证")}</button></div>}</section>}
        <section className="card order-receipt"><div className="panel-heading"><h2>{t("本笔资金信息")}</h2><button className="text-button" onClick={downloadReceipt}>{t("下载凭证 ↓")}</button></div><dl className="receipt-list"><div><dt>{t("收款账户")}</dt><dd>{t("Hyperliquid 默认 Perps")}</dd></div><div className="stack"><dt>{t("付款地址")}</dt><dd className="mono">{order.quote.sourceAddress}</dd></div><div className="stack"><dt>{t("完整 HL 接收地址")}</dt><dd className="mono">{order.quote.recipient}</dd></div><div className="stack"><dt>{t("订单编号")}</dt><dd className="mono">{order.id}</dd></div>{(order.sourceTxHash || localHash) && <div className="stack"><dt>{t("源链交易编号")}</dt><dd className="mono">{explorer(route, order.sourceTxHash || localHash!) ? <a href={explorer(route, order.sourceTxHash || localHash!)} target="_blank" rel="noreferrer">{order.sourceTxHash || localHash} ↗</a> : order.sourceTxHash || localHash}</dd></div>}<div><dt>{t("最低到账")}</dt><dd>{order.quote.minReceive} USDC</dd></div></dl>
          <details className="evidence"><summary>{t("订单事件记录（")}{order.events.length}）</summary>{order.events.map((event, index) => <div key={index}><strong>{time(event.at)} · {event.status === 'completed' && !isCredited ? t('待核验完成记录') : t(labels[event.status])}</strong><span>{event.status === 'completed' && !isCredited ? t('等待入账证据核验。') : t(event.message)}</span></div>)}</details>
          {!!order.evidence?.length && <details className="evidence"><summary>{t("链上与账户凭证（")}{order.evidence.length}）</summary>{order.evidence.map((item, index) => <div key={index}><strong>{item.type}</strong><span className="mono">{item.reference}</span></div>)}</details>}
        </section>
        <div className="restore-note"><SymbolIcon kind="shield"/><p>{t("可关闭页面，并在此浏览器的订单记录恢复。进度停留时请保留订单与交易编号，继续核验；不要重复付款。")}</p></div>
        <div className="page-actions"><button className={isCredited ? 'secondary full' : 'primary full'} disabled={!!busy || !credential || !online} onClick={() => void refreshOrder()}><SymbolIcon kind="refresh"/>{t("刷新订单核验")}</button>{isCredited && <button className="primary full" disabled={!!busy || intentBlocked} onClick={startNew}>{t("开始新入金")}<SymbolIcon/></button>}</div>
      </> : <>
        <div className="transfer-cards">
          <section className="card source-card" aria-label={t("付款信息")}>
            <div className="card-topline"><span>{t("从")}</span><button className="text-button balance-button" disabled={!source || !!busy} onClick={() => setBalanceTick((n) => n + 1)} aria-label={t("刷新付款钱包余额")}>{balance !== undefined ? <>{t("余额 ")}<strong className="mono">{balance}</strong> {route?.symbol}</> : source ? t('读取余额') : t('连接后读取余额')}<span aria-hidden="true">↻</span></button></div>
            <div className="asset-line"><span className="network-mark" aria-hidden="true">{networkLogo && <img className="network-logo" src={networkLogo} width="38" height="38" alt=""/>}</span><div className="network-asset-selectors"><div className="asset-selector"><label htmlFor="source-network">{t("付款网络")}</label><select id="source-network" value={route ? `${route.walletType}:${route.sourceChainId}` : ''} disabled={!!order || !!busy || restoring || paymentAttempted || !config} onChange={(event) => chooseNetwork(event.target.value)}><option value="" disabled>{config ? t('选择网络') : t('加载网络…')}</option>{networks.map((item) => { const available = config!.routes.some((other) => other.sourceChainId === item.sourceChainId && other.walletType === item.walletType && other.available); return <option key={`${item.walletType}:${item.sourceChainId}`} value={`${item.walletType}:${item.sourceChainId}`} disabled={!available}>{item.sourceChain}{available ? '' : t(' · 暂不可用')}</option>; })}</select></div><div className="asset-selector"><label htmlFor="route">{t("付款资产")}</label><select id="route" value={order?.quote.routeId || routeId} disabled={!!order || !!busy || restoring || paymentAttempted || !config} onChange={(event) => chooseRoute(event.target.value)}><option value="" disabled>{t("选择资产")}</option>{networkRoutes.map((item) => <option key={item.id} value={item.id} disabled={!item.available}>{item.symbol}{item.available ? '' : t(' · 暂不可用')}</option>)}</select></div></div></div>
            {route && <details className="asset-identity"><summary>{t("代币合约与资产说明")}</summary><p>{t(route.assetNote) || t(`${route.sourceChain} 上的 ${route.symbol}，精度 ${route.decimals} 位。`)}</p><code>{route.sourceToken}</code><p>{t("此地址用于核对代币，请勿直接转账至合约。")}</p></details>}
            <label className="sr-only" htmlFor="amount">{t("支付金额")}</label><div className="amount-input"><input id="amount" inputMode="decimal" autoComplete="off" value={amount} placeholder="0.00" disabled={!!order || !!busy} onChange={(event) => { setAmount(event.target.value); invalidateQuote(); }}/><span>{route?.symbol || '—'}</span></div>
            <div className="amount-shortcuts" aria-label={t("快捷支付金额")}>{[25, 50, 100].map((percent) => <button key={percent} disabled={balance === undefined || !route || !config || !!order || !!busy} onClick={() => chooseAmount(percent)}>{percent === 100 ? t('全部') : `${percent}%`}</button>)}</div>
            <div className="wallet-row"><div><span className="field-label">{t("付款钱包")}{source && route?.walletType === 'evm' && evmWalletName ? ` · ${t(evmWalletName)}` : ''}</span>{source ? <p className="mono full-address">{source}</p> : <p>{t("连接 ")}{route?.walletType === 'tron' ? 'TronLink' : walletConnectChosen ? t('WalletConnect 手机钱包') : 'MetaMask / Rabby'}</p>}</div><button className="secondary small" disabled={!!busy || !route || (route.walletType === 'evm' && walletConnectUnavailable)} onClick={() => void connectSource()}>{busy === 'connect' ? t('连接中…') : source ? t('重新连接') : route?.walletType === 'evm' && walletConnectChosen ? t('扫码连接') : t('连接钱包')}</button></div>
            {route?.walletType === 'evm' && <><div className="wallet-choice"><label htmlFor="evm-wallet">{t("连接方式")}</label><select id="evm-wallet" value={walletId} disabled={!!busy || paymentAttempted} onChange={(event) => chooseWallet(event.target.value)}><option value="">{walletOptions.length ? t('浏览器钱包（MetaMask 优先）') : t('浏览器钱包 · 未检测到')}</option>{walletOptions.map((wallet) => <option key={wallet.id} value={wallet.id}>{wallet.name}</option>)}<option value="walletconnect">{t("WalletConnect · 扫码连接")}</option></select></div>
              {walletConnectChosen && <p className={walletConnectUnavailable ? 'field-warning' : 'field-help'} role="status">{walletConnectUnavailable ? t('WalletConnect 尚未启用，等待管理员配置。你仍可选择浏览器钱包连接。') : t('用支持 WalletConnect 的手机钱包扫描电脑上的二维码，并在手机确认连接。')}</p>}
              {source && <button className="text-button disconnect-wallet" disabled={!!busy || paymentAttempted} onClick={() => void disconnectSource()}>{t("断开钱包连接")}</button>}
            </>}
            {route?.walletType === 'tron' && <p className="field-help">{t("Tron 付款使用 TronLink；WalletConnect 扫码目前仅支持 EVM 网络。")}</p>}
            {source && route?.walletType === 'evm' && !networkReady && <button className="network-switch" disabled={!!busy} onClick={() => void operation('switch', async () => { invalidateQuote(); setRecipientConfirmed(false); setDifferentConfirmed(false); setAllowance(undefined); await switchEvmChain(route.sourceChainId); setChainId(await getEvmChain()); setConnectedTick((n) => n + 1); })}>{t("切换钱包至 ")}{t(sourceNetwork)} ↗</button>}
            {order && source && !correctWallet && <p className="field-warning">{t("请连接本订单付款账户：")}<span className="mono">{order.quote.sourceAddress}</span></p>}
            {balanceError && <p className="field-warning">{t("余额暂未读取：")}{t(balanceError)}</p>}
            {config && <p className="field-help">{t("单笔 ")}{config.limits.minAmount}–{config.limits.maxAmount} {route?.symbol || ''}{locale === 'en' ? '. ' : '。'}{route?.walletType === 'tron' ? t('另需 TRX 支付链上资源费用。') : t(`另需 ${gasSymbol} 支付 ${t(sourceNetwork)}授权与付款手续费。`)}</p>}
            {route?.walletType === 'evm' && source && networkReady && <GaslessReadiness key={`${route.id}:${source}:${connectedTick}`} route={route} source={source} disabled={!!busy || !online || paymentAttempted}/>}
            {route?.walletType === 'evm' && source && <div className="native-balance" aria-label={t("网络手续费余额")}><span>{t("手续费余额")}</span><strong className="mono">{nativeBalance !== undefined ? `${nativeBalance} ${gasSymbol}` : nativeError ? t('暂无法读取') : t('读取中…')}</strong>{nativeZero ? <p className="field-warning">{t("当前没有 ")}{gasSymbol} {t("支付链费。请向自己的付款钱包补充后刷新；暂不能授权或付款。")}</p> : <p className="field-help">{t(nativeError) || t('非零余额不代表足够支付全部操作，签名前还会按本笔交易检查费用。')}</p>}</div>}
            {route && !route.available && <p className="field-warning">{t(route.reason) || t('此路线暂不可用。')}</p>}
            {config && !config.routes.some((item) => item.available) && <p className="field-warning">{t("当前没有可接受资金的路线，请稍后重试。")}</p>}
          </section>
          <div className="transfer-arrow" aria-hidden="true">↓</div>
          <section className="card destination-card" aria-label={t("接收信息")}>
            <div className="card-topline"><span>{t("到")}</span><span className="destination-network">{t("默认 Perps 账户")}</span></div>
            <div className="destination-title"><span className="hype-mark" aria-hidden="true"><img src={hyperliquidLogo} width="38" height="38" alt=""/></span><div><h2>Hyperliquid</h2><p>{t("USDC · 永续合约保证金")}</p></div></div>
            <div className="receive-label">{t("预计到账")}</div><div className="receive-amount mono">{shownQuote?.expectedReceive || '—'}<span>USDC</span></div><p className="minimum-receive">{shownQuote ? t(`最低到账 ${shownQuote.minReceive} USDC`) : t('获取实时报价后显示净到账金额')}</p>
            <div className="recipient-section"><div className="label-line"><label htmlFor="recipient">{t("你的 HL 接收地址")}</label><button className="text-button" disabled={!!order || !!busy || (!evmAddress && walletConnectUnavailable)} onClick={() => void operation('recipient', async () => { const address = evmAddress || await connectSelectedEvm(); setRecipient(address); setRecipientConfirmed(false); setDifferentConfirmed(false); invalidateQuote(); setConnectedTick((n) => n + 1); })}>{evmAddress ? t('填入已连接地址 ↗') : walletConnectChosen ? t('扫码连接 EVM 钱包填入 ↗') : t('连接 EVM 钱包填入 ↗')}</button></div><input className="recipient-input mono" id="recipient" value={recipient} spellCheck={false} autoComplete="off" placeholder="0x…" disabled={!!order || !!busy} onChange={(event) => { setRecipient(event.target.value.trim()); setRecipientConfirmed(false); setDifferentConfirmed(false); invalidateQuote(); }}/>{recipient && <p className="full-address mono address-preview">{recipient}</p>}{recipient && !isAddress(recipient) && <p className="field-warning">{t("请输入完整、有效的 EVM 地址（0x 开头）。")}</p>}<p className="field-help">{route?.walletType === 'tron' ? t('Tron 付款地址与 HL 接收地址需要分别确认。') : t('可使用付款钱包的同一 0x 地址，或填写自己控制的其他 HL 接收地址；仍需核对确认。')}</p><label className="check-row"><input type="checkbox" checked={recipientConfirmed} disabled={!isAddress(recipient) || !!busy} onChange={(event) => { setRecipientConfirmed(event.target.checked); if (!order) setQuote(undefined); }}/><span>{t("我已核对并控制上述 HL 接收地址，确认存入其默认 Perps 账户。")}</span></label>{differs && <label className="check-row warning-check"><input type="checkbox" checked={differentConfirmed} disabled={!!busy} onChange={(event) => setDifferentConfirmed(event.target.checked)}/><span>{t("付款与接收地址不同，我确认这是有意指定的接收账户。")}</span></label>}</div>
          </section>
        </div>
        <section className="card route-card" aria-label={t("报价费用")}><div className="route-summary"><span>{t("入金路线")}</span><strong>{route ? `${t(sourceNetwork)} ${route.symbol}` : t('付款钱包')} <span aria-hidden="true">→</span> {t("HL 默认 Perps")}</strong></div>
          <details className="quote-details"><summary><span>{t("费用与路线详情")}</span><span>{shownQuote?.provider || t('实时报价后显示')} <span className="disclosure-chevron" aria-hidden="true">⌄</span></span></summary><div className="detail-content">{shownQuote ? <><dl className="detail-list"><div><dt>{t("路由提供方")}</dt><dd>{shownQuote.provider}</dd></div>{shownQuote.fees.map((fee, index) => <div key={`${t(fee.label)}-${index}`}><dt>{t(fee.label)}{fee.description && <small>{t(fee.description)}</small>}</dt><dd>{fee.amount !== undefined ? `${fee.amount} ${fee.symbol}` : t(fee.description) || t('按实际执行')}</dd></div>)}{shownQuote.estimatedSeconds !== undefined && <div><dt>{t("路由提供方处理估时")}</dt><dd>{t("约 ")}{shownQuote.estimatedSeconds} {t("秒")}</dd></div>}<div><dt>{t("最低到账")}</dt><dd>{shownQuote.minReceive} USDC</dd></div></dl>{shownQuote.warnings.map((warning, index) => <p className="quote-warning" key={index}>{t(warning)}</p>)}<p className="field-help">{t("预计净到账按报价显示，不同币种费用不直接相加。处理估时不含源链最终确认与本应用到账核验，不代表到账保证。")}</p></> : <p className="field-help">{t("费用、最低到账和路线提供方将从实时响应读取。")}</p>}</div></details>
          {shownQuote && <div className={`signature-window ${expired ? 'expired' : ''}`}><span>{t("本应用签名窗口")}</span><strong>{expired ? t('已过期') : t(`剩余 ${quoteSeconds} 秒`)}</strong></div>}
        </section>
        <details className="account-disclosure"><summary>{t("接收账户信息")}<span aria-hidden="true">⌄</span></summary><div className="account-body">{account ? <><dl className="detail-list"><div><dt>{t("Perps 账户权益")}</dt><dd>{account.perpsUsdc} USDC</dd></div><div><dt>{t("可提余额")}</dt><dd>{account.withdrawableUsdc} USDC</dd></div></dl><p className="field-help">{t("读取于 ")}{time(account.observedAt)}{t("。账户权益可能包含未实现盈亏，不用余额变化判断本单到账。")}</p></> : <p className="field-help">{t(accountError) || (isAddress(recipient) ? t('正在读取账户信息…') : t('填写 HL 地址后可读取真实账户信息。'))}</p>}<button className="text-button" disabled={!isAddress(recipient)} onClick={() => setBalanceTick((n) => n + 1)}>{t("刷新接收账户余额 ↻")}</button></div></details>
        <section className="action-area" aria-label={t("入金操作")}>
          {order ? <>
            <div className="order-intent"><span>{t("已创建订单 ")}<span className="mono">{brief(order.id)}</span></span><button className="text-button" onClick={downloadReceipt}>{t("下载凭证 ↓")}</button></div>
            {route?.walletType === 'tron' && <p className="resource-note">{t("授权与付款分别计费。每次合约操作的能量费用上限为 150 TRX；带宽及实际费用以钱包为准。旧额度不足时可能还需先归零。")}</p>}
            {route?.walletType === 'evm' && <p className="resource-note">{t(sourceNetwork)}{t("授权与付款分别消耗 ")}{gasSymbol} {t("手续费。旧额度不足时，可能需要先清零再授权本笔精确额度；以钱包确认内容为准。")}</p>}
            {expired || order.status === 'expired' ? <><div className="message warning"><strong>{t("签名窗口已过期")}</strong><p>{t("本页没有已记录的付款。点击下方按钮会返回报价准备步骤；请重新连接付款钱包（如已断开）、核对并勾选接收地址，再获取新报价。已完成的代币授权不会自动撤销。若曾在钱包确认付款，请先核对原交易，不要重复付款。")}</p></div><button className="primary full" disabled={!!busy || intentBlocked} onClick={startNew}>{t("返回并重新报价")}<SymbolIcon/></button></> : !correctWallet ? <button className="primary full" disabled={!!busy || !route} onClick={() => void connectSource()}>{t("连接本订单付款钱包")}<SymbolIcon kind="wallet"/></button> : !allowanceReady ? <><p className="action-explanation">{order.quote.approval ? t(`下一步：在钱包检查并授权本笔 ${order.quote.amount} ${route?.symbol}。授权完成后仍需确认付款。`) : t('下一步：检查当前链上额度，再确认钱包付款。')}</p><button className="primary full" disabled={!!busy || intentBlocked || nativeZero || walletCapabilityMissing || !networkReady || !confirmed || !route?.available || config?.paused} onClick={() => void approve()}>{busy === 'approve' ? t('钱包授权处理中…') : order.quote.approval ? t('授权本笔额度') : t('检查本笔额度')}<SymbolIcon/></button></> : <><div className="allowance-ready"><span aria-hidden="true">✓</span>{t("代币额度已就绪，尚未付款")}</div><button className="primary full" disabled={!!busy || !canPay} onClick={() => void pay()}>{busy === 'pay' ? t('请在钱包确认…') : t(`钱包签名并付款 ${order.quote.amount} ${route?.symbol}`)}<SymbolIcon/></button></>}
            {!expired && <button className="text-button change-order" disabled={!!busy || intentBlocked} onClick={startNew}>{t("重新填写入金")}</button>}
          </> : quote && !expired ? <><p className="action-explanation">{t("确认上述接收地址、最低到账及费用，下一步创建订单并检查代币额度。")}</p><button className="primary full" aria-describedby={newIntentHint ? "new-intent-hint" : undefined} disabled={!!busy || intentBlocked || nativeZero || walletCapabilityMissing || !networkReady || !confirmed || !route?.available || config?.paused} onClick={() => void createOrder()}>{busy === 'create' ? t('正在创建订单…') : t('确认报价，创建订单')}<SymbolIcon/></button></> : <><button className="primary full" aria-describedby={newIntentHint ? "new-intent-hint" : undefined} disabled={!mayCreate} onClick={() => void requestQuote()}>{busy === 'quote' ? t('正在获取实时路线…') : quote && expired ? t('报价已过期，重新获取') : t('获取实时入金报价')}<SymbolIcon/></button><p className="action-hint">{t("获取报价不会授权代币，也不会付款。")}</p></>}
          {newIntentHint && <div id="new-intent-hint" className="message warning" role="status" aria-label={t("入金操作提示")}><strong>{t("下一步")}</strong><p>{t(newIntentHint)}</p></div>}
          {order && !confirmed && !expired && <p className="field-warning">{t("请先核对并确认上方完整的 HL 接收地址。")}</p>}
          {progress && <div className="working" role="status"><span className="spinner"/>{t(progress)}</div>}
        </section>
      </>}
      <footer className="page-footer"><a href="https://dock.perpex.ai/" target="_blank" rel="noreferrer noopener">Dock by Perpex · dock.perpex.ai ↗</a><div><SymbolIcon kind="shield"/><span>{t("平台不持有你的私钥或助记词")}</span></div><p>{t("第三方路由执行兑换与跨链。请核对地址；不承诺自动退款。")}</p></footer>
    </main>
  </div>;
}
