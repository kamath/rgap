import { createHash, randomBytes } from 'node:crypto';
import type { InvokeRuntime } from '@rgap/core';
import { z } from 'zod';
import type { SecretStore } from './store';

const McpClientInputSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('authorize'),
    serverUrl: z.string().url(),
    credential: z.string(),
    callbackResourceId: z.string().min(1),
  }),
  z.object({
    operation: z.literal('callback'),
    serverUrl: z.string().url(),
    credential: z.string(),
    code: z.string().min(1),
    state: z.string().min(1),
  }),
  z.object({
    operation: z.literal('rpc'),
    serverUrl: z.string().url(),
    credential: z.string(),
    method: z.string().min(1),
    params: z.unknown().optional(),
  }),
]);

const McpClientOutputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('authorization'),
    authorizationUrl: z.string().url(),
  }),
  z.object({ type: z.literal('connected') }),
  z.object({
    type: z.literal('rpc'),
    result: z.unknown(),
  }),
]);

export type McpClientInput = z.infer<typeof McpClientInputSchema>;
export type McpClientOutput = z.infer<typeof McpClientOutputSchema>;

const CredentialSchema = z.object({
  client: z.object({
    clientId: z.string(),
    clientSecret: z.string().optional(),
  }).optional(),
  tokens: z.object({
    accessToken: z.string(),
    refreshToken: z.string().optional(),
    tokenType: z.string(),
    expiresAt: z.number().optional(),
    scope: z.string().optional(),
  }).optional(),
  mcpSessionId: z.string().optional(),
  initialized: z.boolean().optional(),
});

const SessionSchema = z.object({
  callbackResourceId: z.string(),
  credentialId: z.string(),
  serverUrl: z.string(),
  codeVerifier: z.string(),
  redirectUri: z.string(),
});

type CredentialRecord = z.infer<typeof CredentialSchema>;

export type McpClientRuntimeOptions = {
  secretStore: SecretStore;
  publicBaseUrl: string;
};

export function createMcpClientRuntime({
  secretStore,
  publicBaseUrl,
}: McpClientRuntimeOptions): InvokeRuntime<McpClientInput, McpClientOutput> {
  const redirectUri = `${trimSlash(publicBaseUrl)}/oauth/callback`;

  return {
    inputSchema: McpClientInputSchema,
    outputSchema: McpClientOutputSchema,
    async invoke({ input, signal }) {
      if (input.operation === 'authorize') {
        return authorize(secretStore, {
          serverUrl: input.serverUrl,
          credentialId: input.credential,
          callbackResourceId: input.callbackResourceId,
          redirectUri,
          signal,
        });
      }
      if (input.operation === 'callback') {
        await callback(secretStore, input, signal);
        return { type: 'connected' };
      }
      return {
        type: 'rpc',
        result: await rpc(secretStore, input, signal),
      };
    },
  };
}

export async function callbackResourceIdForState(
  secretStore: SecretStore,
  state: string,
) {
  const session = await readSession(secretStore, state);
  return session?.callbackResourceId;
}

async function authorize(
  secretStore: SecretStore,
  input: {
    serverUrl: string;
    credentialId: string;
    callbackResourceId: string;
    redirectUri: string;
    signal: AbortSignal;
  },
): Promise<McpClientOutput> {
  const serverUrl = trimSlash(input.serverUrl);
  const discovery = await discover(serverUrl, input.signal);
  const credential = await readCredential(secretStore, input.credentialId);
  const client = credential.client
    ?? await registerClient(discovery, input.redirectUri, input.signal);
  await writeCredential(secretStore, input.credentialId, { ...credential, client });

  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  await secretStore.set(`oauth:session:${state}`, JSON.stringify({
    callbackResourceId: input.callbackResourceId,
    credentialId: input.credentialId,
    serverUrl,
    codeVerifier: verifier,
    redirectUri: input.redirectUri,
  } satisfies z.infer<typeof SessionSchema>));

  const authorizationUrl = new URL(discovery.authorizationEndpoint);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', client.clientId);
  authorizationUrl.searchParams.set('redirect_uri', input.redirectUri);
  authorizationUrl.searchParams.set('code_challenge', pkceChallenge(verifier));
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('resource', discovery.resource);
  if (discovery.scope) authorizationUrl.searchParams.set('scope', discovery.scope);
  return { type: 'authorization', authorizationUrl: authorizationUrl.toString() };
}

