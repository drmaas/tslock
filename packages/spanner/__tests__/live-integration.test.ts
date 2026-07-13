import { Spanner } from '@google-cloud/spanner';
import { describe, it } from 'vitest';

const INSTANCE = process.env.TSLOCK_SPANNER_INSTANCE;
const DATABASE = process.env.TSLOCK_SPANNER_DATABASE;
const PROJECT_ID = process.env.TSLOCK_SPANNER_PROJECT_ID;

const describeLive = INSTANCE && DATABASE ? describe : describe.skip;

describeLive('SpannerLockProvider (live)', () => {
  it('should acquire and release a lock', async () => {
    const spanner = new Spanner({ projectId: PROJECT_ID });
    const instance = spanner.instance(INSTANCE!);
    const database = instance.database(DATABASE!);
    try {
    } finally {
      await database.close();
    }
  });
});
