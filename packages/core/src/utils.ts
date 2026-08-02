import { hostname as osHostname } from 'node:os';
import { LockException } from './lock-exception.js';

const MAX_LOCK_NAME_BYTES = 1024;
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

let cachedHostname: string | undefined;

export class Utils {
  static getHostname(): string {
    if (cachedHostname === undefined) {
      try {
        cachedHostname = osHostname();
      } catch {
        return 'unknown';
      }
    }
    return cachedHostname;
  }

  static toIsoString(epochMillis: number): string {
    return new Date(epochMillis).toISOString();
  }

  /** Converts a duration in milliseconds to a TTL in seconds, rounding up so the key never expires early. */
  static toTtlSeconds(ms: number): number {
    return Math.floor(ms / 1000) + 1;
  }

  static validateLockName(name: string): void {
    if (CONTROL_CHARACTERS.test(name)) {
      throw new LockException('Lock name must not contain control characters');
    }
    if (Buffer.byteLength(name, 'utf8') > MAX_LOCK_NAME_BYTES) {
      throw new LockException(`Lock name must not exceed ${MAX_LOCK_NAME_BYTES} UTF-8 bytes`);
    }
  }
}
