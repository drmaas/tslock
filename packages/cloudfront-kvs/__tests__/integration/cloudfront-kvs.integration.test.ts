import { extensibleLockProviderIntegrationTests, fuzzTests, lockProviderIntegrationTests } from '@tslock/test-support';
import { afterAll, describe, expect, it } from 'vitest';
import { createCloudFrontKvsLockProvider } from '../../src/index.js';

const enabled = process.env.TSLOCK_CLOUDFRONT_KVS_INTEGRATION === '1';
const arn = process.env.CLOUDFRONT_KVS_ARN;

const integrationDescribe = enabled && arn ? describe : describe.skip;

integrationDescribe('CloudFront KeyValueStore integration', () => {
  let client: { destroy?: () => void } | undefined;

  afterAll(() => {
    client?.destroy?.();
  });

  it('has CLOUDFRONT_KVS_ARN configured', () => {
    expect(arn).toBeTruthy();
  });

  if (enabled && arn) {
    const getProvider = async () => {
      const { CloudFrontKeyValueStoreClient } = await import('@aws-sdk/client-cloudfront-keyvaluestore');
      if (!client) {
        client = new CloudFrontKeyValueStoreClient({});
      }
      return createCloudFrontKvsLockProvider({
        client: client as never,
        kvsArn: arn,
        keyPrefix: `tslock-it-${process.pid}/`,
      });
    };

    lockProviderIntegrationTests(getProvider);
    extensibleLockProviderIntegrationTests(getProvider);
    fuzzTests(getProvider);
  }
});
