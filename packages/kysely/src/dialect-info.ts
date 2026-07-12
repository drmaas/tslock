import { translateNamedParams } from '@tslock/sql-support';

export type KyselyDialectName = 'postgresql' | 'mysql' | 'sqlite';

export interface KyselyDialectInfo {
  dialect: KyselyDialectName;
  isDuplicateKeyError(error: unknown): boolean;
  translateParams(
    sql: string,
    params: Record<string, unknown>,
  ): { sql: string; values: unknown[] };
  numAffectedRows(result: unknown): number;
}

const DIALECT_INFOS: Record<KyselyDialectName, KyselyDialectInfo> = {
  postgresql: {
    dialect: 'postgresql',
    isDuplicateKeyError: (e) =>
      typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505',
    translateParams: (sql, params) => translateNamedParams(sql, params, (i: number) => `$${i}`),
    numAffectedRows: (result) => {
      if (typeof result !== 'object' || result === null) return 0;
      const r = result as { numAffectedRows?: number | bigint };
      const n = r.numAffectedRows;
      if (typeof n === 'bigint') return Number(n);
      return n ?? 0;
    },
  },
  mysql: {
    dialect: 'mysql',
    isDuplicateKeyError: (e) =>
      typeof e === 'object' && e !== null && (e as { errno?: number }).errno === 1062,
    translateParams: (sql, params) => translateNamedParams(sql, params, () => '?'),
    numAffectedRows: (result) => {
      if (typeof result !== 'object' || result === null) return 0;
      const r = result as { numAffectedRows?: number | bigint };
      const n = r.numAffectedRows;
      if (typeof n === 'bigint') return Number(n);
      return n ?? 0;
    },
  },
  sqlite: {
    dialect: 'sqlite',
    isDuplicateKeyError: (e) =>
      typeof e === 'object' && e !== null && ((e as Error).message ?? '').includes('UNIQUE constraint failed'),
    translateParams: (sql, params) => translateNamedParams(sql, params, () => '?'),
    numAffectedRows: (result) => {
      if (typeof result !== 'object' || result === null) return 0;
      const r = result as { numAffectedRows?: number | bigint };
      const n = r.numAffectedRows;
      if (typeof n === 'bigint') return Number(n);
      return n ?? 0;
    },
  },
};

export function getDialectInfo(dialect: KyselyDialectName): KyselyDialectInfo {
  return DIALECT_INFOS[dialect];
}
