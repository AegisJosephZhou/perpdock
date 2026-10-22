import { useI18n } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import type { Route } from '../shared/types.js';
import { inspectWalletCapabilities, type CapabilityInspection } from './wallet-capabilities.js';

const atomicLabels = { supported: '支持', ready: '需要在钱包中确认升级，尚未就绪', unsupported: '不支持', unknown: '未能确认' };
const paymasterLabels = { supported: '支持', unsupported: '不支持', unknown: '未能确认' };

export default function GaslessReadiness({ route, source, disabled }: { route: Route; source: string; disabled: boolean }) {
  const { t } = useI18n();
  const [result, setResult] = useState<CapabilityInspection>();
  const [checking, setChecking] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  // The App also keys this component by provider-session revision so switching
  // wallets with the same account/chain cannot retain an earlier report.
  useEffect(() => {
    request.current?.abort(); request.current = undefined; setChecking(false); setResult(undefined);
    return () => { request.current?.abort(); };
  }, [route.id, route.sourceChainId, route.sourceToken, route.decimals, source]);
  useEffect(() => {
    if (disabled) { request.current?.abort(); request.current = undefined; setChecking(false); setResult(undefined); }
  }, [disabled]);
  async function inspect() {
    if (disabled || request.current) return;
    const controller = new AbortController(); request.current = controller;
    setResult(undefined); setChecking(true);
    try {
      const next = await inspectWalletCapabilities(route, source, controller.signal);
      if (!controller.signal.aborted) setResult(next);
    } catch {
      if (!controller.signal.aborted) setResult({ state: 'unavailable', atomic: 'unknown', paymaster: 'unknown' });
    } finally {
      if (request.current === controller) { request.current = undefined; if (!controller.signal.aborted) setChecking(false); }
    }
  }
  return <details className="gasless-readiness">
    <summary>{t("只有稳定币，没有手续费币？")}</summary>
    <p className="field-help">{t("当前版本尚未启用手续费代付，授权与付款仍需 ")}{route.gasSymbol || 'ETH'}{t("。可以检查此钱包在 ")}{route.sourceChain} {t("的代付接入能力；检查不会升级账户、请求签名或付款。")}</p>
    <button className="text-button" disabled={disabled || checking} onClick={() => void inspect()}>{checking ? t('正在检查钱包能力…') : t('检查当前钱包能力')}</button>
    <div role="status" aria-live="polite">
      {result?.state === 'checked' ? <><p className="field-help">{t("钱包报告的原子批量执行能力：")}{t(atomicLabels[result.atomic])}{t("；代付接口：")}{t(paymasterLabels[result.paymaster])}。</p><p className="field-help">{t("这是当前账户和网络的能力报告，尚不能用于本应用免手续费币入金。钱包用稳定币付手续费的功能也需另行验证。")}</p></> : result ? <p className="field-help">{result.state === 'unsupported_method' ? t('此钱包未提供标准能力查询，暂无法确认代付支持。') : result.state === 'context_changed' ? t('钱包、账户或网络已变化，请重新检查。') : t('本次未能完成检查，请稍后重试。')}</p> : null}
    </div>
  </details>;
}
