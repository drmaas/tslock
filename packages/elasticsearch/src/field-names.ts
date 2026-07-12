export interface ElasticsearchFieldNames {
  lockUntil: string;
  lockedAt: string;
  lockedBy: string;
}

export const FieldNames = {
  DEFAULT: { lockUntil: 'lockUntil', lockedAt: 'lockedAt', lockedBy: 'lockedBy' } as const,
  SNAKE_CASE: { lockUntil: 'lock_until', lockedAt: 'locked_at', lockedBy: 'locked_by' } as const,
};
