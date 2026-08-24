import { randomUUID } from 'node:crypto';
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { z } from 'zod';
import type { CredentialStore } from './credential-store';
import {
  type McpCredential,
  PersistentOAuthProvider,
} from './oauth-provider';

export const McpInvokeInputSchema = z.object({
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

export type McpInvokeInput = z.infer<typeof McpInvokeInputSchema>;

type ConnectionOptions = {
  serverUrl: URL;
  credentialId: string;
  publicBaseUrl: URL;
  credentialStore: CredentialStore<McpCredential>;
};

export class McpConnection {
  readonly #serverUrl: URL;
  readonly #credentialId: string;
  readonly #publicBaseUrl: URL;
  readonly #credentialStore: CredentialStore<McpCredential>;
  #client?: Client;
  #transport?: StreamableHTTPClientTransport;
  #provider?: PersistentOAuthProvider;
  #connected = false;

  constructor(options: ConnectionOptions) {
    this.#serverUrl = options.serverUrl;
    this.#credentialId = options.credentialId;
    this.#publicBaseUrl = options.publicBaseUrl;
    this.#credentialStore = options.credentialStore;
  }

  async connect() {
    await this.close();
    const pending = this.#freshPending();
    const flowId = pending?.flowId ?? randomUUID();
    const state = pending?.state ?? randomUUID();
    const callbackUrl = new URL(`/oauth/callback/${flowId}`, this.#publicBaseUrl);
    const provider = new PersistentOAuthProvider({
      credentialId: this.#credentialId,
      callbackUrl,
      store: this.#credentialStore,
    });
    if (!pending) {
      provider.begin({
        flowId,
        state,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
    }

    const client = new Client({
      name: 'rgap-mcp-proxy',
      version: '0.0.0',
    });
    const transport = new StreamableHTTPClientTransport(this.#serverUrl, {
      authProvider: provider,
    });
    this.#client = client;
    this.#transport = transport;
    this.#provider = provider;

    try {
      await client.connect(transport);
      this.#connected = true;
      return { status: 'connected' as const };
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      const authorizationUrl = provider.pending()?.authorizationUrl;
      if (!authorizationUrl) {
        throw new Error('The MCP server requires OAuth but supplied no authorization URL.');
      }
      return {
        status: 'authorization_required' as const,
        authorizationUrl,
        flowId,
      };
    }
  }

  async finishAuthorization(flowId: string, callbackUrl: URL) {
    const provider = this.#provider;
    const transport = this.#transport;
    if (!provider || !transport || provider.pending()?.flowId !== flowId) {
      throw new Error('The OAuth flow is not active for this connection.');
    }
    const state = callbackUrl.searchParams.get('state');
    if (!state) throw new Error('The OAuth callback has no state.');
    provider.claim(flowId, state);
    await transport.finishAuth(callbackUrl.searchParams);
    provider.complete();
    return this.connect();
  }

  async request(input: McpInvokeInput, signal: AbortSignal) {
    if (input.method === 'initialize' || input.method === 'server/discover') {
      throw new Error(`The MCP SDK owns the ${input.method} lifecycle request.`);
    }
    if (!this.#client || !this.#connected) {
      throw new Error('The MCP connection is awaiting OAuth authorization.');
    }
    return this.#client.request(
      { method: input.method, params: input.params },
      z.unknown(),
      { signal },
    );
  }

  pendingFlowId() {
    return this.#provider?.pending()?.flowId;
  }

  isConnected() {
    return this.#connected;
  }

  async close() {
    const client = this.#client;
    this.#client = undefined;
    this.#transport = undefined;
    this.#provider = undefined;
    this.#connected = false;
    if (client) await client.close().catch(() => undefined);
  }

  #freshPending() {
    const pending = this.#credentialStore.get(this.#credentialId)?.pendingAuthorization;
    if (
      !pending ||
      pending.consumedAt ||
      new Date(pending.expiresAt).getTime() <= Date.now()
    ) return undefined;
    return pending;
  }
}
