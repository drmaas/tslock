export type DrizzleDialectName = 'postgresql' | 'mysql' | 'sqlite';

export interface DrizzleDialectInfo {
  dialect: DrizzleDialectName;
  isDuplicateKeyError(error: unknown): boolean;
  getAffectedRows(result: unknown): number;
}
