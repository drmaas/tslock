export enum DatabaseProduct {
  POSTGRES = 'POSTGRES',
  COCKROACH_DB = 'COCKROACH_DB',
  SQL_SERVER = 'SQL_SERVER',
  ORACLE = 'ORACLE',
  MYSQL = 'MYSQL',
  MARIA_DB = 'MARIADB',
  HSQL = 'HSQL',
  H2 = 'H2',
  DB2 = 'DB2',
  SQLITE = 'SQLITE',
  UNKNOWN = 'UNKNOWN',
}

export function matchProductName(name: string): DatabaseProduct {
  const lower = name.toLowerCase();
  if (lower.includes('cockroach')) return DatabaseProduct.COCKROACH_DB;
  if (lower.includes('mariadb')) return DatabaseProduct.MARIA_DB;
  if (lower.includes('postgresql') || lower.includes('postgres')) return DatabaseProduct.POSTGRES;
  if (lower.includes('microsoft sql server') || lower.includes('sql server')) return DatabaseProduct.SQL_SERVER;
  if (lower.includes('oracle')) return DatabaseProduct.ORACLE;
  if (lower.includes('mysql')) return DatabaseProduct.MYSQL;
  if (lower.includes('hsqldb') || lower.includes('hsql')) return DatabaseProduct.HSQL;
  if (lower.includes('h2')) return DatabaseProduct.H2;
  if (lower.includes('db2')) return DatabaseProduct.DB2;
  if (lower.includes('sqlite')) return DatabaseProduct.SQLITE;
  return DatabaseProduct.UNKNOWN;
}
