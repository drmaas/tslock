import { describe, expect, it } from 'vitest';
import { buildDocumentId, MAX_DOCUMENT_ID_LENGTH } from '../src/document-id.js';

describe('buildDocumentId', () => {
  it('returns prefix + name', () => {
    expect(buildDocumentId('my-task')).toBe('shedlock:my-task');
  });

  it('uses custom prefix', () => {
    expect(buildDocumentId('my-task', { documentIdPrefix: 'lock:' })).toBe('lock:my-task');
  });

  it('throws when ID exceeds max length', () => {
    const longName = 'x'.repeat(MAX_DOCUMENT_ID_LENGTH + 1);
    expect(() => buildDocumentId(longName, { documentIdPrefix: '' })).toThrow('Document ID too long');
  });

  it('accepts ID at max length', () => {
    const name = 'x'.repeat(MAX_DOCUMENT_ID_LENGTH - 'shedlock:'.length);
    expect(buildDocumentId(name).length).toBeLessThanOrEqual(MAX_DOCUMENT_ID_LENGTH);
  });
});
