// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QRCode from 'qrcode';
import WalletConnectDialog from '../client/WalletConnectDialog.js';

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn() } }));
const firstUri = `wc:${'ab'.repeat(32)}@2?relay-protocol=irn&symKey=${'cd'.repeat(32)}`;
const secondUri = `wc:${'12'.repeat(32)}@2?relay-protocol=irn&symKey=${'34'.repeat(32)}`;
const firstQr = 'data:image/png;base64,VEVTVF9PTkxZX0ZJUlNU';
const secondQr = 'data:image/png;base64,VEVTVF9PTkxZX1NFQ09ORA==';
const qr = () => vi.mocked(QRCode.toDataURL as (uri: string) => Promise<string>);
let root: Root;
let host: HTMLDivElement;
let clipboard: ReturnType<typeof vi.fn<(value: string) => Promise<void>>>;
let cancel: ReturnType<typeof vi.fn<() => void>>;
let previousClipboard: PropertyDescriptor | undefined;
async function render(uri?: string) { await act(async () => { root.render(<WalletConnectDialog uri={uri} onCancel={cancel}/>); }); await settle(); }
async function settle() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
function button(pattern: RegExp) {
  const nodes = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(node => pattern.test(node.getAttribute('aria-label') ?? node.textContent ?? ''));
  expect(nodes).toHaveLength(1); return nodes[0]!;
}
async function click(node: HTMLElement) { await act(async () => { node.click(); }); await settle(); }

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  cancel = vi.fn(); clipboard = vi.fn<(value: string) => Promise<void>>().mockResolvedValue();
  previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
  qr().mockResolvedValue(firstQr);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard); else Reflect.deleteProperty(navigator, 'clipboard');
  vi.restoreAllMocks(); vi.resetAllMocks();
});

describe('WalletConnect pairing dialog', () => {
  it('shows preparation before a URI, disables copying, and never exposes credentials as text', async () => {
    await render(); expect(host.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    expect(host.textContent).toContain('正在准备安全连接'); expect(button(/复制连接链接/).disabled).toBe(true);
    await click(button(/复制连接链接/)); expect(clipboard).not.toHaveBeenCalled(); expect(qr()).not.toHaveBeenCalled();
    await render(firstUri);
    expect(host.querySelector('img')?.getAttribute('src')).toBe(firstQr); expect(host.textContent).not.toContain(firstUri);
    expect(button(/复制连接链接/).disabled).toBe(false); expect(cancel).not.toHaveBeenCalled();
  });
  it('ignores an older QR generation result when the pairing URI changes', async () => {
    let resolveOld!: (value: string) => void;
    qr().mockImplementationOnce(async () => new Promise<string>(resolve => { resolveOld = resolve; })).mockResolvedValueOnce(secondQr);
    await render(firstUri); expect(host.querySelector('img')).toBeNull();
    await render(secondUri); expect(host.querySelector('img')?.getAttribute('src')).toBe(secondQr);
    await act(async () => { resolveOld(firstQr); }); await settle();
    expect(host.querySelector('img')?.getAttribute('src')).toBe(secondQr);
    await click(button(/复制连接链接/)); expect(clipboard).toHaveBeenCalledWith(secondUri);
    expect(host.textContent).not.toContain(firstUri); expect(host.textContent).not.toContain(secondUri);
  });
  it('keeps a deliberate clipboard fallback when QR rendering fails without copying automatically', async () => {
    qr().mockRejectedValueOnce(new Error('TEST_ONLY_QR_FAILURE'));
    await render(firstUri); expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/二维码暂时无法生成/);
    expect(clipboard).not.toHaveBeenCalled(); expect(button(/复制连接链接/).disabled).toBe(false);
    await click(button(/复制连接链接/)); expect(clipboard).toHaveBeenCalledTimes(1); expect(clipboard).toHaveBeenCalledWith(firstUri);
    expect(host.textContent).toContain('连接链接已复制'); expect(host.textContent).not.toContain(firstUri);
  });
  it('explains a denied clipboard write while leaving scanning available', async () => {
    clipboard.mockRejectedValueOnce(new Error('TEST_ONLY_CLIPBOARD_DENIED'));
    await render(firstUri); await click(button(/复制连接链接/));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('无法复制');
    expect(host.querySelector('img')?.getAttribute('src')).toBe(firstQr); expect(cancel).not.toHaveBeenCalled();
  });
  it('routes native Escape cancellation through the parent abort action', async () => {
    await render(firstUri);
    const event = new Event('cancel', { cancelable: true });
    await act(async () => { host.querySelector('dialog')!.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true); expect(cancel).toHaveBeenCalledTimes(1);
    expect(clipboard).not.toHaveBeenCalled();
  });
});
