export class UpstreamError extends Error {
  constructor(public code: string, message: string, public status = 502) { super(message); }
}

/** Callers use reviewed provider URLs or operator-configured HTTPS RPCs. No visitor-supplied URL is accepted. */
export async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
    const reader = response.body?.getReader();
    if (!reader) throw new UpstreamError('INVALID_UPSTREAM_RESPONSE', '上游响应为空。');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 4_000_000) { await reader.cancel(); throw new UpstreamError('UPSTREAM_RESPONSE_TOO_LARGE', '上游响应超过安全大小限制。'); }
      chunks.push(next.value);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new UpstreamError('PROVIDER_AUTH_REQUIRED', '上游拒绝访问，请由运营方检查 API 凭据或地区可用性。', 503);
      if (response.status === 429) throw new UpstreamError('PROVIDER_RATE_LIMIT', '上游暂时限流，请稍后重试。', 503);
      throw new UpstreamError('UPSTREAM_HTTP_ERROR', `上游服务暂不可用（HTTP ${response.status}）。`, 503);
    }
    try { return JSON.parse(text) as unknown; } catch { throw new UpstreamError('INVALID_UPSTREAM_RESPONSE', '上游未返回有效 JSON。'); }
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError('UPSTREAM_UNAVAILABLE', '无法连接上游服务，交易状态尚未改变。', 503);
  } finally { clearTimeout(timer); }
}

export function postJson(url: string, body: unknown, headers: Record<string, string> = {}, timeoutMs?: number): Promise<unknown> {
  return fetchJson(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, timeoutMs);
}
