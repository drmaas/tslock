export class ClockProvider {
  private static clock: () => number = () => Date.now();

  static now(): number {
    return Math.trunc(ClockProvider.clock());
  }

  static setClock(clock: () => number): void {
    ClockProvider.clock = clock;
  }

  static resetClock(): void {
    ClockProvider.clock = () => Date.now();
  }
}
