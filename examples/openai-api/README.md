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

`@rgap/openai-proxy` provides the trusted runtime and mountable Hono app:

```ts
const store = new SqliteRgapStore({
  url: 'rgap.db',
  runtimes: {
    openai: createOpenAIProxyRuntime({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    }),
  },
});

const app = createOpenAIProxyApp({
  store,
  models: new Map([
    ['gpt-5.6-sol', modelResource.id],
  ]),
});
```

The host owns storage, model resource provisioning, grants, tokens, and process
lifecycle. The package owns OpenAI request validation, RGAP invocation, provider
streaming, and OpenAI-compatible responses.

Start the API:

```sh
OPENAI_API_KEY=<provider-key> \
pnpm --filter @rgap/examples openai-api
```

`apiKey` defaults to `OPENAI_API_KEY` when omitted. `baseURL` defaults to the
OpenAI API origin; set `OPENAI_BASE_URL` to target another OpenAI-compatible
provider endpoint.

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

The endpoint accepts string-content `system`, `user`, and `assistant` messages,
plus `temperature`, `max_tokens`, and `stream`. It emits OpenAI chat completion
objects or server-sent chat completion chunks ending in `[DONE]`.

`rgap.db`, `client.token`, and the automatically issued bearer are local
development conveniences. Do not deploy the generated database or token.
