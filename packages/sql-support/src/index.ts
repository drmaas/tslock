export { DatabaseProduct, matchProductName } from './database-product.js';
export { SqlConfiguration } from './sql-configuration.js';
export type { ColumnNames, SqlConfigurationOptions } from './sql-configuration.js';
export {
  SQL_PARAM_NAMES,
  NAMED_PARAM_PATTERN,
  translateToPositional,
  buildPositionalParams,
  translateNamedParams,
} from './sql-statements.js';
export type { SqlStatements } from './sql-statements.js';
export { timestamp } from './timestamp.js';
export { SqlStatementsSource } from './sql-statements-source.js';
export { DefaultSqlStatementsSource } from './default-sql-statements-source.js';
export { PostgresSqlStatementsSource } from './postgres-sql-statements-source.js';
export {
  ServerTimeStatementsSource,
  PostgresServerTimeStatementsSource,
  MsSqlServerTimeStatementsSource,
  MySqlServerTimeStatementsSource,
  OracleServerTimeStatementsSource,
  HsqlServerTimeStatementsSource,
  H2ServerTimeStatementsSource,
  Db2ServerTimeStatementsSource,
  SqliteServerTimeStatementsSource,
} from './server-time-sql-statements-source.js';
export { createSqlStatementsSource } from './factory.js';
