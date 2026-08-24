import { createHash } from 'node:crypto';
import type { CredentialStore } from '@rgap/local-credential-store';

export type OAuthFlowRecord = {
  flowId: string;
  credentialId: string;
  serverUrl: string;
  expiresAt: string;
  claimedAt?: string;
};

export class OAuthFlowStore {
  readonly #store: CredentialStore<OAuthFlowRecord>;

  constructor(store: CredentialStore<OAuthFlowRecord>) {
    this.#store = store;
  }

  register(state: string, flow: OAuthFlowRecord) {
    return this.#store.set(stateKey(state), flow);
  }

  claim(state: string, now = new Date()) {
    return this.#store.update(stateKey(state), (flow) => {
      if (!flow) throw new Error('The OAuth callback state is invalid.');
      if (flow.claimedAt) throw new Error('The OAuth callback was already consumed.');
      if (new Date(flow.expiresAt).getTime() <= now.getTime()) {
        throw new Error('The OAuth callback has expired.');
      }
      return { ...flow, claimedAt: now.toISOString() };
    });
  }

  complete(state: string) {
    return this.#store.delete(stateKey(state));
  }

  close() {
    return this.#store.close();
  }
}

export function stateKey(state: string) {
  return createHash('sha256').update(state).digest('hex');
}
