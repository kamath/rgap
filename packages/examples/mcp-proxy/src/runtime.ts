import type { InvokeRuntime } from '@rgap/core';
import type { CredentialStore } from '@rgap/local-credential-store';
import type {
  OAuthFlowStore,
} from '@rgap/local-oauth-flow-store';
import { z } from 'zod';
import {
  McpConnection,
  McpInvokeInputSchema,
} from './mcp-connection';
import {
  type McpCredential,
  oauthClientMetadataDocument,
} from './oauth-provider';

const McpRuntimeInputSchema = McpInvokeInputSchema.extend({
  serverUrl: z.url(),
  server: z.string(),
  credential: z.string(),
});

type McpRuntimeInput = z.infer<typeof McpRuntimeInputSchema>;

export type McpProxyRuntimeOptions = {
  publicBaseUrl: URL;
  credentialStore: CredentialStore<McpCredential>;
  flowStore: OAuthFlowStore;
};

export class McpProxyRuntime {
  readonly publicBaseUrl: URL;
  readonly callbackUrl: URL;
  readonly clientMetadataUrl?: URL;
  readonly runtime: InvokeRuntime<McpRuntimeInput, unknown>;
  readonly #credentialStore: CredentialStore<McpCredential>;
  readonly #flowStore: OAuthFlowStore;
  readonly #connections = new Map<string, McpConnection>();

  constructor(options: McpProxyRuntimeOptions) {
    this.publicBaseUrl = normalizedBaseUrl(options.publicBaseUrl);
    this.callbackUrl = routeUrl(this.publicBaseUrl, 'oauth/callback');
    this.clientMetadataUrl = this.publicBaseUrl.protocol === 'https:'
      ? routeUrl(this.publicBaseUrl, 'oauth/client-metadata.json')
      : undefined;
    this.#credentialStore = options.credentialStore;
    this.#flowStore = options.flowStore;
    this.runtime = {
      inputSchema: McpRuntimeInputSchema,
      outputSchema: null,
      invoke: ({ input, signal }) => this.#invoke(input, signal),
    };
  }

  async connect(serverUrl: URL, credentialId: string) {
    const connection = this.#connectionFor(serverUrl, credentialId);
    const status = await connection.connect();
    await this.#registerFlow(connection);
    return status;
  }

  clientMetadataDocument() {
    if (!this.clientMetadataUrl) return undefined;
    return oauthClientMetadataDocument(
      this.clientMetadataUrl,
      this.callbackUrl,
      this.publicBaseUrl.origin,
    );
  }

  async finishAuthorization(state: string, callbackUrl: URL) {
    const flow = await this.#flowStore.claim(state);
    const connection = this.#connectionFor(
      new URL(flow.serverUrl),
      flow.credentialId,
    );
    try {
      if (!connection.isConnected()) await connection.connect();
      const status = await connection.finishAuthorization(flow.flowId, callbackUrl);
      await this.#flowStore.complete(state);
      await this.#registerFlow(connection);
      return status;
    } catch (error) {
      throw error;
    }
  }

  async close() {
    await Promise.all(
      [...this.#connections.values()].map((connection) => connection.close()),
    );
    this.#connections.clear();
  }

  async #invoke(input: McpRuntimeInput, signal: AbortSignal) {
    const connection = this.#connectionFor(
      new URL(input.serverUrl),
      input.credential,
    );
    if (!connection.isConnected()) {
      const status = await connection.connect();
      await this.#registerFlow(connection);
      if (status.status === 'authorization_required') {
        throw new Error(
          `MCP OAuth authorization is required: ${status.authorizationUrl}`,
        );
      }
    }
    try {
      return await connection.request({
        method: input.method,
        params: input.params,
      }, signal);
    } finally {
      await this.#registerFlow(connection);
    }
  }

  #connectionFor(serverUrl: URL, credentialId: string) {
    const key = `${credentialId}\0${serverUrl}`;
    const existing = this.#connections.get(key);
    if (existing) return existing;
    const connection = new McpConnection({
      serverUrl,
      credentialId,
      callbackUrl: this.callbackUrl,
      clientMetadataUrl: this.clientMetadataUrl?.toString(),
      credentialStore: this.#credentialStore,
    });
    this.#connections.set(key, connection);
    return connection;
  }

  async #registerFlow(connection: McpConnection) {
    const flow = await connection.pendingAuthorization();
    if (flow) await this.#flowStore.register(flow.state, flow);
  }
}

export function createMcpProxyRuntime(options: McpProxyRuntimeOptions) {
  return new McpProxyRuntime(options);
}

function normalizedBaseUrl(url: URL) {
  const normalized = new URL(url);
  normalized.search = '';
  normalized.hash = '';
  if (!normalized.pathname.endsWith('/')) normalized.pathname += '/';
  return normalized;
}

function routeUrl(baseUrl: URL, path: string) {
  return new URL(path, baseUrl);
}
