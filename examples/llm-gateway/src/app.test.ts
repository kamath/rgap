import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteRgapStore } from '@rgap/sqlite';
import { createLlmGateway } from './app';

const stores: SqliteRgapStore[] = [];

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});

async function fixture(upstream: typeof fetch) {
  const store = new SqliteRgapStore();
  stores.push(store);
  const admin = store.admin();
  const llm = await admin.resources.create({ name: 'llm' });
  const openai = await llm.create({ name: 'openai' });
  const allowedGrant = await admin.grants.create({
    name: 'allowed',
    capabilities: [{ resourceId: openai.id, permissions: ['invoke'] }],
    expiresAt: null,
  });
  const deniedGrant = await admin.grants.create({
    name: 'denied',
    capabilities: [{ resourceId: openai.id, permissions: ['read'] }],
    expiresAt: null,
  });
  const allowed = await allowedGrant.tokens.create({ label: 'allowed' });
  const denied = await deniedGrant.tokens.create({ label: 'denied' });
  return {
    app: createLlmGateway({
      store,
      openAiResourceId: openai.id,
      openAiApiKey: 'upstream-secret',
      upstreamOrigin: 'https://openai.test',
      fetch: upstream,
    }),
    allowed: allowed.value,
    denied: denied.value,
  };
}

const authorization = (value: string) => ({ authorization: `Bearer ${value}` });

describe('OpenAI-compatible LLM gateway', () => {
  it('exposes health and distinguishes missing, invalid, and insufficient RGAP keys', async () => {
    const upstream = vi.fn<typeof fetch>();
    const { app, denied } = await fixture(upstream);

    expect(await (await app.request('/health')).json()).toEqual({ ok: true });
    expect((await app.request('/v1/models')).status).toBe(401);
    expect((await app.request('/v1/models', {
      headers: authorization('rgap_unknown'),
    })).status).toBe(401);
    const forbidden = await app.request('/v1/models', { headers: authorization(denied) });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      error: { code: 'insufficient_permissions' },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('forwards arbitrary paths, queries, headers, and JSON bodies with the upstream key', async () => {
    let request: Request | undefined;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ id: 'resp_123' }), {
        status: 201,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'openai-request',
          connection: 'keep-alive',
          'content-length': '999',
          'content-encoding': 'gzip',
        },
      });
    });
    const { app, allowed } = await fixture(upstream);
    const response = await app.request('/v1/responses?include=usage', {
      method: 'POST',
      headers: {
        ...authorization(allowed),
        'content-type': 'application/json',
        'openai-organization': 'org_example',
        'x-client-header': 'preserved',
      },
      body: JSON.stringify({ model: 'gpt-5', input: 'hello' }),
    });

    expect(request?.url).toBe('https://openai.test/v1/responses?include=usage');
    expect(request?.method).toBe('POST');
    expect(request?.headers.get('authorization')).toBe('Bearer upstream-secret');
    expect(request?.headers.get('openai-organization')).toBe('org_example');
    expect(request?.headers.get('x-client-header')).toBe('preserved');
    expect(await request?.json()).toEqual({ model: 'gpt-5', input: 'hello' });

    expect(response.status).toBe(201);
    expect(response.headers.get('x-request-id')).toBe('openai-request');
    expect(response.headers.get('connection')).toBe('keep-alive');
    expect(response.headers.get('content-length')).toBe('999');
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(await response.json()).toEqual({ id: 'resp_123' });
  });

  it('passes multipart uploads and binary downloads without JSON translation', async () => {
    let uploaded: FormData | undefined;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'POST') {
        uploaded = await request.formData();
        return new Response(JSON.stringify({ id: 'file_123' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(new Uint8Array([0, 1, 2, 255]), {
        headers: { 'content-type': 'application/octet-stream' },
      });
    });
    const { app, allowed } = await fixture(upstream);
    const form = new FormData();
    form.set('purpose', 'assistants');
    form.set('file', new Blob(['training data'], { type: 'text/plain' }), 'data.txt');
    const upload = await app.request('/v1/files', {
      method: 'POST',
      headers: authorization(allowed),
      body: form,
    });

    expect(upload.status).toBe(200);
    expect(uploaded?.get('purpose')).toBe('assistants');
    expect(await (uploaded?.get('file') as File).text()).toBe('training data');

    const download = await app.request('/v1/files/file_123/content', {
      headers: authorization(allowed),
    });
    expect(download.headers.get('content-type')).toBe('application/octet-stream');
    expect([...new Uint8Array(await download.arrayBuffer())]).toEqual([0, 1, 2, 255]);
  });

  it('streams SSE and preserves upstream API errors', async () => {
    const encoder = new TextEncoder();
    const upstream = vi.fn<typeof fetch>(async (input) => {
      if (new URL(input.toString()).pathname.endsWith('/rate-limit')) {
        return new Response(JSON.stringify({ error: { message: 'slow down' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '2' },
        });
      }
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta"}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    });
    const { app, allowed } = await fixture(upstream);

    const stream = await app.request('/v1/responses', { headers: authorization(allowed) });
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    expect(await stream.text()).toBe('data: {"type":"response.output_text.delta"}\n\ndata: [DONE]\n\n');

    const limited = await app.request('/v1/rate-limit', { headers: authorization(allowed) });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('2');
    expect(await limited.json()).toEqual({ error: { message: 'slow down' } });
  });

  it('propagates downstream cancellation to the upstream request', async () => {
    let upstreamSignal: AbortSignal | null | undefined;
    const upstream = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      upstreamSignal = init?.signal;
      if (upstreamSignal?.aborted) {
        reject(upstreamSignal.reason);
        return;
      }
      upstreamSignal?.addEventListener('abort', () => reject(upstreamSignal?.reason), { once: true });
    }));
    const { app, allowed } = await fixture(upstream);
    const controller = new AbortController();
    const pending = app.request(new Request('http://localhost/v1/responses', {
      headers: authorization(allowed),
      signal: controller.signal,
    }));

    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    controller.abort(new DOMException('client disconnected', 'AbortError'));
    await pending;
    expect(upstreamSignal?.aborted).toBe(true);
  });
});