async function callback(
  secretStore: SecretStore,
  input: Extract<McpClientInput, { operation: 'callback' }>,
  signal: AbortSignal,
) {
  const session = await readSession(secretStore, input.state);
  if (!session) throw new Error('OAuth session is unknown or expired.');
  if (session.credentialId !== input.credential) {
    throw new Error('OAuth session does not match this credential.');
  }
  if (session.serverUrl !== trimSlash(input.serverUrl)) {
    throw new Error('OAuth session does not match this server.');
  }

  const discovery = await discover(session.serverUrl, signal);
  const credential = await readCredential(secretStore, input.credential);
  if (!credential.client) throw new Error('OAuth client is not registered.');

  const tokens = await requestToken(discovery.tokenEndpoint, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: session.redirectUri,
    code_verifier: session.codeVerifier,
    client_id: credential.client.clientId,
    client_secret: credential.client.clientSecret,
    resource: discovery.resource,
  }, signal);

  await writeCredential(secretStore, input.credential, {
    ...credential,
    tokens,
    mcpSessionId: undefined,
    initialized: false,
  });
  await secretStore.delete(`oauth:session:${input.state}`);
}

async function rpc(
  secretStore: SecretStore,
  input: Extract<McpClientInput, { operation: 'rpc' }>,
  signal: AbortSignal,
) {
  const serverUrl = trimSlash(input.serverUrl);
  let credential = await readCredential(secretStore, input.credential);
  if (!credential.tokens) throw new Error('MCP authorization is required.');
  credential = await refreshIfNeeded(
    secretStore,
    serverUrl,
    input.credential,
    credential,
    signal,
  );

  const call = async (record: CredentialRecord, method: string, params: unknown) => {
    if (!record.tokens) throw new Error('MCP authorization is required.');
    return mcpRequest(serverUrl, record.tokens.accessToken, {
      method,
      params,
      sessionId: record.mcpSessionId,
      signal,
    });
  };

  try {
    return await invokeRpc(secretStore, input.credential, credential, call, input);
  } catch (error) {
    if (!isUnauthorized(error) || !credential.tokens?.refreshToken) throw error;
    const refreshed = await refreshTokens(
      secretStore,
      serverUrl,
      input.credential,
      credential,
      signal,
    );
    return invokeRpc(secretStore, input.credential, refreshed, call, input);
  }
}

async function invokeRpc(
  secretStore: SecretStore,
  credentialId: string,
  credential: CredentialRecord,
  call: (record: CredentialRecord, method: string, params: unknown) => Promise<McpResponse>,
  input: Extract<McpClientInput, { operation: 'rpc' }>,
) {
  const initialized = await ensureSession(
    secretStore,
    credentialId,
    credential,
    call,
    input.method,
  );
  const response = await call(initialized, input.method, input.params);
  await captureSession(secretStore, credentialId, initialized, response);
  return response.result;
}

async function ensureSession(
  secretStore: SecretStore,
  credentialId: string,
  credential: CredentialRecord,
  call: (record: CredentialRecord, method: string, params: unknown) => Promise<McpResponse>,
  method: string,
) {
  if (method === 'initialize' || credential.mcpSessionId || credential.initialized) {
    return credential;
  }
  const response = await call(credential, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'rgap-mcp-proxy', version: '0.0.0' },
  });
  const next = await captureSession(secretStore, credentialId, {
    ...credential,
    initialized: true,
  }, response);
  await call(next, 'notifications/initialized', {});
  return next;
}

