// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, parseAbi } from 'viem';
import App from '../client/App.js';
import WalletConnectDialog from '../client/WalletConnectDialog.js';
import { api, persistSavedOrder, savedOrderForPayment, type SavedOrder } from '../client/api.js';
import * as wallets from '../client/wallets.js';
import * as attribution from '../client/attribution.js';
import { getLocale, LANGUAGE_KEY, setLocale, translateMessage } from '../client/i18n.js';
import { REVIEWED_EVM_SOURCES } from '../shared/route-registry.js';
import type { AppConfig, Order, Quote } from '../shared/types.js';

vi.mock('../client/wallets.js', async importOriginal => ({
  ...await importOriginal<typeof import('../client/wallets.js')>(),
  connectEvm: vi.fn(), getEvmChain: vi.fn(), listEvmWallets: vi.fn(), sourceBalance: vi.fn(), sourceNativeBalance: vi.fn(),
  getAllowance: vi.fn(), approveExact: vi.fn(), sendPayment: vi.fn(), preflightPayment: vi.fn(),
  evmProvider: vi.fn(() => ({ on: vi.fn(), removeListener: vi.fn() })),
}));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockRejectedValue(new Error('TEST_ONLY_QR_FAILURE')) } }));
class IsolatedStorage implements Storage {
  private entries = new Map<string, string>();
  get length() { return this.entries.size; }
  clear() { this.entries.clear(); }
  getItem(key: string) { return this.entries.get(key) ?? null; }
  setItem(key: string, value: string) { this.entries.set(key, String(value)); }
  removeItem(key: string) { this.entries.delete(key); }
  key(index: number) { return [...this.entries.keys()][index] ?? null; }
}
const route = REVIEWED_EVM_SOURCES[0]!.route;
const account = '0x1111111111111111111111111111111111111111';
const protocolOrderId = `0x${'ab'.repeat(32)}` as const;
const config: AppConfig = { appName: 'Perpex', network: 'mainnet', routes: [route], limits: { minAmount: '10', maxAmount: '10000' }, paused: false };
let host: HTMLDivElement; let root: Root; let fixture: Quote; let serial = 0;
function page(query = '') { window.history.replaceState({}, '', `/i18n-${++serial}${query}`); }
function text() { return host.textContent || ''; }
function button(pattern: RegExp) {
  const matches = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(el => pattern.test(el.textContent?.trim() || ''));
  expect(matches, String(pattern)).toHaveLength(1); return matches[0]!;
}
async function flush() { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); }
async function render(element = <App/>) { await act(async () => root.render(element)); await flush(); }
async function click(element: HTMLElement) { await act(async () => element.click()); await flush(); }
async function fill(selector: string, value: string) {
  const input = host.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
  const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
}
async function switchLanguage(value: 'en' | 'zh') { await fill('[aria-label="Language / 语言"]', value); }
function save(status: Order['status'] = 'awaiting_signature', state: 'unknown' | 'signing' = 'unknown') {
  const order: Order = { id: 'TEST_ONLY_I18N_ORDER', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), quote: fixture,
    status, statusMessage: '等待用户在来源钱包确认交易。', events: [] };
  vi.mocked(api.order).mockResolvedValue(order);
  const saved: SavedOrder = { id: order.id, accessToken: 'TEST_ONLY_I18N_TOKEN', createdAt: order.createdAt, submission: { state } };
  persistSavedOrder(saved); return saved;
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime('2026-10-22T01:00:00Z');
  vi.stubGlobal('localStorage', new IsolatedStorage());
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in isolated i18n tests'); }));
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_: string, _options: LockOptions, callback: (lock: Lock) => unknown) => callback({ name: 'TEST_ONLY', mode: 'exclusive' } as Lock) } });
  page(); setLocale('zh'); page();
  fixture = { id: 'TEST_ONLY_I18N_QUOTE', routeId: route.id, sourceAddress: account, recipient: account, amount: '25', amountBaseUnits: '25000000',
    expectedReceive: '24.7', minReceive: '24.6', expiresAt: new Date(Date.now() + 120000).toISOString(), provider: 'Relay', protocolOrderId,
    fees: [{ label: '源链网络费估算', amount: '0.00042', symbol: 'ETH' }, { label: 'Relay 路由费', description: '按实际执行', symbol: 'USDC' }],
    warnings: ['路由使用 Relay 协议及流动性服务；可能发生延迟或退款，失败不代表立即退款。'],
    approval: { token: route.sourceToken, spender: REVIEWED_EVM_SOURCES[0]!.depository, amount: '25000000' },
    transaction: { kind: 'evm', chainId: 1, to: REVIEWED_EVM_SOURCES[0]!.depository, value: '0', data: encodeFunctionData({ abi: parseAbi(['function depositErc20(address payer,address token,uint256 amount,bytes32 id)']), functionName: 'depositErc20', args: [account, route.sourceToken as `0x${string}`, 25000000n, protocolOrderId] }) } };
  vi.spyOn(api, 'config').mockResolvedValue(config);
  vi.spyOn(api, 'quote').mockResolvedValue(fixture);
  vi.spyOn(api, 'order').mockRejectedValue(new Error('No saved order'));
  vi.spyOn(api, 'account').mockResolvedValue({ address: account, perpsUsdc: '0', withdrawableUsdc: '0', observedAt: new Date().toISOString() });
  vi.mocked(wallets.connectEvm).mockResolvedValue(account); vi.mocked(wallets.getEvmChain).mockResolvedValue(1);
  vi.mocked(wallets.listEvmWallets).mockReturnValue([]); vi.mocked(wallets.sourceBalance).mockResolvedValue('100'); vi.mocked(wallets.sourceNativeBalance).mockResolvedValue('1'); vi.mocked(wallets.getAllowance).mockResolvedValue(0n);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setLocale('zh'); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Dock language resolution and financial message translation', () => {
  it('uses only exact share-link values, then saved preference, then Chinese', () => {
    localStorage.clear(); page(); expect(getLocale()).toBe('zh');
    localStorage.setItem(LANGUAGE_KEY, 'en'); page(); expect(getLocale()).toBe('en');
    page('?lang=zh'); expect(getLocale()).toBe('zh');
    localStorage.setItem(LANGUAGE_KEY, 'zh'); page('?lang=en'); expect(getLocale()).toBe('en');
    page('?lang=en-US'); expect(getLocale()).toBe('zh');
    page('?lang=EN'); expect(getLocale()).toBe('zh');
  });
  it('keeps an explicit switch usable when writes fail but reads return an old preference', () => {
    localStorage.setItem(LANGUAGE_KEY, 'zh'); page(); expect(getLocale()).toBe('zh');
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
    setLocale('en'); expect(localStorage.getItem(LANGUAGE_KEY)).toBe('zh'); expect(getLocale()).toBe('en');
  });
  it('preserves exact amounts, IDs and uncertainty in dynamic provider messages', () => {
    expect(translateMessage('单笔支付范围为 10–10000 USDT。', 'en')).toBe('The payment range is 10–10000 USDT per order.');
    expect(translateMessage('当前没有 ETH 支付授权与付款手续费，暂不能继续创建付款订单。请补充后刷新付款钱包余额。', 'en')).toContain('There is no ETH');
    expect(translateMessage('请求超时。若已在钱包签名，请先核对交易记录，不要再次付款。（请求编号：TEST_REQ_42）', 'en')).toContain('(Request ID: TEST_REQ_42)');
    expect(translateMessage('Relay 报告完成，尚未匹配到指定用户默认 Perps USDC 账本入账；继续核验。', 'en')).toContain('has not been matched');
    expect(translateMessage('未知钱包细节 TEST_CODE', 'en')).toBe('Additional service or wallet details (original): 未知钱包细节 TEST_CODE');
  });
});

