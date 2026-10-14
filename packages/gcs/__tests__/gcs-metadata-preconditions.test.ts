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
  metageneration: number;
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

function objectResource(object: StoredObject, metageneration = object.metageneration): string {
  return JSON.stringify({
    generation: String(object.generation),
    metageneration: String(metageneration),
    crc32c: EMPTY_CRC32C,
    metadata: object.custom,
  });
}

function preconditions(url: string): URLSearchParams {
  return new URL(url, 'http://127.0.0.1').searchParams;
}

describe('GcsStorageAccessor metadata and generation preconditions', () => {
  let server: Server;
  let port: number;
  let object: StoredObject | null;
  let pendingCustom: Record<string, string>;
  let reportedMetageneration: number | null;
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
    reportedMetageneration = null;
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

    if (method === 'GET') {
      if (object === null) {
        sendJson(res, 404, { error: { code: 404, message: 'No such object' } });
        return;
      }
      const metageneration = reportedMetageneration ?? object.metageneration;
      reportedMetageneration = null;
      sendJson(res, 200, JSON.parse(objectResource(object, metageneration)));
      return;
    }

    if (method === 'POST' && url.includes('uploadType=resumable')) {
      if (!preconditionsHold(params, object)) {
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
      object = { generation: (object?.generation ?? 0) + 1, metageneration: 1, custom: pendingCustom };
      sendJson(res, 200, JSON.parse(objectResource(object)));
      return;
    }

    if (method === 'PATCH') {
      if (object === null || !preconditionsHold(params, object)) {
        const status = object === null ? 404 : 412;
        sendJson(res, status, { error: { code: status, message: 'Precondition Failed' } });
        return;
      }
      object = {
        generation: object.generation,
        metageneration: object.metageneration + 1,
        custom: { ...object.custom, ...customMetadata(body) },
      };
      sendJson(res, 200, JSON.parse(objectResource(object)));
      return;
    }

    sendJson(res, 500, { error: { code: 500, message: `unexpected ${method} ${url}` } });
  }

  it('insert then unlock sends ifGenerationMatch and round-trips lock fields', async () => {
    await expect(accessor.insertRecord(lockConfig)).resolves.toBe(true);

    const upload = requests.find((request) => request.method === 'POST');
    expect(upload).toBeDefined();
    expect(preconditions(upload!.url).get('ifGenerationMatch')).toBe('0');
    const uploaded = JSON.parse(upload!.body) as { metadata?: Record<string, string> };
    expect(uploaded.metadata?.lockedBy).toBe('test-host');
    expect(uploaded.metadata?.lockUntil).toBe('1970-01-01T00:00:10.000Z');

    ClockProvider.setClock(() => 0);
    await accessor.unlock(lockConfig);

    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(preconditions(patch!.url).get('ifGenerationMatch')).toBe('1');
    expect(preconditions(patch!.url).get('ifMetagenerationMatch')).toBe('1');
    const patched = JSON.parse(patch!.body) as { metadata?: Record<string, string> };
    expect(patched.metadata?.lockedBy).toBe('test-host');
    expect(patched.metadata?.lockUntil).toBe('1970-01-01T00:00:01.000Z');
    expect(patched.metadata?.lockedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(object?.generation).toBe(1);
    expect(object?.metageneration).toBe(2);
  });

  it('extend reads the written lock fields and sends ifGenerationMatch', async () => {
    ClockProvider.setClock(() => 5000);
    await expect(accessor.insertRecord(lockConfig)).resolves.toBe(true);

    await expect(accessor.extend({ ...lockConfig, createdAt: 5000 })).resolves.toBe(true);

    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(preconditions(patch!.url).get('ifGenerationMatch')).toBe('1');
    expect(preconditions(patch!.url).get('ifMetagenerationMatch')).toBe('1');
    const patched = JSON.parse(patch!.body) as { metadata?: Record<string, string> };
    expect(patched.metadata?.lockedBy).toBe('test-host');
    expect(patched.metadata?.lockUntil).toBe('1970-01-01T00:00:15.000Z');
    expect(object?.generation).toBe(1);
    expect(object?.metageneration).toBe(2);
  });

  it('updateRecord reads the written lockUntil and sends ifGenerationMatch', async () => {
    await expect(accessor.insertRecord(lockConfig)).resolves.toBe(true);

    ClockProvider.setClock(() => 10000);
    await expect(accessor.updateRecord({ ...lockConfig, createdAt: 20000 })).resolves.toBe(true);

    const uploads = requests.filter((request) => request.method === 'POST');
    expect(uploads).toHaveLength(2);
    expect(preconditions(uploads[1]!.url).get('ifGenerationMatch')).toBe('1');
    expect(preconditions(uploads[1]!.url).get('ifMetagenerationMatch')).toBe('1');
    const uploaded = JSON.parse(uploads[1]!.body) as { metadata?: Record<string, string> };
    expect(uploaded.metadata?.lockedBy).toBe('test-host');
    expect(uploaded.metadata?.lockUntil).toBe('1970-01-01T00:00:30.000Z');
  });

  it('updateRecord after a metadata patch fails when metageneration is stale', async () => {
    ClockProvider.setClock(() => 0);
    await expect(accessor.insertRecord(lockConfig)).resolves.toBe(true);
    await accessor.unlock(lockConfig);

    expect(object?.generation).toBe(1);
    expect(object?.metageneration).toBe(2);
    const patchedUntil = object?.custom.lockUntil;

    reportedMetageneration = 1;
    ClockProvider.setClock(() => 10000);
    await expect(accessor.updateRecord({ ...lockConfig, createdAt: 20000 })).resolves.toBe(false);

    const uploads = requests.filter((request) => request.method === 'POST');
    const conditional = uploads[uploads.length - 1]!;
    expect(preconditions(conditional.url).get('ifGenerationMatch')).toBe('1');
    expect(preconditions(conditional.url).get('ifMetagenerationMatch')).toBe('1');
    expect(object?.generation).toBe(1);
    expect(object?.metageneration).toBe(2);
    expect(object?.custom.lockUntil).toBe(patchedUntil);
  });
});

function generationMatches(match: string | null, object: StoredObject | null): boolean {
  if (match === null) return true;
  if (match === '0') return object === null;
  return object !== null && object.generation === Number(match);
}

function preconditionsHold(params: URLSearchParams, current: StoredObject | null): boolean {
  if (!generationMatches(params.get('ifGenerationMatch'), current)) return false;
  const metageneration = params.get('ifMetagenerationMatch');
  if (metageneration === null) return true;
  return current !== null && current.metageneration === Number(metageneration);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
