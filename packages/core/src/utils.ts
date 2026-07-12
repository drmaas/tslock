import { hostname } from 'node:os';

export class Utils {
  static getHostname(): string {
    try {
      return hostname();
    } catch {
      return 'unknown';
    }
  }

  static toIsoString(epochMillis: number): string {
    return new Date(epochMillis).toISOString();
  }
}