describe('real bilingual funding UI', () => {
  it('keeps saved attribution while config is loading, then applies an explicit disabled configuration', async () => {
    let resolve!: (value: AppConfig) => void;
    vi.mocked(api.config).mockReturnValue(new Promise<AppConfig>(done => { resolve = done; }));
    const start = vi.spyOn(attribution, 'startAttribution');
    sessionStorage.setItem('dock.attribution.v1', 'TEST_ONLY_SAVED_SOURCE');
    page('?lang=en'); await render();
    expect(start).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('dock.attribution.v1')).toBe('TEST_ONLY_SAVED_SOURCE');
    await act(async () => { resolve(config); }); await flush();
    expect(start).toHaveBeenCalledWith(undefined, 'en');
    expect(sessionStorage.getItem('dock.attribution.v1')).toBeNull();
  });
  it('opens English directly with localized help, guidance, fields and public support', async () => {
    page('?lang=en&utm_source=x&utm_campaign=launch#keep'); await render();
    expect(document.documentElement.lang).toBe('en'); expect(document.title).toBe('Dock by Perpex · Fund Hyperliquid');
    expect(text()).toContain('Fund Hyperliquid'); expect(text()).toContain('Funds are on an exchange');
    expect(text()).toContain('Check the addresses. Automatic refunds are not guaranteed.');
    expect(text()).toContain('Use “Connect wallet” above');
    expect(text().replace('中文', '').replace('语言', '')).not.toMatch(/[\u4e00-\u9fff]/);
    expect(host.querySelector('a[href="https://x.com/PerpExchange"]')).not.toBeNull();
    expect(host.querySelector('a[href="https://dock.perpex.ai/"]')).not.toBeNull();
    expect(wallets.connectEvm).not.toHaveBeenCalled(); expect(api.quote).not.toHaveBeenCalled();
  });
  it('switches an active quote without changing form values, confirmations or funds actions', async () => {
    page('?lang=en&utm_source=x&order=KEEP_THIS_PARAMETER#keep'); await render();
    await click(button(/^Connect wallet$/)); await fill('#amount', '25');
    await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click(button(/^Get a live deposit quote$/));
    expect(api.quote).toHaveBeenCalledTimes(1); expect(text()).toContain('Source network fee estimate'); expect(text()).toContain('A failure does not mean an immediate refund.');
    expect(button(/^Confirm quote and create order$/).disabled).toBe(false);
    const recipient = host.querySelector<HTMLInputElement>('#recipient')!.value;
    await switchLanguage('zh');
    expect(host.querySelector<HTMLInputElement>('#amount')!.value).toBe('25');
    expect(host.querySelector<HTMLInputElement>('#recipient')!.value).toBe(recipient);
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    expect(button(/^确认报价，创建订单$/).disabled).toBe(false);
    expect(new URL(location.href).searchParams.get('utm_source')).toBe('x'); expect(new URL(location.href).searchParams.get('order')).toBe('KEEP_THIS_PARAMETER'); expect(location.hash).toBe('#keep');
    await switchLanguage('en'); expect(button(/^Confirm quote and create order$/).disabled).toBe(false);
    expect(api.quote).toHaveBeenCalledTimes(1); expect(wallets.connectEvm).toHaveBeenCalledTimes(1); expect(wallets.approveExact).not.toHaveBeenCalled(); expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it.each(['unknown', 'signing'] as const)('keeps %s payment recovery blocked across language changes', async state => {
    const saved = save('awaiting_signature', state); page('?lang=en'); await render();
    expect(text()).toContain('This order is blocked from paying again.');
    expect(text()).toContain('Check existing payments first');
    await switchLanguage('zh'); await switchLanguage('en');
    expect(savedOrderForPayment(saved.id)).toEqual(saved);
    expect(text()).toContain('This order is blocked from paying again.');
    expect([...host.querySelectorAll('button')].some(el => /^(Sign and pay|Start a new deposit)/.test(el.textContent || '') && !el.disabled)).toBe(false);
    expect(api.quote).not.toHaveBeenCalled(); expect(wallets.approveExact).not.toHaveBeenCalled(); expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it('does not translate an unverified completed state into verified credit', async () => {
    save('completed'); page('?lang=en'); await render();
    expect(text()).toContain('Credit evidence or the actual credited amount is incomplete.');
    expect(text()).toContain('Credit to the default Perps account has not been verified');
    expect(host.querySelector('.status-badge')?.textContent).toBe('Payment result needs verification');
    expect(host.querySelector('.receive-label')?.textContent).toBe('Expected receipt');
    expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it('shows English WalletConnect QR failure and cancellation without exposing pairing credentials', async () => {
    page('?lang=en'); const cancel = vi.fn();
    const uri = `wc:${'ab'.repeat(32)}@2?relay-protocol=irn&symKey=${'cd'.repeat(32)}`;
    await render(<WalletConnectDialog uri={uri} onCancel={cancel}/>);
    expect(text()).toContain('The QR code could not be generated.'); expect(text()).toContain('Do not share the pairing QR code or link.');
    expect(text()).not.toContain(uri); await click(button(/^Cancel connection$/)); expect(cancel).toHaveBeenCalledTimes(1);
  });
});
