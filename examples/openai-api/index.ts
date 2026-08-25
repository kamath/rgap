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
import { z } from 'zod';

const directory = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT ?? 3004);
const providerModels = commaSeparated(
  process.env.OPENAI_MODELS ?? 'gpt-5.6-sol,gpt-5.6-luna',
);
const chatCompletions = {
  method: 'POST',
  endpoint: '/v1/chat/completions',
} as const;
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
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  endpoint: z.string().startsWith('/'),
  headers: z.record(z.string(), z.string()),
  model: z.string().min(1),
  body: z.record(z.string(), z.unknown()),
});
const ChatRequestSchema = z.object({
  model: z.string().min(1),
}).catchall(z.unknown());

type OpenAIInput = z.infer<typeof OpenAIInputSchema>;

const providerApiKey = process.env.OPENAI_API_KEY;
if (!providerApiKey) throw new Error('OPENAI_API_KEY is required.');
const providerBaseURL = new URL(
  process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
);
const openaiRuntime: InvokeRuntime<OpenAIInput, unknown> = {
  inputSchema: OpenAIInputSchema,
  outputSchema: z.unknown(),
  async invoke({ input, signal }) {
    const stream = input.body.stream === true;
    const body = { ...input.body, model: input.model };
    const response = await fetch(new URL(input.endpoint, providerBaseURL), {
      method: input.method,
      headers: {
        ...input.headers,
        'content-type': 'application/json',
        authorization: `Bearer ${providerApiKey}`,
      },
      body: input.method === 'GET' ? undefined : JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Provider request failed with status ${response.status}.`);
    }
    return stream ? jsonSse(response) : response.json();
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
        ...chatCompletions,
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

app.on(chatCompletions.method, chatCompletions.endpoint, async (context) => {
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
    return new Response(JSON.stringify(response), {
      headers: { 'content-type': 'application/json' },
    });
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
  console.log(`Access grant: ${application.id}`);
  for (const [name, model] of models) {
    console.log(`Model resource ${name}: ${model.id}`);
  }
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

async function* jsonSse(response: Response): AsyncIterable<unknown> {
  if (!response.body) throw new Error('Provider stream has no body.');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value.replaceAll('\r\n', '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        if (data === '[DONE]') return;
        yield JSON.parse(data);
      }
    }
  } finally {
    await reader.cancel();
  }
}

function close() {
  server.close(() => store.close());
}

process.once('SIGINT', close);
process.once('SIGTERM', close);
