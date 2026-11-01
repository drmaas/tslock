import { S3ServiceException } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { isConditionalWriteFailed, isNotFound } from '../src/s3-errors.js';

function s3Exception(name: string, httpStatusCode: number): S3ServiceException {
  return new S3ServiceException({
    name,
    $fault: 'client',
    $metadata: { httpStatusCode },
  });
}

describe('s3-errors', () => {
  describe('isNotFound', () => {
    it('recognizes real S3ServiceException NotFound and NoSuchKey by name', () => {
      expect(isNotFound(s3Exception('NotFound', 404))).toBe(true);
      expect(isNotFound(s3Exception('NoSuchKey', 404))).toBe(true);
    });

    it('recognizes real S3ServiceException by HTTP 404 status', () => {
      expect(isNotFound(s3Exception('SomeOtherName', 404))).toBe(true);
    });

    it('returns false for non-not-found errors', () => {
      expect(isNotFound(s3Exception('PreconditionFailed', 412))).toBe(false);
    });
  });

  describe('isConditionalWriteFailed', () => {
    it('recognizes real S3ServiceException precondition names', () => {
      expect(isConditionalWriteFailed(s3Exception('PreconditionFailed', 412))).toBe(true);
      expect(isConditionalWriteFailed(s3Exception('ConditionalRequestConflict', 409))).toBe(true);
      expect(isConditionalWriteFailed(s3Exception('Conflict', 409))).toBe(true);
    });

    it('recognizes real S3ServiceException by HTTP 412 and 409 status', () => {
      expect(isConditionalWriteFailed(s3Exception('Unknown', 412))).toBe(true);
      expect(isConditionalWriteFailed(s3Exception('Unknown', 409))).toBe(true);
    });

    it('returns false for not-found errors', () => {
      expect(isConditionalWriteFailed(s3Exception('NotFound', 404))).toBe(false);
    });
  });
});
