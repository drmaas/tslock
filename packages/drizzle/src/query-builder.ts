import { LockException } from '@tslock/core';
import { NAMED_PARAM_PATTERN } from '@tslock/sql-support';
import { param, type SQL, sql } from 'drizzle-orm';

export function buildDrizzleQuery(rawSql: string, params: Record<string, unknown>): SQL {
  const chunks: SQL[] = [];
  let lastIndex = 0;
  const regex = new RegExp(NAMED_PARAM_PATTERN.source, 'g');
  let match: RegExpExecArray | null = regex.exec(rawSql);
  while (match !== null) {
    if (match.index > lastIndex) {
      chunks.push(sql.raw(rawSql.slice(lastIndex, match.index)));
    }
    const name = match[1]!;
    if (!(name in params)) {
      throw new LockException(`Missing param: ${name}`);
    }
    chunks.push(param(params[name]) as unknown as SQL);
    lastIndex = regex.lastIndex;
    match = regex.exec(rawSql);
  }
  if (lastIndex < rawSql.length) {
    chunks.push(sql.raw(rawSql.slice(lastIndex)));
  }
  if (chunks.length === 0) {
    return sql.raw(rawSql);
  }
  if (chunks.length === 1) {
    return chunks[0]!;
  }
  return sql.join(chunks, sql.raw(''));
}
