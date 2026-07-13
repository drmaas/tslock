export interface ResolvedColumnNames {
  readonly name: string;
  readonly lockUntil: string;
  readonly lockedAt: string;
  readonly lockedBy: string;
}

export interface ResolvedCassandraOptions {
  readonly keyspace: string;
  readonly tableName: string;
  readonly columnNames: ResolvedColumnNames;
  readonly lockedByValue: string;
  readonly consistencyLevel: number;
  readonly serialConsistencyLevel: number;
}

export function buildInsertCql(opts: {
  keyspace: string;
  tableName: string;
  columnNames: ResolvedColumnNames;
}): string {
  const { keyspace, tableName, columnNames } = opts;
  return `INSERT INTO ${keyspace}.${tableName} (${columnNames.name}, ${columnNames.lockUntil}, ${columnNames.lockedAt}, ${columnNames.lockedBy}) VALUES (?, ?, ?, ?) IF NOT EXISTS`;
}

export function buildUpdateCql(opts: {
  keyspace: string;
  tableName: string;
  columnNames: ResolvedColumnNames;
}): string {
  const { keyspace, tableName, columnNames } = opts;
  return `UPDATE ${keyspace}.${tableName} SET ${columnNames.lockUntil} = ?, ${columnNames.lockedAt} = ?, ${columnNames.lockedBy} = ? WHERE ${columnNames.name} = ? IF ${columnNames.lockUntil} < ?`;
}

export function buildUnlockCql(opts: {
  keyspace: string;
  tableName: string;
  columnNames: ResolvedColumnNames;
}): string {
  const { keyspace, tableName, columnNames } = opts;
  return `UPDATE ${keyspace}.${tableName} SET ${columnNames.lockUntil} = ? WHERE ${columnNames.name} = ? IF ${columnNames.lockedBy} = ? AND ${columnNames.lockUntil} >= ?`;
}

export function buildExtendCql(opts: {
  keyspace: string;
  tableName: string;
  columnNames: ResolvedColumnNames;
}): string {
  const { keyspace, tableName, columnNames } = opts;
  return `UPDATE ${keyspace}.${tableName} SET ${columnNames.lockUntil} = ? WHERE ${columnNames.name} = ? IF ${columnNames.lockedBy} = ? AND ${columnNames.lockUntil} >= ?`;
}

export function buildCreateTableCql(opts: {
  keyspace: string;
  tableName: string;
  columnNames: ResolvedColumnNames;
}): string {
  const { keyspace, tableName, columnNames } = opts;
  return `CREATE TABLE IF NOT EXISTS ${keyspace}.${tableName} (${columnNames.name} text PRIMARY KEY, ${columnNames.lockUntil} timestamp, ${columnNames.lockedAt} timestamp, ${columnNames.lockedBy} text)`;
}
