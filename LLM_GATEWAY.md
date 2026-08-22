# Internal LLM Gateway

An internal LLM gateway exposes an OpenAI-compatible endpoint while RGAP controls which models each employee may invoke. Employees receive RGAP bearer tokens rather than upstream provider credentials.

## Client configuration

An employee configures any OpenAI-compatible harness with the company gateway URL and their RGAP token:

```bash
export OPENAI_BASE_URL="https://llm.company.com/v1"
export OPENAI_API_KEY="rgap_employee_token"
```

The harness then makes an ordinary OpenAI request:

```bash
curl "$OPENAI_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "messages": [
      { "role": "user", "content": "Explain this stack trace" }
    ],
    "stream": true
  }'
```

## Request flow

```text
Employee harness
  -> OpenAI-compatible gateway
  -> authenticate the RGAP bearer
  -> resolve the requested model resource
  -> authorize invoke through the complete grant lineage
  -> enforce request and usage constraints
  -> invoke the model resource with its provider binding
  -> proxy the JSON response or SSE stream
```

The employee token identifies an RGAP grant. The protected OpenAI, Anthropic, or other provider credential remains behind the gateway.

## Resources

Providers and models use the ordinary resource hierarchy:

```text
llm/
├── openai/
│   ├── gpt-5
│   └── embeddings
└── anthropic/
    └── sonnet

services/
└── openai/
    └── company-project

secrets/
└── openai/
    └── company-project-key
```

`llm/openai/gpt-5` is an executable resource. `services/openai/company-project` is a provider service resource, and its credential is a protected secret resource.

## Runtime configuration

The deployment registers each trusted runtime once:

```ts
const rgap = createRgap({
  store: sqliteStore('rgap.db'),
  runtimes: {
    openai: new OpenAIRuntime({
      allowedOrigins: ['https://api.openai.com'],
    }),
    anthropic: new AnthropicRuntime({
      allowedOrigins: ['https://api.anthropic.com'],
    }),
  },
});
```

The RGAP core understands executable versions, input and output schemas, bindings, authorization, limits, and invocation events. A runtime owns its program format, execution, cancellation, and transport-specific behavior.

## Model executable

An administrator publishes an immutable executable version:

```ts
const model = await admin.executables.create({
  path: 'llm/openai/gpt-5',
  runtime: 'openai',

  inputSchema: {
    type: 'object',
    required: ['messages'],
    properties: {
      messages: { type: 'array' },
      stream: { type: 'boolean' },
      max_tokens: { type: 'integer', maximum: 16_000 },
    },
  },

  bindingSchema: {
    provider: { kind: 'service', required: true },
  },

  program: {
    operation: 'chat.completions',
    upstreamModel: 'gpt-5',
    provider: { $binding: 'provider' },
  },
});
```

The executable does not contain the upstream API key. Its named `provider` slot accepts a compatible service resource.

## Provider secret

An administrator creates the provider service and writes its credential:

```ts
const providerKey = await admin.resources.create({
  path: 'secrets/openai/company-project-key',
  kind: 'secret',
});

await admin.secrets.write(providerKey.id, {
  value: process.env.OPENAI_API_KEY!,
});

const provider = await admin.resources.create({
  path: 'services/openai/company-project',
  kind: 'openai-service',
  config: {
    origin: 'https://api.openai.com',
    credential: providerKey.id,
  },
});
```

The secret value is write-only through the RGAP API. Reads return metadata such as its resource ID, version, and update time. A trusted runtime may materialize the value only while exercising the service resource.

## Employee grant

An administrator grants an employee model invocation and use of the selected provider service:

```ts
const alice = await admin.grants.create({
  name: 'Alice LLM access',
  capabilities: [
    {
      resourceId: model.id,
      permissions: ['invoke'],
      executableVersion: model.version,
      bindings: {
        provider: provider.id,
      },
      constraints: {
        requestsPerMinute: 60,
        monthlyTokens: 2_000_000,
        maxTokensPerRequest: 16_000,
      },
    },
    {
      resourceId: provider.id,
      permissions: ['use'],
    },
  ],
  expiresAt: null,
});

const issued = await alice.tokens.create({
  label: 'alice-laptop',
});
```

The host associates Alice's workforce identity with the grant or issued token. RGAP bearer possession remains the protocol authority, so deployments that require stronger attribution issue short-lived tokens through workforce SSO.

## Gateway route

The gateway translates the OpenAI-compatible route into a generic RGAP invocation:

```ts
app.post('/v1/chat/completions', async (c) => {
  const token = bearerToken(c.req.header('authorization'));
  const request = await c.req.json();
  const resourceId = requireResourceId(
    await rgap.admin().resources.list(),
    `llm/openai/${request.model}`,
  );

  const invocation = await rgap
    .as(token)
    .resources
    .get(resourceId)
    .invoke(request);

  return invocation.toResponse();
});
```

The response adapter preserves OpenAI-compatible JSON, errors, and SSE framing. The invocation remains authorized for a bounded duration, and cancellation of the downstream request cancels the upstream provider request.

## Security and operations

The gateway enforces:

- Model and operation allowlists
- Input schemas and token limits
- Per-grant request, concurrency, token, and cost budgets
- Provider destination and credential audience restrictions
- Maximum stream duration and output size
- Secret redaction from logs, errors, outputs, and audit details
- Grant, token, provider, and executable-version revocation
- Usage accounting against the effective grant and token

Prompts and completions are not included in audit records by default. Audit events identify the grant lineage, executable version, provider resource, decision, token usage, latency, and result status.
