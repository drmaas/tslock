import { describe, expect, it, vi } from 'vitest';
import { buildLockFailureResponse, defaultLockedBody } from '../src/lock-metadata.js';

describe('buildLockFailureResponse', () => {
  it('returns 503 status by default', () => {
    const response = buildLockFailureResponse(503, undefined, 'GET:/api/test', 'test-host', Date.now() + 30000);
    expect(response.status).toBe(503);
  });

  it('includes Retry-After header', () => {
    const lockUntil = Date.now() + 30000;
    const response = buildLockFailureResponse(503, undefined, 'GET:/api/test', 'test-host', lockUntil);
    expect(response.headers['Retry-After']).toBeDefined();
    const retryAfter = Number(response.headers['Retry-After']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(30);
  });

  it('includes Lock-Name header', () => {
    const response = buildLockFailureResponse(503, undefined, 'GET:/api/test', 'test-host', Date.now() + 30000);
    expect(response.headers['Lock-Name']).toBe('GET:/api/test');
  });

  it('includes Locked-By header', () => {
    const response = buildLockFailureResponse(503, undefined, 'get:/api/test', 'test-host', Date.now() + 30000);
    expect(response.headers['Locked-By']).toBe('test-host');
  });

  it('Retry-After is 0 when lock is in the past', () => {
    const lockUntil = Date.now() - 10000;
    const response = buildLockFailureResponse(503, undefined, 'GET:/api/test', 'test-host', lockUntil);
    expect(response.headers['Retry-After']).toBe('0');
  });

  it('passes static body through unchanged', () => {
    const body = { error: 'locked' };
    const response = buildLockFailureResponse(503, body, 'GET:/api/test', 'test-host', Date.now() + 30000);
    expect(response.body).toBe(body);
  });

  it('calls function body with metadata', () => {
    const fn = vi.fn((meta: { lockName: string; retryAfterSeconds: number }) => ({
      name: meta.lockName,
      wait: meta.retryAfterSeconds,
    }));
    const lockUntil = Date.now() + 30000;
    const response = buildLockFailureResponse(503, fn, 'GET:/api/test', 'test-host', lockUntil);

    expect(fn).toHaveBeenCalled();
    const body = response.body as { name: string; wait: number };
    expect(body.name).toBe('GET:/api/test');
    expect(body.wait).toBeGreaterThan(0);
  });

  it('supports custom status codes', () => {
    const response = buildLockFailureResponse(423, undefined, 'GET:/api/test', 'test-host', Date.now() + 30000);
    expect(response.status).toBe(423);
  });
});

describe('defaultLockedBody', () => {
  it('returns error object with lock metadata', () => {
    const body = defaultLockedBody({
      lockName: 'GET:/api/test',
      lockedBy: 'test-host',
      lockUntil: Date.now() + 30000,
      retryAfterSeconds: 25,
    });

    expect(body.error).toBe('Resource locked by another instance');
    expect(body.lockName).toBe('GET:/api/test');
    expect(body.lockedBy).toBe('test-host');
    expect(body.retryAfterSeconds).toBe(25);
  });
});
