import type { DatabaseProduct } from '@tslock/sql-support';

export interface QueryResult {
  readonly affectedRows: number;
}

export interface SqlConnection {
  query(sql: string, params: Record<string, unknown>): Promise<QueryResult>;
  isDuplicateKeyError(error: unknown): boolean;
  getDatabaseProduct(): DatabaseProduct;
}
