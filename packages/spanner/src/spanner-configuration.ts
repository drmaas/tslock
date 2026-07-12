import { Utils } from '@tslock/core';
import type { Database } from '@google-cloud/spanner';

export interface SpannerColumnNames {
  readonly name: string;
  readonly lockUntil: string;
  readonly lockedAt: string;
  readonly lockedBy: string;
}

export interface SpannerConfiguration {
  readonly database: Database;
  readonly tableName?: string;
  readonly columnNames?: Partial<SpannerColumnNames>;
  readonly lockedByValue?: string;
}

interface ResolvedSpannerConfiguration {
  readonly database: Database;
  readonly tableName: string;
  readonly columnNames: SpannerColumnNames;
  readonly lockedByValue: string;
}

const DEFAULT_COLUMN_NAMES: SpannerColumnNames = {
  name: 'name',
  lockUntil: 'lockUntil',
  lockedAt: 'lockedAt',
  lockedBy: 'lockedBy',
};

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function resolveSpannerConfiguration(input: SpannerConfiguration): ResolvedSpannerConfiguration {
  if (!input.database) {
    throw new Error('SpannerConfiguration: database is required');
  }

  const tableName = input.tableName ?? 'shedlock';
  if (!IDENTIFIER_RE.test(tableName)) {
    throw new Error(`SpannerConfiguration: invalid tableName "${tableName}"`);
  }

  const merged: SpannerColumnNames = {
    name: input.columnNames?.name ?? DEFAULT_COLUMN_NAMES.name,
    lockUntil: input.columnNames?.lockUntil ?? DEFAULT_COLUMN_NAMES.lockUntil,
    lockedAt: input.columnNames?.lockedAt ?? DEFAULT_COLUMN_NAMES.lockedAt,
    lockedBy: input.columnNames?.lockedBy ?? DEFAULT_COLUMN_NAMES.lockedBy,
  };

  for (const [key, value] of Object.entries(merged)) {
    if (!IDENTIFIER_RE.test(value)) {
      throw new Error(`SpannerConfiguration: invalid columnNames.${key} "${value}"`);
    }
  }

  const lockedByValue = input.lockedByValue ?? Utils.getHostname();

  return Object.freeze({
    database: input.database,
    tableName,
    columnNames: merged,
    lockedByValue,
  });
}
