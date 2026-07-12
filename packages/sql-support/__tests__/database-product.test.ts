import { describe, expect, it } from 'vitest';
import { DatabaseProduct, matchProductName } from '../src/database-product.js';

describe('matchProductName', () => {
  it('matches PostgreSQL variants', () => {
    expect(matchProductName('PostgreSQL')).toBe(DatabaseProduct.POSTGRES);
    expect(matchProductName('postgres')).toBe(DatabaseProduct.POSTGRES);
    expect(matchProductName('PostgreSQL 14.5')).toBe(DatabaseProduct.POSTGRES);
  });

  it('matches CockroachDB before PostgreSQL', () => {
    expect(matchProductName('CockroachDB')).toBe(DatabaseProduct.COCKROACH_DB);
    expect(matchProductName('cockroach')).toBe(DatabaseProduct.COCKROACH_DB);
  });

  it('matches SQL Server', () => {
    expect(matchProductName('Microsoft SQL Server')).toBe(DatabaseProduct.SQL_SERVER);
    expect(matchProductName('SQL Server 2019')).toBe(DatabaseProduct.SQL_SERVER);
  });

  it('matches MariaDB before MySQL', () => {
    expect(matchProductName('MariaDB')).toBe(DatabaseProduct.MARIA_DB);
    expect(matchProductName('mariadb-server')).toBe(DatabaseProduct.MARIA_DB);
  });

  it('matches MySQL', () => {
    expect(matchProductName('MySQL')).toBe(DatabaseProduct.MYSQL);
    expect(matchProductName('mysql-8.0')).toBe(DatabaseProduct.MYSQL);
  });

  it('matches Oracle', () => {
    expect(matchProductName('Oracle Database')).toBe(DatabaseProduct.ORACLE);
  });

  it('matches HSQLDB', () => {
    expect(matchProductName('HSQL Database Engine')).toBe(DatabaseProduct.HSQL);
    expect(matchProductName('HSQLDB')).toBe(DatabaseProduct.HSQL);
  });

  it('matches H2', () => {
    expect(matchProductName('H2')).toBe(DatabaseProduct.H2);
    expect(matchProductName('H2 1.4.200')).toBe(DatabaseProduct.H2);
  });

  it('matches DB2', () => {
    expect(matchProductName('DB2')).toBe(DatabaseProduct.DB2);
    expect(matchProductName('IBM DB2')).toBe(DatabaseProduct.DB2);
  });

  it('matches SQLite', () => {
    expect(matchProductName('SQLite')).toBe(DatabaseProduct.SQLITE);
  });

  it('returns UNKNOWN for unrecognized', () => {
    expect(matchProductName('some unknown db')).toBe(DatabaseProduct.UNKNOWN);
  });
});