async function captureSession(
  secretStore: SecretStore,
  credentialId: string,
  credential: CredentialRecord,
  response: McpResponse,
) {
  const next = {
    ...credential,
    mcpSessionId: response.sessionId ?? credential.mcpSessionId,
    initialized: true,
  };
  if (
    next.mcpSessionId === credential.mcpSessionId
    && next.initialized === credential.initialized
  ) return credential;
  await writeCredential(secretStore, credentialId, next);
  return next;
}

async function refreshIfNeeded(
  secretStore: SecretStore,
  serverUrl: string,
  credentialId: string,
  credential: CredentialRecord,
  signal: AbortSignal,
) {
  const expiresAt = credential.tokens?.expiresAt;
  if (!expiresAt || expiresAt > Date.now() + 30_000) return credential;
  if (!credential.tokens?.refreshToken) return credential;
  return refreshTokens(secretStore, serverUrl, credentialId, credential, signal);
}

async function refreshTokens(
  secretStore: SecretStore,
  serverUrl: string,
  credentialId: string,
  credential: CredentialRecord,
  signal: AbortSignal,
) {
  if (!credential.client || !credential.tokens?.refreshToken) {
    throw new Error('MCP authorization is required.');
  }
  const discovery = await discover(serverUrl, signal);
  const tokens = await requestToken(discovery.tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: credential.tokens.refreshToken,
    client_id: credential.client.clientId,
    client_secret: credential.client.clientSecret,
    resource: discovery.resource,
  }, signal);
  const next = { ...credential, tokens, mcpSessionId: undefined, initialized: false };
  await writeCredential(secretStore, credentialId, next);
  return next;
}

type Discovery = {
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scope?: string;
};

async function discover(serverUrl: string, signal: AbortSignal): Promise<Discovery> {
  const probe = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'rgap-mcp-proxy', version: '0.0.0' },
      },
    }),
    signal,
    redirect: 'manual',
  });
  const authenticate = probe.headers.get('www-authenticate') ?? '';
  const metadataUrl = authenticate.match(/resource_metadata="([^"]+)"/)?.[1]
    ?? `${originOf(serverUrl)}/.well-known/oauth-protected-resource`;
  await probe.arrayBuffer();

  const resourceMetadata = await getJson(metadataUrl, signal) as {
    resource?: string;
    authorization_servers?: string[];
    scopes_supported?: string[];
  };
  const issuer = resourceMetadata.authorization_servers?.[0];
  if (!issuer) throw new Error('Protected resource metadata is missing authorization servers.');
  const asMetadata = await discoverAuthorizationServer(issuer, signal);
  if (!asMetadata.code_challenge_methods_supported?.includes('S256')) {
    throw new Error('Authorization server does not support PKCE S256.');
  }
  if (!asMetadata.authorization_endpoint || !asMetadata.token_endpoint) {
    throw new Error('Authorization server metadata is missing endpoints.');
  }
  return {
    resource: resourceMetadata.resource ?? serverUrl,
    authorizationEndpoint: asMetadata.authorization_endpoint,
    tokenEndpoint: asMetadata.token_endpoint,
    registrationEndpoint: asMetadata.registration_endpoint,
    scope: resourceMetadata.scopes_supported?.join(' '),
  };
}

async function discoverAuthorizationServer(issuer: string, signal: AbortSignal) {
  const base = new URL(trimSlash(issuer));
  const path = base.pathname === '/' ? '' : base.pathname;
  const candidates = path
    ? [
      new URL(`/.well-known/oauth-authorization-server${path}`, base.origin).toString(),
      new URL(`/.well-known/openid-configuration${path}`, base.origin).toString(),
      `${trimSlash(issuer)}/.well-known/openid-configuration`,
    ]
    : [
      `${base.origin}/.well-known/oauth-authorization-server`,
      `${base.origin}/.well-known/openid-configuration`,
    ];
  for (const url of candidates) {
    const response = await fetch(url, { signal, redirect: 'manual' });
    if (!response.ok) {
      await response.arrayBuffer();
      continue;
    }
    return await response.json() as {
      authorization_endpoint?: string;
      token_endpoint?: string;
      registration_endpoint?: string;
      code_challenge_methods_supported?: string[];
    };
  }
  throw new Error('Authorization server metadata is unavailable.');
}

