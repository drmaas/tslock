import { LockException } from '@tslock/core';

export interface CloudflareKvPutOptions {
  expiration?: number;
  expirationTtl?: number;
}

export interface CloudflareKvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: CloudflareKvPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CloudflareKvRestOptions {
  accountId: string;
  namespaceId: string;
  apiToken: string;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  apiBase?: string;
}

async function release(response: Response): Promise<void> {
  await response.body?.cancel();
}

async function httpError(method: string, response: Response): Promise<LockException> {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 300);
  } catch {
    detail = '';
  }
  const suffix = detail.length > 0 ? `: ${detail}` : '';
  return new LockException(`Cloudflare KV ${method} failed with HTTP ${response.status}${suffix}`);
}

function requireId(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LockException(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function createCloudflareKvRestNamespace(options: CloudflareKvRestOptions): CloudflareKvNamespace {
  const accountId = requireId(options.accountId, 'accountId');
  const namespaceId = requireId(options.namespaceId, 'namespaceId');
  if (typeof options.apiToken !== 'string' || options.apiToken.trim().length === 0) {
    throw new LockException('apiToken must be a non-empty string');
  }
  const apiToken = options.apiToken.trim();
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const apiBase = (options.apiBase ?? 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');
  const valuesPrefix = `${apiBase}/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/`;

  const keyUrl = (key: string): URL => new URL(valuesPrefix + encodeURIComponent(key));

  return {
    async get(key: string): Promise<string | null> {
      const response = await fetchImpl(keyUrl(key), {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      if (response.status === 404) {
        await release(response);
        return null;
      }
      if (!response.ok) throw await httpError('GET', response);
      return await response.text();
    },
    async put(key: string, value: string, putOptions?: CloudflareKvPutOptions): Promise<void> {
      const url = keyUrl(key);
      if (putOptions?.expirationTtl !== undefined) {
        url.searchParams.set('expiration_ttl', String(putOptions.expirationTtl));
      }
      if (putOptions?.expiration !== undefined) {
        url.searchParams.set('expiration', String(putOptions.expiration));
      }
      const response = await fetchImpl(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'text/plain',
        },
        body: value,
      });
      if (!response.ok) throw await httpError('PUT', response);
      await release(response);
    },
    async delete(key: string): Promise<void> {
      const response = await fetchImpl(keyUrl(key), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      if (response.status === 404) {
        await release(response);
        return;
      }
      if (!response.ok) throw await httpError('DELETE', response);
      await release(response);
    },
  };
}
