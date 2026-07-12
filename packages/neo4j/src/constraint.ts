import type { Driver } from 'neo4j-driver';
import { buildCreateConstraintCypher, type ResolvedOptions } from './neo4j-cypher.js';
import { resolveOptions, type Neo4jColumnNames } from './neo4j-lock-provider.js';

export async function createUniqueConstraint(
  driver: Driver,
  options?: {
    label?: string;
    columnNames?: Partial<Neo4jColumnNames>;
    database?: string;
  },
): Promise<void> {
  const resolved: ResolvedOptions = resolveOptions(options);
  const cypher = buildCreateConstraintCypher(resolved);
  const session = driver.session(options?.database !== undefined ? { database: options.database } : undefined);
  try {
    await session.executeWrite((tx) => tx.run(cypher));
  } catch (error: unknown) {
    const e = error as { code?: string } | null;
    if (e?.code === 'Neo.ClientError.Schema.ConstraintValidationFailed') {
      return;
    }
    throw error;
  } finally {
    await session.close();
  }
}
