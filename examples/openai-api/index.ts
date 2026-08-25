import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import {
  RgapError,
  tokenValue,
  type InvokeRuntime,
  type JsonValue,
  type ResourceHandle,
} from '@rgap/core';
import { SqliteRgapStore } from '@rgap/store-sqlite';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import OpenAI from 'openai';
import type { Stream } from 'openai/streaming';
import { z } from 'zod';

const directory = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT ?? 3004);
const providerModels = commaSeparated(
  process.env.OPENAI_MODELS ?? 'gpt-5.6-sol,gpt-5.6-luna',
);
const grantedModels = new Set(commaSeparated(
  process.env.GRANTED_OPENAI_MODELS ?? providerModels[0]!,
));

if (!providerModels.length) throw new Error('OPENAI_MODELS must contain at least one model.');
for (const model of grantedModels) {
  if (!providerModels.includes(model)) {
    throw new Error(`Granted model ${model} is not present in OPENAI_MODELS.`);
  }
}

const OpenAIInputSchema = z.object({
  url: z.string().startsWith('/'),
  headers: z.record(z.string(), z.string()),
  model: z.string().min(1),
  body: z.record(z.string(), z.unknown()),
});
const ChatRequestSchema = z.object({
  model: z.string().min(1),
}).catchall(z.unknown());

type OpenAIInput = z.infer<typeof OpenAIInputSchema>;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});
const openaiRuntime: InvokeRuntime<OpenAIInput, unknown> = {
  inputSchema: OpenAIInputSchema,
  outputSchema: z.unknown(),
  async invoke({ input, signal }) {
    const stream = input.body.stream === true;
    const body = { ...input.body, model: input.model };
    if (stream) {
      return openai.post<Stream<unknown>>(input.url, {
        headers: input.headers,
        body,
        stream: true,
        signal,
      });
    }
    return openai.post<unknown>(input.url, {
      headers: input.headers,
      body,
      signal,
    });
  },
};

const store = new SqliteRgapStore({
  url: `${directory}/rgap.db`,
  runtimes: { openai: openaiRuntime },
});
const admin = store.admin();
await admin.reset();

const models = new Map<string, ResourceHandle>();
for (const modelName of providerModels) {
  const resource = await admin.resources.create({
    name: `models/openai/${modelName}`,
    executable: {
      runtime: 'openai',
      input: {
        url: '/chat/completions',
        headers: {},
        model: modelName,
      },
    },
  });
  models.set(modelName, resource);
}

const application = await admin.grants.create({
  name: 'company/product/openai-api-example',
  bindings: [...grantedModels].map((modelName) => ({
    id: models.get(modelName)!.id,
    permissions: ['invoke'] as const,
  })),
  expiresAt: null,
});
const bearer = await application.tokens.create({ label: 'local-client' });
const tokenPath = `${directory}/client.token`;
writeFileSync(tokenPath, bearer.value, { mode: 0o600 });

const app = new Hono();

app.post('/v1/chat/completions', async (context) => {
  const token = bearerFrom(context);
  if (!token) return openAIError(context, 401, 'A bearer token is required.', 'invalid_api_key');

  const parsed = ChatRequestSchema.safeParse(await context.req.json().catch(() => undefined));
  if (!parsed.success) {
    return openAIError(context, 400, z.prettifyError(parsed.error), 'invalid_request_error');
  }

  const { model: modelName, ...body } = parsed.data;
  const model = models.get(modelName);
  if (!model) {
    return openAIError(
      context,
      404,
      `The model '${modelName}' does not exist.`,
      'model_not_found',
    );
  }

  try {
    const repository = store.as(token);
    await repository.resources.get(model.id);
    const decision = await repository.authorize(token, model.id, 'invoke');
    if (!decision.allowed) {
      return openAIError(
        context,
        403,
        `The bearer cannot invoke model '${modelName}'.`,
        'permission_denied',
      );
    }

    const invocation = repository.invoke(model.id, {
      input: { body },
      signal: context.req.raw.signal,
    });
    if (body.stream === true) {
      return streamSSE(context, async (stream) => {
        for await (const event of invocation) {
          if (event.type === 'data') {
            await stream.writeSSE({ data: JSON.stringify(event.value) });
          }
        }
        await stream.writeSSE({ data: '[DONE]' });
      });
    }

    let response: JsonValue | undefined;
    for await (const event of invocation) {
      if (event.type === 'data') response = event.value as JsonValue;
    }
    if (response === undefined) {
      return openAIError(context, 500, 'The provider returned no response.', 'server_error');
    }
    return context.json(response);
  } catch (error) {
    if (error instanceof RgapError && error.code === 'invalid_bearer') {
      return openAIError(context, 401, error.message, 'invalid_api_key');
    }
    if (error instanceof RgapError && error.code === 'unauthorized') {
      return openAIError(context, 403, error.message, 'permission_denied');
    }
    console.error(error);
    return openAIError(context, 500, 'The model request failed.', 'server_error');
  }
});

const server = serve({ fetch: app.fetch, port }, ({ port: listeningPort }) => {
  console.log(`OpenAI-compatible API listening on http://localhost:${listeningPort}/v1`);
  console.log(`RGAP bearer written to ${tokenPath}`);
  console.log(`Granted models: ${[...grantedModels].join(', ')}`);
});

function commaSeparated(value: string) {
  return [...new Set(value.split(',').map((part) => part.trim()).filter(Boolean))];
}

function bearerFrom(context: Context) {
  const match = /^Bearer\s+(.+)$/i.exec(context.req.header('authorization') ?? '');
  return match?.[1] ? tokenValue(match[1]) : undefined;
}

function openAIError(
  context: Context,
  status: 400 | 401 | 403 | 404 | 500,
  message: string,
  code: string,
) {
  return context.json({
    error: {
      message,
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      param: null,
      code,
    },
  }, status);
}

function close() {
  server.close(() => store.close());
}

process.once('SIGINT', close);
process.once('SIGTERM', close);