async function registerClient(
  discovery: Discovery,
  redirectUri: string,
  signal: AbortSignal,
) {
  if (!discovery.registrationEndpoint) {
    throw new Error('Authorization server does not support dynamic client registration.');
  }
  const response = await fetch(discovery.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'RGAP MCP proxy',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    }),
    signal,
  });
  if (!response.ok) throw new Error('Dynamic client registration failed.');
  const body = await response.json() as {
    client_id?: string;
    client_secret?: string;
  };
  if (!body.client_id) throw new Error('Dynamic client registration failed.');
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

async function requestToken(
  tokenEndpoint: string,
  fields: Record<string, string | undefined>,
  signal: AbortSignal,
) {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) body.set(name, value);
  }
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal,
  });
  const json = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!response.ok || !json.access_token) {
    throw new Error('OAuth token request failed.');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    tokenType: json.token_type ?? 'Bearer',
    expiresAt: typeof json.expires_in === 'number'
      ? Date.now() + json.expires_in * 1000
      : undefined,
    scope: json.scope,
  };
}

type McpResponse = {
  result: unknown;
  sessionId?: string;
};

async function mcpRequest(
  serverUrl: string,
  accessToken: string,
  input: {
    method: string;
    params: unknown;
    sessionId?: string;
    signal: AbortSignal;
  },
): Promise<McpResponse> {
  const id = input.method.startsWith('notifications/') ? undefined : Date.now();
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
  };
  if (input.sessionId) headers['mcp-session-id'] = input.sessionId;
  const response = await fetch(serverUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      ...(id === undefined ? {} : { id }),
      method: input.method,
      ...(input.params === undefined ? {} : { params: input.params }),
    }),
    signal: input.signal,
  });
  const sessionId = response.headers.get('mcp-session-id') ?? input.sessionId;
  if (response.status === 401) {
    await response.arrayBuffer();
    throw Object.assign(new Error('MCP authorization is required.'), { unauthorized: true });
  }
  if (id === undefined) {
    if (!response.ok) throw new Error('MCP notification failed.');
    await response.arrayBuffer();
    return { result: {}, sessionId };
  }
  if (!response.ok) throw new Error('MCP request failed.');
  const payload = await readJsonRpc(response) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (payload.error) throw new Error('MCP request failed.');
  return { result: payload.result, sessionId };
}

async function readJsonRpc(response: Response) {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/event-stream')) return response.json();
  const text = await response.text();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = JSON.parse(line.slice(5).trim()) as {
      result?: unknown;
      error?: unknown;
    };
    if ('result' in payload || 'error' in payload) return payload;
  }
  throw new Error('MCP SSE response contained no JSON-RPC result.');
}

async function readCredential(secretStore: SecretStore, credentialId: string) {
  const raw = await secretStore.get(credentialId);
  if (raw === undefined) return {};
  return CredentialSchema.parse(JSON.parse(raw));
}

async function writeCredential(
  secretStore: SecretStore,
  credentialId: string,
  credential: CredentialRecord,
) {
  await secretStore.set(credentialId, JSON.stringify(credential));
}

async function readSession(secretStore: SecretStore, state: string) {
  const raw = await secretStore.get(`oauth:session:${state}`);
  if (raw === undefined) return undefined;
  return SessionSchema.parse(JSON.parse(raw));
}

async function getJson(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, redirect: 'manual' });
  if (!response.ok) throw new Error('Discovery document is unavailable.');
  return response.json();
}

function pkceChallenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function trimSlash(url: string) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function originOf(url: string) {
  return new URL(url).origin;
}

function isUnauthorized(error: unknown) {
  return error instanceof Error && 'unauthorized' in error;
}
