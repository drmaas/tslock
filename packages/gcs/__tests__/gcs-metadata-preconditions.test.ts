import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Storage } from '@google-cloud/storage';
import { ClockProvider } from '@tslock/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GcsProviderConfig } from '../src/gcs-provider-config.js';
import { createGcsProviderConfig } from '../src/gcs-provider-config.js';
import { GcsStorageAccessor } from '../src/gcs-storage-accessor.js';

const EMPTY_CRC32C = 'AAAAAA==';

const lockConfig = {
  name: 'test-lock',
  lockAtMostFor: 10000,
  lockAtLeastFor: 1000,
  createdAt: 0,
};

type StoredObject = {
  generation: number;
  custom: Record<string, string>;
};

type RecordedRequest = {
  method: string;
  url: string;
  body: string;
};

function customMetadata(body: string): Record<string, string> {
  if (!body) return {};
  const parsed = JSON.parse(body) as { metadata?: Record<string, string> };
  return parsed.metadata ? { ...parsed.metadata } : {};
}

function objectResource(object: StoredObject): string {
  return JSON.stringify({
    generation: String(object.generation),
    crc32c: EMPTY_CRC32C,
    metadata: object.custom,
  });
}

describe('GcsStorageAccessor metadata and generation preconditions', () => {
  let server: Server;
  let port: number;
  let object: StoredObject | null;
  let pendingCustom: Record<string, string>;
  let requests: RecordedRequest[];
  let accessor: GcsStorageAccessor;

  beforeAll(async () => {
    server = createServer((req, res) => {
      void handle(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('test server did not bind to a port');
    }
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    object = null;
    pendingCustom = {};
    requests = [];
    const storage = new Storage({
      projectId: 'test-project',
      apiEndpoint: `http://127.0.0.1:${port}`,
    });
    const providerConfig: GcsProviderConfig = createGcsProviderConfig({
      bucket: 'test-bucket',
      lockedBy: 'test-host',
    });
    accessor = new GcsStorageAccessor(storage, providerConfig);
  });

  afterEach(() => {
    ClockProvider.resetClock();
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    requests.push({ method, url, body });

    const params = new URL(url, 'http://127.0.0.1').searchParams;
    const match = params.get('ifGenerationMatch');

    if (method === 'GET') {
      if (object === null) {
        sendJson(res, 404, { error: { code: 404, message: 'No such object' } });
        return;
      }
      sendJson(res, 200, JSON.parse(objectResource(object)));
      return;
    }

    if (method === 'POST' && url.includes('uploadType=resumable')) {
      if (!generationMatches(match, object)) {
        sendJson(res, 412, { error: { code: 412, message: 'Precondition Failed' } });
        return;
      }
      pendingCustom = customMetadata(body);
      res.writeHead(200, {
        location: `http://127.0.0.1:${port}/upload/session`,
        'content-type': 'application/json',
      });
      res.end();
      return;
    }

    if (method === 'PUT') {
      object = { generation: (object?.generation ?? 0) + 1, custom: pendingCustom };
      sendJson(res, 200, JSON.parse(objectResource(object)));
      return;
    }

    if (method === 'PATCH') {
      if (object === null || !generationMatches(match, object)) {
        const status = object === null ? 404 : 412;
        sendJson(res, status, { error: { code: status, message: 'Precondition Failed' } });
        return;
      }
      object = { generation: object.generation, custom: { ...object.custom, ...customMetadata(body) } };
      sendJson(res, 200, JSON.parse(objectResource(object)));
      return;
    }

    sendJson(res, 500, { error: { code: 500, message: `unexpected ${method} ${url}` } });
  }

  it('insert then unlock sends ifGenerationMatch and round-trips lock fields', async () => {
    await expect(accessor.insertRecord(lockConfig)).resolves.toBe(true);

    const upload = requests.find((request) => request.method === 'POST');
    expect(upload).toBeDefined();
    expect(new URL(upload!.url, 'http://127.0.0.1').searchParams.get('ifGenerationMatch')).toBe('0');
    const uploaded = JSON.parse(upload!.body) as { metadata?: Record<string, string> };
    expect(uploaded.metadata?.lockedBy).toBe('test-host');
    expect(uploaded.metadata?.lockUntil).toBe('1970-01-01T00:00:10.000Z');

    ClockProvider.setClock(() => 0);
    await accessor.unlock(lockConfig);

    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(new URL(patch!.url, 'http://127.0.0.1').searchParams.get('ifGenerationMatch')).toBe('1');
    const patched = JSON.parse(patch!.body) as { metadata?: Record<string, string> };
    expect(patched.metadata?.lockedBy).toBe('test-host');
    expect(patched.metadata?.lockUntil).toBe('1970-01-01T00:00:01.000Z');
    expect(patched.metadata?.lockedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('extend reads the written lock fields and sends ifGenerationMatch', async () => {
    ClockProvider.setClock(() => 5000);
    await expect(accessor.insertRecord(lockConfig)).resolves.toBe(true);

    await expect(accessor.extend({ ...lockConfig, createdAt: 5000 })).resolves.toBe(true);

    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(new URL(patch!.url, 'http://127.0.0.1').searchParams.get('ifGenerationMatch')).toBe('1');
    const patched = JSON.parse(patch!.body) as { metadata?: Record<string, string> };
    expect(patched.metadata?.lockedBy).toBe('test-host');
    expect(patched.metadata?.lockUntil).toBe('1970-01-01T00:00:15.000Z');
  });

  it('updateRecord reads the written lockUntil and sends ifGenerationMatch', async () => {
    await expect(accessor.insertRecord(lockConfig)).resolves.toBe(true);

    ClockProvider.setClock(() => 10000);
    await expect(accessor.updateRecord({ ...lockConfig, createdAt: 20000 })).resolves.toBe(true);

    const uploads = requests.filter((request) => request.method === 'POST');
    expect(uploads).toHaveLength(2);
    expect(new URL(uploads[1]!.url, 'http://127.0.0.1').searchParams.get('ifGenerationMatch')).toBe('1');
    const uploaded = JSON.parse(uploads[1]!.body) as { metadata?: Record<string, string> };
    expect(uploaded.metadata?.lockedBy).toBe('test-host');
    expect(uploaded.metadata?.lockUntil).toBe('1970-01-01T00:00:30.000Z');
  });
});

function generationMatches(match: string | null, object: StoredObject | null): boolean {
  if (match === null) return true;
  if (match === '0') return object === null;
  return object !== null && object.generation === Number(match);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
