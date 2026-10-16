import { DatabaseProduct } from '@tslock/sql-support';
import { translateToPositional } from '../param-translator.js';
import type { QueryResult, SqlConnection } from '../sql-connection.js';

interface Mysql2Queryable {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

export class Mysql2Connection implements SqlConnection {
  private constructor(
    private readonly pool: Mysql2Queryable,
    private readonly product: DatabaseProduct,
  ) {}

  static async create(pool: Mysql2Queryable): Promise<Mysql2Connection> {
    const result = await pool.query('SELECT VERSION() AS version');
    const firstRow = Array.isArray(result)
      ? Array.isArray(result[0])
        ? (result[0] as { version?: string }[])[0]
        : (result[0] as { version?: string })
      : (result as { rows?: { version?: string }[] }).rows?.[0];
    const version = String(firstRow?.version ?? '').toLowerCase();
    const product = version.includes('mariadb') ? DatabaseProduct.MARIA_DB : DatabaseProduct.MYSQL;
    return new Mysql2Connection(pool, product);
  }

  getDatabaseProduct(): DatabaseProduct {
    return this.product;
  }

  async query(sql: string, params: Record<string, unknown>): Promise<QueryResult> {
    const { sql: mysqlSql, values } = translateToPositional(sql, params, () => '?');
    const result = await this.pool.query(mysqlSql, values);
    const resultRow = Array.isArray(result)
      ? Array.isArray(result[0])
        ? (result[0] as { affectedRows?: number }[])
        : [result[0] as { affectedRows?: number }]
      : [result as { affectedRows?: number }];
    const affected = resultRow[0]?.affectedRows ?? 0;
    return { affectedRows: affected };
  }

  isDuplicateKeyError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const e = error as { errno?: number; code?: string };
    return e.errno === 1062 || e.code === 'ER_DUP_ENTRY';
  }
}
