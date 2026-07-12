import type { StorageType, ConnectionOptions } from 'nats';

export interface NatsLockProviderOptions {
  servers: string;
  bucketName?: string;
  storage?: StorageType;
  connectionOptions?: ConnectionOptions;
}
