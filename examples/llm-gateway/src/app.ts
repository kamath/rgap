import { tokenValue, type ResourceId, type RgapStore } from '@rgap/core';
import { Hono, type Context } from 'hono';

export type LlmGatewayOptions = {
  store: RgapStore;
  openAiResourceId: ResourceId;
  openAiApiKey: string;
  upstreamOrigin?: string;
  fetch?: typeof globalThis.fetch;
};

/**
 * RGAP authorizes the employee bearer, then this trusted wrapper swaps in the OpenAI credential.
 */
export function createLlmGateway(options: LlmGatewayOptions) {
  const upstreamOrigin = new URL(options.upstreamOrigin ?? 'https://api.openai.com');
  const upstreamFetch = options.fetch ?? globalThis.fetch;
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  const proxy = async (c: Context) => {
    const bearer = bearerToken(c.req.header('authorization'));
    if (!bearer) return openAiError(c, 401, 'A valid RGAP bearer token is required.', 'invalid_api_key');

    const token = tokenValue(bearer);
    const decision = await options.store.as(token).authorize(token, options.openAiResourceId, 'invoke');
    if (!decision.allowed) {
      return openAiError(
        c,
        decision.grantId === null ? 401 : 403,
        decision.grantId === null ? 'The RGAP bearer token is unknown or inactive.' : 'This key cannot use OpenAI.',
        decision.grantId === null ? 'invalid_api_key' : 'insufficient_permissions',
      );
    }

    const incoming = new URL(c.req.url);
    const upstream = new URL(`${incoming.pathname}${incoming.search}`, upstreamOrigin);
    const headers = new Headers(c.req.raw.headers);
    headers.set('authorization', `Bearer ${options.openAiApiKey}`);
    headers.delete('host');
    const method = c.req.method.toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? undefined : c.req.raw.body;
    const init: RequestInit & { duplex?: 'half' } = {
      method,
      headers,
      body,
      signal: c.req.raw.signal,
    };
    if (body) init.duplex = 'half';

    return upstreamFetch(upstream, init);
  };

  app.all('/v1', proxy);
  app.all('/v1/*', proxy);

  return app;
}

function bearerToken(authorization: string | undefined) {
  return authorization?.match(/^Bearer (\S+)$/)?.[1];
}

function openAiError(
  c: Context,
  status: 401 | 403,
  message: string,
  code: string,
) {
  return c.json({
    error: {
      message,
      type: 'invalid_request_error',
      param: null,
      code,
    },
  }, status);
}
