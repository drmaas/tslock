declare module 'memjs' {
  interface ClientAddOptions {
    expires?: number;
  }
  interface Client {
    add(key: string, value: string | Buffer, options?: ClientAddOptions): Promise<boolean>;
    replace(key: string, value: string | Buffer, options?: ClientAddOptions): Promise<boolean>;
    delete(key: string): Promise<boolean>;
    get(key: string): Promise<{ value: Buffer | null; flags: Buffer | null }>;
  }
  interface ClientCreateOptions {
    [key: string]: unknown;
  }
  const Client: { create(servers: string, options?: ClientCreateOptions): Client };

  export { Client, type ClientAddOptions, type ClientCreateOptions };
}
