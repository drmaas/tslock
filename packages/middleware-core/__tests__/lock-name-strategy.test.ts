import { describe, expect, it } from 'vitest';
import { deriveLockName, methodPathStrategy } from '../src/lock-name-strategy.js';

describe('methodPathStrategy', () => {
  it('returns formatted method:path string', () => {
    expect(methodPathStrategy('GET', '/api/users')).toBe('GET:/api/users');
  });

  it('uppercases lowercase method', () => {
    expect(methodPathStrategy('post', '/api/users')).toBe('POST:/api/users');
  });

  it('handles empty path', () => {
    expect(methodPathStrategy('GET', '')).toBe('GET:');
  });

  it('handles special characters in path', () => {
    expect(methodPathStrategy('GET', '/api/users/:id')).toBe('GET:/api/users/:id');
  });

  it('handles wildcard paths', () => {
    expect(methodPathStrategy('GET', '/api/*')).toBe('GET:/api/*');
  });
});

describe('deriveLockName', () => {
  it('uses override name when provided', () => {
    const name = deriveLockName(methodPathStrategy, '', 'GET', '/api/users', 'custom');
    expect(name).toBe('custom');
  });

  it('falls back to strategy when no override', () => {
    const name = deriveLockName(methodPathStrategy, '', 'GET', '/api/users');
    expect(name).toBe('GET:/api/users');
  });

  it('prepends prefix to derived name', () => {
    const name = deriveLockName(methodPathStrategy, 'myapp', 'GET', '/api/users');
    expect(name).toBe('myapp:GET:/api/users');
  });

  it('override name ignores prefix', () => {
    const name = deriveLockName(methodPathStrategy, 'myapp', 'GET', '/api/users', 'explicit');
    expect(name).toBe('explicit');
  });

  it('override name ignores strategy', () => {
    const customStrategy = () => 'should-not-use';
    const name = deriveLockName(customStrategy, '', 'GET', '/api/users', 'override');
    expect(name).toBe('override');
  });

  it('custom strategy works without prefix', () => {
    const customStrategy = (_method: string, _path: string) => 'fixed-lock';
    const name = deriveLockName(customStrategy, '', 'GET', '/api/users');
    expect(name).toBe('fixed-lock');
  });

  it('custom strategy works with prefix', () => {
    const customStrategy = (_method: string, _path: string) => 'fixed-lock';
    const name = deriveLockName(customStrategy, 'app', 'GET', '/api/users');
    expect(name).toBe('app:fixed-lock');
  });
});
