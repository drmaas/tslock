import { CreateTableCommand, DynamoDBClient, type ProvisionedThroughput } from '@aws-sdk/client-dynamodb';
import { extensibleLockProviderIntegrationTests, fuzzTests } from '@tslock/test-support';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll } from 'vitest';
import { DynamoDBLockProvider } from '../../src/dynamodb-lock-provider.js';

const TABLE_NAME = 'tslock-locks';

let container: StartedTestContainer | undefined;
let client: DynamoDBClient | undefined;
let provider: DynamoDBLockProvider | undefined;

beforeAll(async () => {
  container = await new GenericContainer('amazon/dynamodb-local:2.6.1')
    .withCommand(['-jar', 'DynamoDBLocal.jar', '-inMemory', '-sharedDb'])
    .withExposedPorts(8000)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  try {
    client = new DynamoDBClient({
      region: 'us-east-1',
      endpoint: `http://${container.getHost()}:${container.getMappedPort(8000)}`,
      credentials: {
        accessKeyId: 'local',
        secretAccessKey: 'local',
      },
    });
    const throughput: ProvisionedThroughput = {
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 5,
    };
    await client.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
        AttributeDefinitions: [{ AttributeName: '_id', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: '_id', KeyType: 'HASH' }],
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: throughput,
      }),
    );
    provider = new DynamoDBLockProvider({ tableName: TABLE_NAME, client });
  } catch (error) {
    client?.destroy();
    await container.stop().catch(() => undefined);
    client = undefined;
    container = undefined;
    throw error;
  }
}, 120_000);

const getProvider = async () => {
  if (!provider) throw new Error('DynamoDB integration provider was not initialized');
  return provider;
};

extensibleLockProviderIntegrationTests(getProvider);
fuzzTests(getProvider);

afterAll(async () => {
  try {
    client?.destroy();
  } finally {
    await container?.stop();
  }
});
