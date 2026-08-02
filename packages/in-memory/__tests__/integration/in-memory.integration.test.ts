import { extensibleLockProviderIntegrationTests, fuzzTests } from '@tslock/test-support';
import { InMemoryLockProvider } from '../../src/in-memory-lock-provider.js';

const getProvider = async () => new InMemoryLockProvider();

extensibleLockProviderIntegrationTests(getProvider, { timeMode: 'mock' });
fuzzTests(getProvider);
