export interface Stat {
  version: number;
}

export interface ZooKeeperClient {
  get(path: string, watch: boolean): Promise<[Stat, string | Buffer]>;
  set(path: string, data: Buffer, version: number): Promise<Stat>;
  create(path: string, data: Buffer, flags: number): Promise<string>;
  mkdirp(path: string, callback: (err: Error | null) => void): void;
}
