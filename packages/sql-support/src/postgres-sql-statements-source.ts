import type { SqlConfiguration } from './sql-configuration.js';
import { SqlStatementsSource } from './sql-statements-source.js';

export class PostgresSqlStatementsSource extends SqlStatementsSource {
  readonly #insert: string;
  readonly #update: string;
  readonly #extend: string;
  readonly #unlock: string;

  constructor(config: SqlConfiguration) {
    super(config);
    const t = config.tableName;
    const c = config.columnNames;
    this.#insert = `INSERT INTO ${t}(${c.name}, ${c.lockUntil}, ${c.lockedAt}, ${c.lockedBy}) VALUES(:name, :lockUntil, :now, :lockedBy) ON CONFLICT (${c.name}) DO NOTHING`;
    this.#update = `UPDATE ${t} SET ${c.lockUntil} = :lockUntil, ${c.lockedAt} = :now, ${c.lockedBy} = :lockedBy WHERE ${c.name} = :name AND ${c.lockUntil} <= :now`;
    this.#extend = `UPDATE ${t} SET ${c.lockUntil} = :lockUntil WHERE ${c.name} = :name AND ${c.lockedBy} = :lockedBy AND ${c.lockUntil} > :now`;
    this.#unlock = `UPDATE ${t} SET ${c.lockUntil} = :unlockTime WHERE ${c.name} = :name AND ${c.lockedBy} = :lockedBy`;
  }

  getInsertStatement(): string {
    return this.#insert;
  }
  getUpdateStatement(): string {
    return this.#update;
  }
  getExtendStatement(): string {
    return this.#extend;
  }
  getUnlockStatement(): string {
    return this.#unlock;
  }
}
