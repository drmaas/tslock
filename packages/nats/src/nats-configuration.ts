import type { ConnectionOptions, StorageType } from 'nats';

export interface NatsLockProviderOptions {
  servers: string;
  bucketName?: string;
  storage?: StorageType;
  connectionOptions?: ConnectionOptions;
}
