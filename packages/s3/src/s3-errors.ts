import { S3ServiceException } from '@aws-sdk/client-s3';

function getErrorName(e: unknown): string | undefined {
  if (e && typeof e === 'object') {
    return (e as Record<string, unknown>).name as string | undefined;
  }
  return undefined;
}

function getStatusCode(e: unknown): number | undefined {
  if (e && typeof e === 'object') {
    return ((e as Record<string, unknown>).$metadata as Record<string, unknown> | undefined)?.httpStatusCode as
      | number
      | undefined;
  }
  return undefined;
}

export function isNotFound(e: unknown): boolean {
  if (e instanceof S3ServiceException) {
    return e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
  }
  const name = getErrorName(e);
  if (name === 'NotFound' || name === 'NoSuchKey') return true;
  return getStatusCode(e) === 404;
}

export function isConditionalWriteFailed(e: unknown): boolean {
  if (e instanceof S3ServiceException) {
    return (
      e.name === 'PreconditionFailed' ||
      e.name === 'ConditionalRequestConflict' ||
      e.name === 'Conflict' ||
      e.$metadata?.httpStatusCode === 412 ||
      e.$metadata?.httpStatusCode === 409
    );
  }
  const name = getErrorName(e);
  if (name === 'PreconditionFailed' || name === 'ConditionalRequestConflict' || name === 'Conflict') return true;
  const statusCode = getStatusCode(e);
  return statusCode === 412 || statusCode === 409;
}
