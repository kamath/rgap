import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createOpenAI } from '@ai-sdk/openai';
import { serve } from '@hono/node-server';
import { RgapError, type InvokeRuntime, type ResourceHandle } from '@rgap/core';
import { SqliteRgapStore } from '@rgap/store-sqlite';
import { streamText, type ModelMessage } from 'ai';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
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

const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});
const RuntimeInputSchema = z.object({
  model: z.string().min(1),
  messages: z.array(MessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().max(32_768).optional(),
});
const ChatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(MessageSchema).min(1),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(32_768).optional(),
});

type RuntimeInput = z.infer<typeof RuntimeInputSchema>;
type ChatRequest = z.infer<typeof ChatRequestSchema>;

const openai = createOpenAI();
const openaiRuntime: InvokeRuntime<RuntimeInput, string> = {
  inputSchema: RuntimeInputSchema,
  outputSchema: z.string(),
  async *invoke({ input, signal }) {
    const result = streamText({
      model: openai(input.model),
      messages: input.messages as ModelMessage[],
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      abortSignal: signal,
    });
    for await (const delta of result.textStream) yield delta;
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
      input: { model: modelName },
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

  const model = models.get(parsed.data.model);
  if (!model) {
    return openAIError(
      context,
      404,
      `The model '${parsed.data.model}' does not exist.`,
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
        `The bearer cannot invoke model '${parsed.data.model}'.`,
        'permission_denied',
      );
    }

    const input = runtimeInput(parsed.data);
    const invocation = repository.invoke(model.id, {
      input,
      signal: context.req.raw.signal,
    });
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    if (parsed.data.stream) {
      return streamSSE(context, async (stream) => {
        await stream.writeSSE({
          data: JSON.stringify(completionChunk(id, created, parsed.data.model, {
            role: 'assistant',
            content: '',
          }, null)),
        });
        for await (const event of invocation) {
          if (event.type !== 'data') continue;
          await stream.writeSSE({
            data: JSON.stringify(completionChunk(
              id,
              created,
              parsed.data.model,
              { content: String(event.value) },
              null,
            )),
          });
        }
        await stream.writeSSE({
          data: JSON.stringify(completionChunk(id, created, parsed.data.model, {}, 'stop')),
        });
        await stream.writeSSE({ data: '[DONE]' });
      });
    }

    let content = '';
    for await (const event of invocation) {
      if (event.type === 'data') content += String(event.value);
    }
    return context.json({
      id,
      object: 'chat.completion',
      created,
      model: parsed.data.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
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
  console.log(`Granted models: ${[...grantedModels].join(', ')}`);
});

function runtimeInput(request: ChatRequest): Omit<RuntimeInput, 'model'> {
  return {
    messages: request.messages,
    temperature: request.temperature,
    maxOutputTokens: request.max_tokens,
  };
}

function completionChunk(
  id: string,
  created: number,
  model: string,
  delta: { role?: 'assistant'; content?: string },
  finishReason: 'stop' | null,
) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function bearerFrom(context: Context) {
  const match = /^Bearer\s+(.+)$/i.exec(context.req.header('authorization') ?? '');
  return match?.[1];
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

function commaSeparated(value: string) {
  return [...new Set(value.split(',').map((part) => part.trim()).filter(Boolean))];
}

function close() {
  server.close(() => store.close());
}

process.once('SIGINT', close);
process.once('SIGTERM', close);
