/**
 * Outbound HTTP/WebSocket that honors HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
 * and NO_PROXY. Node's global fetch and `ws` ignore these by default, and
 * many corporate networks only reach *.workers.dev through a proxy.
 */
import http from 'node:http';
import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';

function proxyUrlFor(target: URL): string | undefined {
  const env = process.env;
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (noProxy.some((p) => p === '*' || target.hostname === p || target.hostname.endsWith(p.startsWith('.') ? p : `.${p}`))) {
    return undefined;
  }
  const secure = target.protocol === 'https:' || target.protocol === 'wss:';
  return (
    (secure ? env.HTTPS_PROXY ?? env.https_proxy : env.HTTP_PROXY ?? env.http_proxy) ??
    env.ALL_PROXY ?? env.all_proxy ?? undefined
  );
}

/** Agent for `https.request` / `ws`; undefined means connect directly. */
export function agentFor(target: string | URL): http.Agent | undefined {
  const url = typeof target === 'string' ? new URL(target) : target;
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return undefined;
  const proxy = proxyUrlFor(url);
  return proxy ? new HttpsProxyAgent(proxy) : undefined;
}

export interface HttpResponse {
  status: number;
  text: string;
  json<T>(): T;
}

export function httpRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<HttpResponse> {
  const target = new URL(url);
  const lib = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      target,
      { method: opts.method ?? 'GET', headers: opts.headers, agent: agentFor(target), timeout: opts.timeoutMs ?? 15_000 },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text, json: <T>() => JSON.parse(text) as T }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timeout after ${opts.timeoutMs ?? 15_000}ms`)));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
