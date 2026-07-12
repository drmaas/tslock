import { DatabaseProduct } from '@tslock/sql-support';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { QueryResult, SqlConnection } from '../sql-connection.js';
import { translateToPositional } from '../param-translator.js';

export class Mysql2Connection implements SqlConnection {
  private static readonly MARIADB_DETECT_KEY = '__tslock_mariadb_detected';

  private constructor(
    private readonly pool: Pool,
    private readonly product: DatabaseProduct,
  ) {}

  static async create(pool: Pool): Promise<Mysql2Connection> {
    const result = (await pool.query<RowDataPacket[]>('SELECT VERSION() AS version')) as unknown;
    const firstRow = Array.isArray(result)
      ? (Array.isArray(result[0]) ? (result[0] as RowDataPacket[])[0] : (result[0] as RowDataPacket))
      : (result as { rows?: RowDataPacket[] }).rows?.[0];
    const version = String((firstRow as { version?: string })?.version ?? '').toLowerCase();
    const product = version.includes('mariadb') ? DatabaseProduct.MARIA_DB : DatabaseProduct.MYSQL;
    return new Mysql2Connection(pool, product);
  }

  getDatabaseProduct(): DatabaseProduct {
    return this.product;
  }

  async query(sql: string, params: Record<string, unknown>): Promise<QueryResult> {
    const { sql: mysqlSql, values } = translateToPositional(sql, params, () => '?');
    const result = (await this.pool.query(mysqlSql, values)) as unknown;
    const resultRow = Array.isArray(result)
      ? (Array.isArray(result[0]) ? (result[0] as { affectedRows?: number }[]) : [result[0] as { affectedRows?: number }])
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
