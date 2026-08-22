import { tokenValue, type ResourceId, type RgapStore } from '@rgap/core';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

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

  app.use('/v1/*', async (c, next) => {
    const bearer = bearerToken(c.req.header('authorization'));
    if (!bearer) throw new HTTPException(401);

    const token = tokenValue(bearer);
    const decision = await options.store.as(token).authorize(token, options.openAiResourceId, 'invoke');
    if (!decision.allowed) throw new HTTPException(decision.grantId === null ? 401 : 403);
    await next();
  });

  app.all('/v1/*', async (c) => {
    const incoming = new URL(c.req.url);
    const upstream = new URL(`${incoming.pathname}${incoming.search}`, upstreamOrigin);
    const headers = new Headers(c.req.raw.headers);
    headers.set('authorization', `Bearer ${options.openAiApiKey}`);
    headers.delete('host');

    return upstreamFetch(upstream, {
      method: c.req.method,
      headers,
      body: c.req.raw.body,
      signal: c.req.raw.signal,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
  });

  return app;
}

function bearerToken(authorization: string | undefined) {
  return authorization?.match(/^Bearer (\S+)$/)?.[1];
}
