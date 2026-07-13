declare module 'memjs' {
  interface ClientAddOptions {
    expires?: number;
  }
  interface ClientResult {
    success: boolean;
  }
  interface Client {
    add(key: string, value: string | Buffer, options?: ClientAddOptions): Promise<ClientResult>;
    replace(key: string, value: string | Buffer, options?: ClientAddOptions): Promise<ClientResult>;
    delete(key: string): Promise<ClientResult>;
  }
  interface ClientCreateOptions {
    [key: string]: unknown;
  }
  const Client: { create(servers: string, options?: ClientCreateOptions): Client };

  export { Client, ClientAddOptions, ClientCreateOptions, ClientResult };
}
