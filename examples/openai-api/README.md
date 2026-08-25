# Gated OpenAI-compatible API

This example exposes `POST /v1/chat/completions` while RGAP decides which
provider models each bearer can invoke. The gateway keeps `OPENAI_API_KEY` in
deployment configuration and seals the provider model into each executable
resource:

```text
models/
└── openai/
    ├── gpt-5.6-sol
    └── gpt-5.6-luna
```

The request's `model` selects a resource from this deployment-owned catalog.
It does not become provider input. The executable definition supplies the
provider model only after RGAP validates the bearer and its `invoke` grant.

The host defines its runtime directly with `fetch`:

```ts
const providerApiKey = process.env.OPENAI_API_KEY;
const providerBaseURL = new URL(
  process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
);

const openaiRuntime = {
  inputSchema: OpenAIInputSchema,
  outputSchema: z.unknown(),
  async invoke({ input, signal }) {
    const body = { ...input.body, model: input.model };
    const response = await fetch(new URL(input.endpoint, providerBaseURL), {
      method: input.method,
      headers: {
        ...input.headers,
        'content-type': 'application/json',
        authorization: `Bearer ${providerApiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    return input.body.stream === true ? jsonSse(response) : response.json();
  },
} satisfies InvokeRuntime<OpenAIInput, unknown>;

const store = new SqliteRgapStore({
  url: 'rgap.db',
  runtimes: { openai: openaiRuntime },
});
```

Each model resource seals `method`, `endpoint`, `headers`, and `model`. The route
forwards every other request body field unchanged, and the runtime applies the
sealed model after the caller's body. Callers therefore cannot redirect the
provider request, replace deployment-controlled headers, change its method, or
use authority for one model to call another.

The Hono route and resource share one operation descriptor:

```ts
const chatCompletions = {
  method: 'POST',
  endpoint: '/v1/chat/completions',
} as const;

const model = await admin.resources.create({
  name: 'models/openai/gpt-5.6-sol',
  executable: {
    runtime: 'openai',
    input: {
      ...chatCompletions,
      headers: {},
      model: 'gpt-5.6-sol',
    },
  },
});

app.on(chatCompletions.method, chatCompletions.endpoint, handler);
```

Add another descriptor, resource map, and route for operations such as
`POST /v1/images/generations`.

Start the API:

```sh
OPENAI_API_KEY=<provider-key> \
pnpm --filter @rgap/examples openai-api
```

The runtime reads `OPENAI_API_KEY` and uses `OPENAI_BASE_URL` as the provider
origin. The base URL defaults to `https://api.openai.com`; each resource supplies
the endpoint path beneath that origin.

The example writes a local RGAP bearer to `client.token`. By default, that
bearer can invoke `gpt-5.6-sol`, while `gpt-5.6-luna` remains outside its grant.
Configure the catalog and grant with comma-separated model names:

```sh
OPENAI_API_KEY=<provider-key> \
OPENAI_MODELS=gpt-5.6-sol,gpt-5.6-luna \
GRANTED_OPENAI_MODELS=gpt-5.6-sol \
pnpm --filter @rgap/examples openai-api
```

Call the streaming endpoint with an OpenAI client or `curl`:

```sh
TOKEN=$(<examples/openai-api/client.token)

curl --no-buffer http://localhost:3004/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "model": "gpt-5.6-sol",
    "messages": [
      {"role": "user", "content": "Explain capability attenuation briefly."}
    ],
    "stream": true
  }'
```

For the official OpenAI JavaScript client, set `baseURL` to
`http://localhost:3004/v1` and use the RGAP bearer as `apiKey`.

The endpoint forwards the OpenAI request body without enumerating its fields. It
emits the provider's chat completion object or server-sent completion chunks
ending in `[DONE]`.

`rgap.db`, `client.token`, and the automatically issued bearer are local
development conveniences. Do not deploy the generated database or token.
