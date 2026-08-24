import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';

export type MockMcpOptions = {
  issuer: string;
  mcpPath: string;
};

type RegisteredClient = {
  clientId: string;
  clientSecret: string | undefined;
  redirectUris: string[];
};

type AuthorizationCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
};

type IssuedToken = {
  clientId: string;
  resource: string;
};

export function createMockMcpRoutes({ issuer, mcpPath }: MockMcpOptions) {
  const app = new Hono();
  const clients = new Map<string, RegisteredClient>();
  const codes = new Map<string, AuthorizationCode>();
  const accessTokens = new Map<string, IssuedToken>();
  const refreshTokens = new Map<string, IssuedToken>();
  const resourceMetadataUrl = `${issuer}/.well-known/oauth-protected-resource`;
  const mcpUrl = `${issuer}${mcpPath}`;

  app.get('/.well-known/oauth-protected-resource', (c) => c.json({
    resource: mcpUrl,
    authorization_servers: [issuer],
    scopes_supported: ['mcp:use'],
  }));

  app.get('/.well-known/oauth-authorization-server', (c) => c.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    response_types_supported: ['code'],
  }));

  app.post('/oauth/register', async (c) => {
    const body = await c.req.json<{
      redirect_uris?: string[];
      token_endpoint_auth_method?: string;
    }>();
    const redirectUris = body.redirect_uris ?? [];
    if (redirectUris.length === 0) {
      return c.json({ error: 'invalid_client_metadata' }, 400);
    }
    const clientId = `client_${randomBytes(8).toString('hex')}`;
    const confidential = body.token_endpoint_auth_method !== 'none';
    const clientSecret = confidential ? randomBytes(16).toString('hex') : undefined;
    clients.set(clientId, { clientId, clientSecret, redirectUris });
    return c.json({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: confidential ? 'client_secret_post' : 'none',
    }, 201);
  });

  app.get('/oauth/authorize', (c) => {
    const clientId = c.req.query('client_id') ?? '';
    const redirectUri = c.req.query('redirect_uri') ?? '';
    const challenge = c.req.query('code_challenge') ?? '';
    const method = c.req.query('code_challenge_method') ?? '';
    const state = c.req.query('state') ?? '';
    const resource = c.req.query('resource') ?? '';
    const client = clients.get(clientId);
    if (!client || !client.redirectUris.includes(redirectUri)) {
      return c.text('Unknown client or redirect URI.', 400);
    }
    if (method !== 'S256' || challenge.length === 0 || resource.length === 0) {
      return c.text('PKCE S256 and resource are required.', 400);
    }
    const code = randomBytes(16).toString('hex');
    codes.set(code, {
      clientId,
      redirectUri,
      codeChallenge: challenge,
      resource,
    });
    const next = new URL(redirectUri);
    next.searchParams.set('code', code);
    next.searchParams.set('state', state);
    return c.redirect(next.toString());
  });

  app.post('/oauth/token', async (c) => {
    const form = await c.req.parseBody();
    const grantType = asString(form.grant_type);
    const clientId = asString(form.client_id);
    const clientSecret = asString(form.client_secret);
    const client = clients.get(clientId);
    if (!client) return c.json({ error: 'invalid_client' }, 401);
    if (client.clientSecret && client.clientSecret !== clientSecret) {
      return c.json({ error: 'invalid_client' }, 401);
    }

    if (grantType === 'authorization_code') {
      const code = asString(form.code);
      const redirectUri = asString(form.redirect_uri);
      const verifier = asString(form.code_verifier);
      const issued = codes.get(code);
      codes.delete(code);
      if (!issued || issued.clientId !== clientId || issued.redirectUri !== redirectUri) {
        return c.json({ error: 'invalid_grant' }, 400);
      }
      if (pkceChallenge(verifier) !== issued.codeChallenge) {
        return c.json({ error: 'invalid_grant' }, 400);
      }
      return c.json(issueTokens(accessTokens, refreshTokens, issued));
    }

    if (grantType === 'refresh_token') {
      const refresh = asString(form.refresh_token);
      const issued = refreshTokens.get(refresh);
      if (!issued || issued.clientId !== clientId) {
        return c.json({ error: 'invalid_grant' }, 400);
      }
      refreshTokens.delete(refresh);
      return c.json(issueTokens(accessTokens, refreshTokens, issued));
    }

    return c.json({ error: 'unsupported_grant_type' }, 400);
  });

  app.all(mcpPath, async (c) => {
    const authorization = c.req.header('authorization');
    const token = authorization?.match(/^Bearer (\S+)$/)?.[1];
    const issued = token ? accessTokens.get(token) : undefined;
    if (!issued || issued.resource !== mcpUrl) {
      c.header(
        'WWW-Authenticate',
        `Bearer resource_metadata="${resourceMetadataUrl}", scope="mcp:use"`,
      );
      return c.json({ error: 'invalid_token' }, 401);
    }
    if (c.req.method !== 'POST') return c.body(null, 405);

    const message = await c.req.json<{
      id?: string | number | null;
      method?: string;
      params?: Record<string, unknown>;
    }>();
    const result = mcpResult(message.method, message.params);
    if (result === undefined) {
      return c.json(jsonRpcError(message.id, -32601, 'Method not found.'));
    }
    if (message.id === undefined || message.id === null) return c.body(null, 202);
    return c.json({ jsonrpc: '2.0', id: message.id, result });
  });

  return app;
}

function mcpResult(method: string | undefined, params: Record<string, unknown> | undefined) {
  if (method === 'initialize') {
    return {
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'rgap-mock-mcp', version: '0.0.0' },
    };
  }
  if (method === 'notifications/initialized' || method === 'ping') return {};
  if (method === 'tools/list') {
    return {
      tools: [{
        name: 'echo',
        description: 'Echo the provided text.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      }],
    };
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments;
    if (name !== 'echo' || args === null || typeof args !== 'object' || Array.isArray(args)) {
      return { content: [{ type: 'text', text: 'Unknown tool.' }], isError: true };
    }
    const text = 'text' in args ? String(args.text) : '';
    return { content: [{ type: 'text', text }], isError: false };
  }
  return undefined;
}

function issueTokens(
  accessTokens: Map<string, IssuedToken>,
  refreshTokens: Map<string, IssuedToken>,
  issued: IssuedToken,
) {
  const accessToken = randomBytes(16).toString('hex');
  const refreshToken = randomBytes(16).toString('hex');
  accessTokens.set(accessToken, issued);
  refreshTokens.set(refreshToken, issued);
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'mcp:use',
  };
}

function pkceChallenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function jsonRpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
