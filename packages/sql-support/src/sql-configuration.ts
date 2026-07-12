import { LockException, Utils } from '@tslock/core';
import { DatabaseProduct } from './database-product.js';

export interface ColumnNames {
  readonly name: string;
  readonly lockUntil: string;
  readonly lockedAt: string;
  readonly lockedBy: string;
}

export interface SqlConfigurationOptions {
  databaseProduct: DatabaseProduct;
  tableName?: string;
  columnNames?: Partial<ColumnNames>;
  lockedByValue?: string;
  timeZone?: string;
  useDbTime?: boolean;
}

const DB_UPPER_CASE = new Set([DatabaseProduct.ORACLE, DatabaseProduct.DB2, DatabaseProduct.HSQL]);

export class SqlConfiguration {
  static readonly DEFAULT_TABLE_NAME = 'shedlock';
  static readonly DEFAULT_COLUMN_NAMES: ColumnNames = {
    name: 'name',
    lockUntil: 'lockUntil',
    lockedAt: 'lockedAt',
    lockedBy: 'lockedBy',
  };

  readonly databaseProduct: DatabaseProduct;
  readonly tableName: string;
  readonly columnNames: ColumnNames;
  readonly lockedByValue: string;
  readonly timeZone: string | undefined;
  readonly useDbTime: boolean;

  constructor(options: SqlConfigurationOptions) {
    this.databaseProduct = options.databaseProduct;
    this.tableName = options.tableName ?? SqlConfiguration.DEFAULT_TABLE_NAME;
    this.columnNames = {
      ...SqlConfiguration.DEFAULT_COLUMN_NAMES,
      ...options.columnNames,
    };
    this.lockedByValue = options.lockedByValue ?? Utils.getHostname();
    this.timeZone = options.timeZone;
    this.useDbTime = options.useDbTime ?? false;

    if (this.useDbTime && this.timeZone) {
      throw new LockException('Cannot set both useDbTime and timeZone');
    }

    if (DB_UPPER_CASE.has(this.databaseProduct)) {
      this.tableName = this.tableName.toUpperCase();
      this.columnNames = {
        name: this.columnNames.name.toUpperCase(),
        lockUntil: this.columnNames.lockUntil.toUpperCase(),
        lockedAt: this.columnNames.lockedAt.toUpperCase(),
        lockedBy: this.columnNames.lockedBy.toUpperCase(),
      };
    }
  }
}
