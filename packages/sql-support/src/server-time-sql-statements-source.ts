import type { LockConfiguration } from '@tslock/core';
import type { SqlConfiguration } from './sql-configuration.js';
import { SQL_PARAM_NAMES } from './sql-statements.js';
import { SqlStatementsSource } from './sql-statements-source.js';

export abstract class ServerTimeStatementsSource extends SqlStatementsSource {
  readonly #insert: string;
  readonly #update: string;
  readonly #extend: string;
  readonly #unlock: string;

  constructor(config: SqlConfiguration) {
    super(config);
    const t = config.tableName;
    const c = config.columnNames;
    const nowExpr = this.nowExpression();
    this.#insert = this.buildInsert(t, c, nowExpr);
    this.#update = `UPDATE ${t} SET ${c.lockUntil} = :lockUntil, ${c.lockedAt} = ${nowExpr}, ${c.lockedBy} = :lockedBy WHERE ${c.name} = :name AND ${c.lockUntil} <= ${nowExpr}`;
    this.#extend = `UPDATE ${t} SET ${c.lockUntil} = :lockUntil WHERE ${c.name} = :name AND ${c.lockedBy} = :lockedBy AND ${c.lockUntil} > ${nowExpr}`;
    this.#unlock = `UPDATE ${t} SET ${c.lockUntil} = :unlockTime WHERE ${c.name} = :name AND ${c.lockedBy} = :lockedBy`;
  }

  protected abstract nowExpression(): string;

  protected buildInsert(
    _table: string,
    _cols: { name: string; lockUntil: string; lockedAt: string; lockedBy: string },
    _nowExpr: string,
  ): string {
    throw new Error('buildInsert must be overridden by subclass');
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

  override params(lockConfig: LockConfiguration): Record<string, unknown> {
    return {
      [SQL_PARAM_NAMES.NAME]: lockConfig.name,
      [SQL_PARAM_NAMES.LOCK_UNTIL]: this.timestampFor(lockConfig.createdAt + lockConfig.lockAtMostFor),
      [SQL_PARAM_NAMES.LOCKED_BY]: this.config.lockedByValue,
      [SQL_PARAM_NAMES.UNLOCK_TIME]: this.timestampFor(
        Math.max(lockConfig.createdAt + lockConfig.lockAtLeastFor, lockConfig.createdAt),
      ),
    };
  }
}

export class PostgresServerTimeStatementsSource extends ServerTimeStatementsSource {
  protected nowExpression(): string {
    return 'now()';
  }
  protected override buildInsert(
    table: string,
    cols: { name: string; lockUntil: string; lockedAt: string; lockedBy: string },
    nowExpr: string,
  ): string {
    return `INSERT INTO ${table}(${cols.name}, ${cols.lockUntil}, ${cols.lockedAt}, ${cols.lockedBy}) VALUES(:name, :lockUntil, ${nowExpr}, :lockedBy) ON CONFLICT (${cols.name}) DO NOTHING`;
  }
}

export class MsSqlServerTimeStatementsSource extends ServerTimeStatementsSource {
  protected nowExpression(): string {
    return 'GETUTCDATE()';
  }
  protected override buildInsert(
    table: string,
    cols: { name: string; lockUntil: string; lockedAt: string; lockedBy: string },
    nowExpr: string,
  ): string {
    return `INSERT INTO ${table}(${cols.name}, ${cols.lockUntil}, ${cols.lockedAt}, ${cols.lockedBy}) VALUES(:name, :lockUntil, ${nowExpr}, :lockedBy)`;
  }
}

export class MySqlServerTimeStatementsSource extends ServerTimeStatementsSource {
  protected nowExpression(): string {
    return 'UTC_TIMESTAMP(3)';
  }
  protected override buildInsert(
    table: string,
    cols: { name: string; lockUntil: string; lockedAt: string; lockedBy: string },
    nowExpr: string,
  ): string {
    return `INSERT INTO ${table}(${cols.name}, ${cols.lockUntil}, ${cols.lockedAt}, ${cols.lockedBy}) VALUES(:name, :lockUntil, ${nowExpr}, :lockedBy)`;
  }
}

export class OracleServerTimeStatementsSource extends ServerTimeStatementsSource {
  protected nowExpression(): string {
    return 'CURRENT_TIMESTAMP';
  }
  protected override buildInsert(
    table: string,
    cols: { name: string; lockUntil: string; lockedAt: string; lockedBy: string },
    nowExpr: string,
  ): string {
    return `INSERT INTO ${table}(${cols.name}, ${cols.lockUntil}, ${cols.lockedAt}, ${cols.lockedBy}) VALUES(:name, :lockUntil, ${nowExpr}, :lockedBy)`;
  }
}

export class HsqlServerTimeStatementsSource extends ServerTimeStatementsSource {
  protected nowExpression(): string {
    return 'CURRENT_TIMESTAMP';
  }
  protected override buildInsert(
    table: string,
    cols: { name: string; lockUntil: string; lockedAt: string; lockedBy: string },
    nowExpr: string,
  ): string {
    return `INSERT INTO ${table}(${cols.name}, ${cols.lockUntil}, ${cols.lockedAt}, ${cols.lockedBy}) VALUES(:name, :lockUntil, ${nowExpr}, :lockedBy)`;
  }
}

export class H2ServerTimeStatementsSource extends ServerTimeStatementsSource {
  protected nowExpression(): string {
    return 'CURRENT_TIMESTAMP';
  }
  protected override buildInsert(
    table: string,
    cols: { name: string; lockUntil: string; lockedAt: string; lockedBy: string },
    nowExpr: string,
  ): string {
    return `INSERT INTO ${table}(${cols.name}, ${cols.lockUntil}, ${cols.lockedAt}, ${cols.lockedBy}) VALUES(:name, :lockUntil, ${nowExpr}, :lockedBy)`;
  }
}

export class Db2ServerTimeStatementsSource extends ServerTimeStatementsSource {
  protected nowExpression(): string {
    return 'CURRENT_TIMESTAMP';
  }
  protected override buildInsert(
    table: string,
    cols: { name: string; lockUntil: string; lockedAt: string; lockedBy: string },
    nowExpr: string,
  ): string {
    return `INSERT INTO ${table}(${cols.name}, ${cols.lockUntil}, ${cols.lockedAt}, ${cols.lockedBy}) VALUES(:name, :lockUntil, ${nowExpr}, :lockedBy)`;
  }
}

export class SqliteServerTimeStatementsSource extends ServerTimeStatementsSource {
  protected nowExpression(): string {
    return "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  }
  protected override buildInsert(
    table: string,
    cols: { name: string; lockUntil: string; lockedAt: string; lockedBy: string },
    nowExpr: string,
  ): string {
    return `INSERT OR IGNORE INTO ${table}(${cols.name}, ${cols.lockUntil}, ${cols.lockedAt}, ${cols.lockedBy}) VALUES(:name, :lockUntil, ${nowExpr}, :lockedBy)`;
  }
}
