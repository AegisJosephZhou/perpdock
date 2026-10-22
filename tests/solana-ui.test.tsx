// @vitest-environment jsdom
import { Buffer } from 'node:buffer';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import App from '../client/App.js';
import { api, persistSavedOrder, savedOrderForPayment } from '../client/api.js';
import { setLocale } from '../client/i18n.js';
import * as wallets from '../client/wallets.js';
import * as solana from '../client/solana-wallet.js';
import { buildSolanaDepositInstruction, SOLANA_ROUTE } from '../shared/solana.js';
import type { Order, Quote } from '../shared/types.js';

vi.mock('../client/wallets.js', async original => ({ ...await original<typeof import('../client/wallets.js')>(), connectEvm: vi.fn(), listEvmWallets: vi.fn(() => []), sourceBalance: vi.fn(), sourceNativeBalance: vi.fn(), getAllowance: vi.fn(), approveExact: vi.fn(), sendPayment: vi.fn(), preflightPayment: vi.fn() }));
vi.mock('../client/solana-wallet.js', async original => ({ ...await original<typeof import('../client/solana-wallet.js')>(), connectSolana: vi.fn(), currentSolanaAddress: vi.fn(), listSolanaWallets: vi.fn(() => [{ id: 'phantom', name: 'Phantom' }, { id: 'solflare', name: 'Solflare' }]), selectedSolanaWalletName: vi.fn(() => 'Phantom'), solanaProvider: vi.fn(), verifySolanaWallet: vi.fn() }));
class IsolatedStorage implements Storage {
  private entries = new Map<string, string>();
  get length() { return this.entries.size; } clear() { this.entries.clear(); }
  getItem(key: string) { return this.entries.get(key) ?? null; } setItem(key: string, value: string) { this.entries.set(key, String(value)); }
  removeItem(key: string) { this.entries.delete(key); } key(index: number) { return [...this.entries.keys()][index] ?? null; }
}
const source = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey.toBase58();
const other = Keypair.fromSeed(new Uint8Array(32).fill(12)).publicKey.toBase58();
const recipient = '0x1111111111111111111111111111111111111111';
const signature = bs58.encode(new Uint8Array(64).fill(100));
let host: HTMLDivElement; let root: Root; let quote: Quote; let order: Order;
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
const provider = { on: (event: string, handler: (...args: unknown[]) => void) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(handler); }, removeListener: (event: string, handler: (...args: unknown[]) => void) => listeners.get(event)?.delete(handler) };
async function flush() { await act(async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); }); }
async function render() { await act(async () => root.render(<App/>)); await flush(); }
async function click(element: HTMLElement) { await act(async () => element.click()); await flush(); }
function button(pattern: RegExp) { const values = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(value => pattern.test(value.textContent?.trim() || '')); expect(values, String(pattern)).toHaveLength(1); return values[0]!; }
async function fill(selector: string, value: string) { const input = host.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!; const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }); await flush(); }
async function requestQuote() { await click(button(/^Connect wallet$/)); await fill('#amount', '25'); await fill('#recipient', recipient); await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!); await click(button(/^Get a live deposit quote$/)); }
function save(withHash = true) { persistSavedOrder({ id: order.id, accessToken: 'TEST_ONLY_SOLANA_TOKEN', createdAt: order.createdAt, submission: { state: 'unknown', ...(withHash ? { txHash: signature } : {}) } }); }
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime('2026-10-22T20:00:00Z');
  // jsdom has a separate typed-array realm; web3's Node Buffer requires its matching Uint8Array.
  vi.stubGlobal('Uint8Array', Object.getPrototypeOf(Buffer.prototype).constructor);
  vi.stubGlobal('localStorage', new IsolatedStorage()); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No live network in Solana UI tests'); }));
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_: string, _options: LockOptions, callback: (lock: Lock) => unknown) => callback({ name: 'TEST_ONLY', mode: 'exclusive' } as Lock) } });
  window.history.replaceState({}, '', '/solana-test?lang=en'); setLocale('en'); listeners.clear();
  const protocolOrderId = `0x${'ab'.repeat(32)}`;
  quote = { id: 'TEST_ONLY_SOLANA_QUOTE', routeId: SOLANA_ROUTE.id, sourceAddress: source, recipient, amount: '25', amountBaseUnits: '25000000', expectedReceive: '24.8', minReceive: '24.7', expiresAt: new Date(Date.now() + 120000).toISOString(), provider: 'Relay', fees: [], warnings: [], protocolOrderId, transaction: { kind: 'solana', chainId: SOLANA_ROUTE.sourceChainId, instructions: [buildSolanaDepositInstruction(source, '25000000', protocolOrderId)] } };
  order = { id: 'TEST_ONLY_SOLANA_ORDER', quote, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'awaiting_signature', statusMessage: '等待用户在来源钱包确认交易。', events: [] };
  vi.spyOn(api, 'config').mockResolvedValue({ appName: 'Dock', network: 'mainnet', routes: [SOLANA_ROUTE], paused: false, limits: { minAmount: '10', maxAmount: '100' } });
  vi.spyOn(api, 'quote').mockResolvedValue(quote); vi.spyOn(api, 'order').mockResolvedValue(order); vi.spyOn(api, 'createOrder').mockResolvedValue({ order, accessToken: 'TEST_ONLY_SOLANA_TOKEN' }); vi.spyOn(api, 'report').mockResolvedValue({ ...order, status: 'source_pending', sourceTxHash: signature }); vi.spyOn(api, 'account').mockResolvedValue({ address: recipient, perpsUsdc: '0', withdrawableUsdc: '0', observedAt: new Date().toISOString() });
  vi.mocked(wallets.sourceBalance).mockResolvedValue('100'); vi.mocked(wallets.sourceNativeBalance).mockResolvedValue('0.01'); vi.mocked(wallets.getAllowance).mockResolvedValue(25000000n); vi.mocked(wallets.preflightPayment).mockResolvedValue(undefined);
  vi.mocked(solana.connectSolana).mockResolvedValue(source); vi.mocked(solana.currentSolanaAddress).mockReturnValue(source); vi.mocked(solana.solanaProvider).mockReturnValue(provider as solana.SolanaProvider);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); setLocale('zh'); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Solana funding UI', () => {
  it('shows English Solana capabilities and keeps the 0x destination separate from the source wallet', async () => {
    await render(); expect(host.textContent!.replace('中文', '').replace('语言', '')).not.toMatch(/[\u4e00-\u9fff]/);
    expect(host.textContent).toContain('Phantom / Solflare'); expect(host.textContent).toContain('SOL is also required');
    await click(button(/^Connect wallet$/)); expect(solana.connectSolana).toHaveBeenCalledOnce(); expect(wallets.connectEvm).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('#recipient')!.value).toBe(''); expect(host.textContent).toContain(source);
    expect(host.textContent).toContain('do not use a Solana address as the HL recipient');
  });
  it('creates the exact Solana order without an allowance approval prompt', async () => {
    await render(); await requestQuote(); expect(api.quote).toHaveBeenCalledExactlyOnceWith({ routeId: SOLANA_ROUTE.id, sourceAddress: source, recipient, amount: '25' });
    await click(button(/^Confirm quote and create order$/));
    expect(host.textContent).toContain('No token approval required; not yet paid'); expect(button(/^Sign and pay 25 USDC$/).disabled).toBe(false);
    expect(wallets.approveExact).not.toHaveBeenCalled(); expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it('invalidates a quote and destination confirmation on a Solana account change', async () => {
    await render(); await requestQuote(); vi.mocked(solana.currentSolanaAddress).mockReturnValue(other);
    await act(async () => listeners.get('accountChanged')?.forEach(handler => handler())); await flush();
    expect(host.textContent).toContain(other); expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    expect(button(/^Get a live deposit quote$/).disabled).toBe(true); expect(api.quote).toHaveBeenCalledOnce(); expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it('blocks payment before recording a signing intent when the SOL fee preflight is unavailable', async () => {
    await render(); await requestQuote(); await click(button(/^Confirm quote and create order$/));
    vi.mocked(wallets.preflightPayment).mockRejectedValueOnce(new Error('无法取得可信的 Solana 手续费，尚未请求签名。'));
    await click(button(/^Sign and pay 25 USDC$/)); expect(host.textContent).toContain('A reliable Solana fee could not be obtained');
    expect(wallets.sendPayment).not.toHaveBeenCalled(); expect(savedOrderForPayment(order.id)?.submission).toBeUndefined();
  });
  it('restores the full base58 signature and resubmits only that receipt without paying again', async () => {
    save(); await render(); expect(host.querySelector(`a[href="https://solscan.io/tx/${signature}"]`)).not.toBeNull();
    await click(button(/^Continue verifying submitted transaction$/)); expect(api.report).toHaveBeenCalledExactlyOnceWith(order.id, 'TEST_ONLY_SOLANA_TOKEN', signature);
    expect(savedOrderForPayment(order.id)?.submission?.txHash).toBe(signature); expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it('accepts a manually recovered Solana signature and rejects a hex EVM hash for that route', async () => {
    save(false); await render(); await fill('#recovery-hash', `0x${'ab'.repeat(32)}`); await click(button(/^Submit receipt$/)); expect(api.report).not.toHaveBeenCalled();
    await fill('#recovery-hash', signature); await click(button(/^Submit receipt$/)); expect(api.report).toHaveBeenCalledExactlyOnceWith(order.id, 'TEST_ONLY_SOLANA_TOKEN', signature); expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
});
