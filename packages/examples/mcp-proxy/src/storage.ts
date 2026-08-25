export type Awaitable<T> = T | Promise<T>;

export interface CredentialStore<T> {
  get(resourceId: string): Awaitable<T | undefined>;
  set(resourceId: string, value: T): Awaitable<void>;
  update(
    resourceId: string,
    update: (current: T | undefined) => T,
  ): Awaitable<T>;
  delete(resourceId: string): Awaitable<void>;
  close(): Awaitable<void>;
}

export type OAuthFlowRecord = {
  flowId: string;
  credentialId: string;
  serverUrl: string;
  expiresAt: string;
  claimedAt?: string;
};

export interface OAuthFlowStore {
  register(state: string, flow: OAuthFlowRecord): Promise<void>;
  claim(state: string, now?: Date): Promise<OAuthFlowRecord>;
  complete(state: string): Promise<void>;
  close(): Promise<void>;
}
