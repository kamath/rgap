import { randomUUID } from 'node:crypto';
import {
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import type { CredentialStore } from '@rgap/local-credential-store';

export type PendingAuthorization = {
  flowId: string;
  state: string;
  codeVerifier?: string;
  authorizationUrl?: string;
  expiresAt: string;
  consumedAt?: string;
};

export type McpCredential = {
  tokens?: StoredOAuthTokens;
  clientInformation?: StoredOAuthClientInformation;
  discoveryState?: OAuthDiscoveryState;
  pendingAuthorization?: PendingAuthorization;
};

type ProviderOptions = {
  credentialId: string;
  callbackUrl: URL;
  clientMetadataUrl?: string;
  store: CredentialStore<McpCredential>;
};

export class PersistentOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;
  readonly #credentialId: string;
  readonly #callbackUrl: URL;
  readonly #store: CredentialStore<McpCredential>;

  constructor(options: ProviderOptions) {
    this.#credentialId = options.credentialId;
    this.#callbackUrl = options.callbackUrl;
    this.clientMetadataUrl = options.clientMetadataUrl;
    this.#store = options.store;
  }

  get redirectUrl() {
    return this.#callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return oauthClientMetadata(this.#callbackUrl);
  }

  async state() {
    const current = (await this.#record()).pendingAuthorization;
    if (
      current &&
      !current.consumedAt &&
      new Date(current.expiresAt).getTime() > Date.now()
    ) return current.state;

    const pendingAuthorization = {
      flowId: randomUUID(),
      state: randomUUID(),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    await this.begin(pendingAuthorization);
    return pendingAuthorization.state;
  }

  async clientInformation(_context?: OAuthClientInformationContext) {
    return (await this.#record()).clientInformation;
  }

  saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    _context?: OAuthClientInformationContext,
  ) {
    return this.#patch((record) => ({ ...record, clientInformation }));
  }

  async tokens(_context?: OAuthClientInformationContext) {
    return (await this.#record()).tokens;
  }

  saveTokens(tokens: StoredOAuthTokens, _context?: OAuthClientInformationContext) {
    return this.#patch((record) => ({ ...record, tokens }));
  }

  redirectToAuthorization(authorizationUrl: URL) {
    return this.#patch((record) => ({
      ...record,
      pendingAuthorization: {
        ...this.#requiredPending(record),
        authorizationUrl: authorizationUrl.toString(),
      },
    }));
  }

  saveCodeVerifier(codeVerifier: string) {
    return this.#patch((record) => ({
      ...record,
      pendingAuthorization: {
        ...this.#requiredPending(record),
        codeVerifier,
      },
    }));
  }

  async codeVerifier() {
    const verifier = (await this.#pending()).codeVerifier;
    if (!verifier) throw new Error('The OAuth PKCE verifier is unavailable.');
    return verifier;
  }

  saveDiscoveryState(discoveryState: OAuthDiscoveryState) {
    return this.#patch((record) => ({ ...record, discoveryState }));
  }

  async discoveryState() {
    return (await this.#record()).discoveryState;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    return this.#patch((record) => {
      if (scope === 'all') return {};
      if (scope === 'client') {
        const { clientInformation: _, ...rest } = record;
        return rest;
      }
      if (scope === 'tokens') {
        const { tokens: _, ...rest } = record;
        return rest;
      }
      if (scope === 'discovery') {
        const { discoveryState: _, ...rest } = record;
        return rest;
      }
      if (scope === 'verifier' && record.pendingAuthorization) {
        const { codeVerifier: _, ...pendingAuthorization } = record.pendingAuthorization;
        return { ...record, pendingAuthorization };
      }
      return record;
    });
  }

  begin(pendingAuthorization: PendingAuthorization) {
    return this.#patch((record) => ({ ...record, pendingAuthorization }));
  }

  claim(flowId: string, state: string, now = new Date()) {
    return this.#patch((record) => {
      const pending = this.#requiredPending(record);
      if (pending.flowId !== flowId || pending.state !== state) {
        throw new Error('The OAuth callback state is invalid.');
      }
      if (pending.consumedAt) throw new Error('The OAuth callback was already consumed.');
      if (new Date(pending.expiresAt).getTime() <= now.getTime()) {
        throw new Error('The OAuth callback has expired.');
      }
      return {
        ...record,
        pendingAuthorization: {
          ...pending,
          consumedAt: now.toISOString(),
        },
      };
    });
  }

  complete() {
    return this.#patch((record) => {
      const { pendingAuthorization: _, ...complete } = record;
      return complete;
    });
  }

  async pending() {
    return (await this.#record()).pendingAuthorization;
  }

  async #record() {
    return await this.#store.get(this.#credentialId) ?? {};
  }

  async #pending() {
    return this.#requiredPending(await this.#record());
  }

  #requiredPending(record: McpCredential) {
    if (!record.pendingAuthorization) {
      throw new Error('No OAuth authorization is pending.');
    }
    return record.pendingAuthorization;
  }

  #patch(update: (record: McpCredential) => McpCredential) {
    return this.#store.update(this.#credentialId, (record) => update(record ?? {}));
  }
}

export function oauthClientMetadata(callbackUrl: URL): OAuthClientMetadata {
  return {
    client_name: 'RGAP MCP proxy example',
    redirect_uris: [callbackUrl.toString()],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

export function oauthClientMetadataDocument(
  clientMetadataUrl: URL,
  callbackUrl: URL,
  clientUri: string,
) {
  return {
    client_id: clientMetadataUrl.toString(),
    client_uri: clientUri,
    ...oauthClientMetadata(callbackUrl),
  };
}
