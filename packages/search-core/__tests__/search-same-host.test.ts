import { ClockProvider, createLockConfig, lockAtMostUntil, Utils } from '@tslock/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldNames, SearchLockAccessor } from '../src/index.js';
import type { SearchUpdateRequest } from '../src/search-update-client.js';

function readValue(doc: Record<string, string>, params: Record<string, string>, expr: string): string | undefined {
  const sourceField = expr.match(/^ctx\._source\[params\.(\w+)\]$/);
  if (sourceField) {
    const field = params[sourceField[1] ?? ''];
    return field === undefined ? undefined : doc[field];
  }
  const param = expr.match(/^params\.(\w+)$/);
  if (param) return params[param[1] ?? ''];
  throw new Error(`unparsed expression: ${expr}`);
}

function applyScript(doc: Record<string, string>, source: string, params: Record<string, string>): 'updated' | 'noop' {
  const condition = source.match(/if \((.+)\) \{/);
  if (!condition?.[1]) throw new Error('script has no condition');
  const matches = condition[1].split('&&').every((part) => {
    const pieces = part.trim().split(/ (<=|==|>) /);
    if (pieces.length !== 3) throw new Error(`unparsed comparison: ${part}`);
    const left = readValue(doc, params, pieces[0] ?? '');
    const right = readValue(doc, params, pieces[2] ?? '');
    if (left === undefined || right === undefined) return false;
    if (pieces[1] === '<=') return left <= right;
    if (pieces[1] === '==') return left === right;
    if (pieces[1] === '>') return left > right;
    throw new Error(`unparsed operator: ${pieces[1]}`);
  });
  if (!matches) return 'noop';
  for (const assignment of source.matchAll(/ctx\._source\[params\.(\w+)\] = params\.(\w+);/g)) {
    const field = params[assignment[1] ?? ''];
    const value = params[assignment[2] ?? ''];
    if (field === undefined || value === undefined) throw new Error('missing assignment param');
    doc[field] = value;
  }
  return 'updated';
}

class MemorySearch {
  readonly docs = new Map<string, Record<string, string>>();
  readonly requests: SearchUpdateRequest[] = [];

  readonly update = async (request: SearchUpdateRequest): Promise<{ result?: string }> => {
    this.requests.push(request);
    const existing = this.docs.get(request.id);
    if (!existing) {
      if (!request.upsert) throw { meta: { statusCode: 404 } };
      this.docs.set(request.id, { ...request.upsert });
      return { result: 'created' };
    }
    return { result: applyScript(existing, request.script.source, request.script.params) };
  };
}

function accessorFor(search: MemorySearch): SearchLockAccessor {
  return new SearchLockAccessor(search, 'shedlock', FieldNames.DEFAULT);
}

describe('Search same-host ownership', () => {
  afterEach(() => {
    ClockProvider.resetClock();
    vi.restoreAllMocks();
  });

  it('does not unlock or extend a newer lock acquired by the same host', async () => {
    vi.spyOn(Utils, 'getHostname').mockReturnValue('host-a');
    let now = 1_000_000;
    ClockProvider.setClock(() => now);
    const search = new MemorySearch();
    const accessor = accessorFor(search);

    const unlockConfig = createLockConfig('unlock-job', 5_000);
    const unlockLock = await accessor.lock(unlockConfig);
    expect(unlockLock).toBeDefined();
    now = 1_006_000;
    expect(await accessor.lock(createLockConfig('unlock-job', 60_000))).toBeDefined();
    const unlockHeld = search.docs.get('unlock-job')?.lockUntil;
    const unlockAcquired = Utils.toIsoString(lockAtMostUntil(unlockConfig));
    await unlockLock?.unlock();

    now = 1_000_000;
    const extendConfig = createLockConfig('extend-job', 5_000);
    const extendLock = await accessor.lock(extendConfig);
    expect(extendLock).toBeDefined();
    now = 1_006_000;
    expect(await accessor.lock(createLockConfig('extend-job', 60_000))).toBeDefined();
    const extendHeld = search.docs.get('extend-job')?.lockUntil;
    const extendAcquired = Utils.toIsoString(lockAtMostUntil(extendConfig));
    expect(await extendLock?.extend(120_000, 0)).toBeUndefined();

    expect(search.docs.get('unlock-job')?.lockUntil).toBe(unlockHeld);
    expect(search.docs.get('unlock-job')?.lockedBy).toBe('host-a');
    expect(search.docs.get('extend-job')?.lockUntil).toBe(extendHeld);
    expect(search.docs.get('extend-job')?.lockedBy).toBe('host-a');
    const unlock = search.requests.find((request) => request.id === 'unlock-job' && request.script.params.unlockTime);
    const extend = search.requests.find(
      (request) =>
        request.id === 'extend-job' && request.script.params.expectedLockUntil && request.script.params.lockUntil,
    );
    expect(unlock?.script.source).toContain('ctx._source[params.lockUntilField] == params.expectedLockUntil');
    expect(unlock?.script.params.expectedLockUntil).toBe(unlockAcquired);
    expect(unlock?.script.params.expectedLockUntil).not.toBe(unlockHeld);
    expect(extend?.script.source).toContain('ctx._source[params.lockUntilField] == params.expectedLockUntil');
    expect(extend?.script.params.expectedLockUntil).toBe(extendAcquired);
    expect(extend?.script.params.expectedLockUntil).not.toBe(extendHeld);
  });

  it('unlocks and extends when the stored deadline matches', async () => {
    vi.spyOn(Utils, 'getHostname').mockReturnValue('host-a');
    ClockProvider.setClock(() => 1_000_000);
    const search = new MemorySearch();
    const accessor = accessorFor(search);
    const config = createLockConfig('job', 60_000, 5_000);
    const lock = await accessor.lock(config);
    expect(lock).toBeDefined();

    const extended = await lock?.extend(120_000, 0);
    expect(extended).toBeDefined();
    expect(search.docs.get('job')?.lockUntil).toBe('1970-01-01T00:18:40.000Z');
    expect(search.requests[1]?.script.params.expectedLockUntil).toBe(Utils.toIsoString(lockAtMostUntil(config)));

    await extended?.unlock();
    expect(search.docs.get('job')?.lockUntil).toBe('1970-01-01T00:16:40.000Z');
  });
});
