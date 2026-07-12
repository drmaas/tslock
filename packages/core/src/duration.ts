import { LockException } from './lock-exception.js';

export type DurationInput =
  | number
  | string
  | { hours?: number; minutes?: number; seconds?: number; millis?: number };

const UNIT_MULTIPLIERS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const STRING_PATTERN = /^(\d+)(ms|s|m|h|d)?$/;

export function parseDuration(input: DurationInput): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new LockException(`Invalid duration: ${input}`);
    }
    return input;
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed === '') {
      throw new LockException('Invalid duration: empty string');
    }
    const match = STRING_PATTERN.exec(trimmed);
    if (!match) {
      throw new LockException(`Invalid duration string: ${input}`);
    }
    const valueStr = match[1]!;
    const unit = match[2] ?? 'ms';
    const value = Number(valueStr);
    const multiplier = UNIT_MULTIPLIERS[unit]!;
    return value * multiplier;
  }

  if (typeof input === 'object' && input !== null) {
    const { hours = 0, minutes = 0, seconds = 0, millis = 0 } = input;
    const total = hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + millis;
    if (total < 0) {
      throw new LockException(`Invalid duration: ${JSON.stringify(input)}`);
    }
    return total;
  }

  throw new LockException(`Invalid duration: ${String(input)}`);
}
