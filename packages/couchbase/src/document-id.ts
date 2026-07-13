import { LockException } from '@tslock/core';

export const MAX_DOCUMENT_ID_LENGTH = 250;

export function buildDocumentId(name: string, options?: { documentIdPrefix?: string }): string {
  const prefix = options?.documentIdPrefix ?? 'shedlock:';
  const id = prefix + name;
  if (Buffer.byteLength(id, 'utf8') > MAX_DOCUMENT_ID_LENGTH) {
    throw new LockException(
      `Document ID too long (${Buffer.byteLength(id, 'utf8')} > ${MAX_DOCUMENT_ID_LENGTH} bytes)`,
    );
  }
  return id;
}
