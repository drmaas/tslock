import { S3ServiceException } from '@aws-sdk/client-s3';

function getErrorName(e: unknown): string | undefined {
  if (e && typeof e === 'object') {
    return (e as Record<string, unknown>).name as string | undefined;
  }
  return undefined;
}

function getStatusCode(e: unknown): number | undefined {
  if (e && typeof e === 'object') {
    return (e as any).$metadata?.httpStatusCode as number | undefined;
  }
  return undefined;
}

export function isNotFound(e: unknown): boolean {
  if (e instanceof S3ServiceException) {
    return (
      e.name === 'NotFound' ||
      e.name === 'NoSuchKey' ||
      e.$metadata?.httpStatusCode === 404
    );
  }
  const name = getErrorName(e);
  if (name === 'NotFound' || name === 'NoSuchKey') return true;
  return getStatusCode(e) === 404;
}

export function isPreconditionFailed(e: unknown): boolean {
  if (e instanceof S3ServiceException) {
    return e.name === 'PreconditionFailed' || e.$metadata?.httpStatusCode === 412;
  }
  if (getErrorName(e) === 'PreconditionFailed') return true;
  return getStatusCode(e) === 412;
}
