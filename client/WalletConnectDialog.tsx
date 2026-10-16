import { useEffect, useRef, useState } from 'react';

/** Pairing links are short-lived credentials: keep them in memory, never in logs or URLs. */
export default function WalletConnectDialog({ uri, onCancel }: { uri?: string; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const element = dialog.current!;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
    return () => { element.close?.(); previouslyFocused?.focus?.(); };
  }, []);
  useEffect(() => {
    let active = true;
    setQr(''); setError(''); setCopied(false);
    if (uri) {
      void import('qrcode').then(({ default: qrCode }) => {
        if (!uri.startsWith('wc:') || uri.length > 4096) throw new Error('Invalid pairing URI');
        return qrCode.toDataURL(uri, { width: 320, margin: 3, errorCorrectionLevel: 'M' });
      }).then(value => { if (active) setQr(value); }).catch(() => {
        if (active) setError('二维码暂时无法生成，请取消后重试，或复制连接链接到钱包。');
      });
    }
    return () => { active = false; };
  }, [uri]);
  async function copy() {
    try {
      if (!uri || !navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(uri); setCopied(true); setError('');
    } catch { setError('无法复制，请使用钱包扫描二维码。'); }
  }
  return <dialog ref={dialog} className="walletconnect-dialog" aria-labelledby="walletconnect-title" aria-describedby="walletconnect-description" onCancel={event => { event.preventDefault(); onCancel(); }}>
    <div className="panel-heading"><h2 id="walletconnect-title">WalletConnect 扫码连接</h2><button className="text-button" aria-label="取消扫码连接" onClick={onCancel}>关闭 ×</button></div>
    <p id="walletconnect-description">用手机钱包的“扫一扫”扫描下方二维码，然后在钱包确认连接。</p>
    <div className="walletconnect-qr" aria-live="polite">{qr ? <img src={qr} alt="WalletConnect 连接二维码" width="320" height="320"/> : <p role="status"><span className="spinner"/>{uri ? '正在生成二维码…' : '正在准备安全连接…'}</p>}</div>
    {error && <p className="field-warning" role="alert">{error}</p>}
    <p className="field-help">支持本页的 EVM 网络。连接只建立钱包会话；授权与付款仍需你逐次确认。请勿分享连接二维码或链接。</p>
    <div className="walletconnect-actions"><button className="secondary full" disabled={!uri} onClick={() => void copy()}>{copied ? '连接链接已复制' : '复制连接链接'}</button><button className="text-button" onClick={onCancel}>取消连接</button></div>
  </dialog>;
}
