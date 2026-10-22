import { useSyncExternalStore } from 'react';
import { englishMessages } from './messages.js';

export type Locale = 'zh' | 'en';
export const LANGUAGE_KEY = 'dock.language.v1';
let memoryLocale: Locale = 'zh';
let resolved: { href: string; locale: Locale } | undefined;
const listeners = new Set<() => void>();
const currentHref = () => typeof window === 'undefined' ? '' : window.location.href;

/** Resolve explicit share-link language, saved preference, then Chinese once per URL. */
export function getLocale(): Locale {
  const href = currentHref();
  if (resolved?.href === href) return resolved.locale;
  let locale: Locale = 'zh';
  let link: string | null = null;
  try { link = new URL(href).searchParams.get('lang'); } catch { /* SSR or a non-URL test environment. */ }
  if (link === 'en' || link === 'zh') locale = link;
  else {
    try { const saved = localStorage.getItem(LANGUAGE_KEY); if (saved === 'en' || saved === 'zh') locale = saved; }
    catch { locale = memoryLocale; }
  }
  resolved = { href, locale };
  return locale;
}
/** Display preferences never change or clear safety-critical order storage. */
export function setLocale(locale: Locale): void {
  memoryLocale = locale;
  try { localStorage.setItem(LANGUAGE_KEY, locale); } catch { /* The explicit choice remains usable in memory. */ }
  try {
    const url = new URL(currentHref());
    url.searchParams.set('lang', locale);
    window.history.replaceState(window.history.state, '', url.href);
  } catch { /* Language still changes when history or storage is unavailable. */ }
  resolved = { href: currentHref(), locale };
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === LANGUAGE_KEY || event.key === null) { resolved = undefined; listener(); }
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage); };
}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templates = Object.entries(englishMessages).filter(([source]) => /\{\d+\}/.test(source)).map(([source, english]) => {
  const indices: string[] = [];
  const pattern = source.split(/(\{\d+\})/).map(part => /^\{\d+\}$/.test(part) ? (indices.push(part), '([\\s\\S]*?)') : escape(part)).join('');
  return { pattern: new RegExp(`^${pattern}$`), indices, english, specificity: source.replace(/\{\d+\}/g, '').length };
}).sort((a, b) => b.specificity - a.specificity);

/** Translate at presentation boundaries only. Never alter errors, quotes or order records. */
export function translateMessage(value: string | undefined, locale: Locale = getLocale()): string {
  if (!value || locale === 'zh' || !/[\u4e00-\u9fff]/.test(value)) return value || '';
  const exact = englishMessages[value];
  if (exact) return exact;
  for (const template of templates) {
    const match = template.pattern.exec(value);
    if (match) {
      const values = new Map(template.indices.map((key, index) => [key, translateMessage(match[index + 1], locale)]));
      return template.english.replace(/\{\d+\}/g, key => values.get(key) || '');
    }
  }
  // API request IDs and unknown-payment recovery suffixes are composed messages.
  const request = /^(.*?)(（请求编号：[^）]+）)$/.exec(value);
  if (request) return `${translateMessage(request[1], locale)} ${translateMessage(request[2], locale)}`;
  for (const suffix of [' 交易编号已保留。请用下方“继续核验”上报，不要重复付款。', ' 付款结果尚不确定，请先检查钱包交易记录。']) {
    if (value.endsWith(suffix)) return translateMessage(value.slice(0, -suffix.length), locale) + englishMessages[suffix];
  }
  // Preserve unknown provider details rather than inventing a financial outcome.
  return `Additional service or wallet details (original): ${value}`;
}
export const t = translateMessage;
export function formatTime(date: string, locale: Locale = getLocale()): string {
  return new Date(date).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', { hour12: false });
}
export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getLocale, () => 'zh' as const);
  return { locale, setLocale, t: (value: string | undefined) => translateMessage(value, locale) };
}
