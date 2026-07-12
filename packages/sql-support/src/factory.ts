import { DatabaseProduct } from './database-product.js';
import { DefaultSqlStatementsSource } from './default-sql-statements-source.js';
import { PostgresSqlStatementsSource } from './postgres-sql-statements-source.js';
import type { SqlConfiguration } from './sql-configuration.js';
import { SqlStatementsSource } from './sql-statements-source.js';
import {
  Db2ServerTimeStatementsSource,
  H2ServerTimeStatementsSource,
  HsqlServerTimeStatementsSource,
  MsSqlServerTimeStatementsSource,
  MySqlServerTimeStatementsSource,
  OracleServerTimeStatementsSource,
  PostgresServerTimeStatementsSource,
  SqliteServerTimeStatementsSource,
} from './server-time-sql-statements-source.js';

export function createSqlStatementsSource(config: SqlConfiguration): SqlStatementsSource {
  if (config.useDbTime) {
    switch (config.databaseProduct) {
      case DatabaseProduct.POSTGRES:
      case DatabaseProduct.COCKROACH_DB:
        return new PostgresServerTimeStatementsSource(config);
      case DatabaseProduct.SQL_SERVER:
        return new MsSqlServerTimeStatementsSource(config);
      case DatabaseProduct.MYSQL:
      case DatabaseProduct.MARIA_DB:
        return new MySqlServerTimeStatementsSource(config);
      case DatabaseProduct.ORACLE:
        return new OracleServerTimeStatementsSource(config);
      case DatabaseProduct.HSQL:
        return new HsqlServerTimeStatementsSource(config);
      case DatabaseProduct.H2:
        return new H2ServerTimeStatementsSource(config);
      case DatabaseProduct.DB2:
        return new Db2ServerTimeStatementsSource(config);
      case DatabaseProduct.SQLITE:
        return new SqliteServerTimeStatementsSource(config);
      default:
        throw new Error(`useDbTime not supported for ${config.databaseProduct}`);
    }
  }
  if (
    config.databaseProduct === DatabaseProduct.POSTGRES ||
    config.databaseProduct === DatabaseProduct.COCKROACH_DB
  ) {
    return new PostgresSqlStatementsSource(config);
  }
  return new DefaultSqlStatementsSource(config);
}
