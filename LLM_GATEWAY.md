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
const rgap = new SqliteRgapStore({
  url: 'rgap.db',
  runtimes: {
    // Deployment-supplied trusted runtimes; RGAP does not include these classes.
    openai: new OpenAIRuntime({
      allowedOrigins: ['https://api.openai.com'],
    }),
    anthropic: new AnthropicRuntime({
      allowedOrigins: ['https://api.anthropic.com'],
    }),
  },
  validator: jsonSchemaValidator,
  secrets: secretStore,
});
```

The RGAP core understands immutable executable revisions, input and output schemas, bindings, authorization, limits, and invocation events. A deployment-supplied runtime owns its program format, execution, cancellation, and transport-specific behavior.

## Model executable

An administrator creates the resource hierarchy and publishes an immutable executable revision with the actual resource handle API:

```ts
const llm = await admin.resources.create({ name: 'llm' });
const openai = await llm.create({ name: 'openai' });
const model = await openai.create({ name: 'gpt-5' });

const revision = await model.executable.publish({
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
    credential: { kind: 'secret', access: 'use', required: true },
  },

  program: {
    operation: 'chat.completions',
    upstreamModel: 'gpt-5',
  },

  outputSchema: null,
  limits: {
    timeoutMs: 120_000,
    outputBytes: 10_000_000,
  },
});
```

The executable does not contain the upstream API key. Its named `credential` slot accepts a protected secret resource.

## Provider secret

An administrator creates the provider service and writes its credential:

```ts
const secrets = await admin.resources.create({ name: 'secrets' });
const secretOpenai = await secrets.create({ name: 'openai' });
const providerKey = await secretOpenai.create({ name: 'company-project-key' });

await providerKey.secret.write(process.env.OPENAI_API_KEY!);

const services = await admin.resources.create({ name: 'services' });
const serviceOpenai = await services.create({ name: 'openai' });
const provider = await serviceOpenai.create({ name: 'company-project' });
```

The provider service resource is optional application metadata; it has no special RGAP kind or configuration fields. `OpenAIRuntime` is illustrative host code. The secret value is write-only through the RGAP API. Reads return its resource ID, version, and update time, and the trusted runtime receives only an opaque handle at invocation.

## Employee grant

An administrator grants an employee model invocation and use of the selected provider credential:

```ts
const alice = await admin.grants.create({
  name: 'Alice LLM access',
  capabilities: [
    {
      resourceId: model.id,
      permissions: ['invoke'],
    },
    {
      resourceId: providerKey.id,
      permissions: ['use'],
    },
  ],
  expiresAt: null,
});

const issued = await alice.tokens.create({
  label: 'alice-laptop',
});
```

The invoke and use capabilities are separate. The grant contains no executable revision, binding map, or rate-limit object; the gateway supplies bindings at invocation and enforces workforce budgets as host policy. The host associates Alice's workforce identity with the grant or issued token. RGAP bearer possession remains the protocol authority, so deployments that require stronger attribution issue short-lived tokens through workforce SSO.

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

  const resource = await rgap
    .as(token)
    .resources
    .get(resourceId);
  const events = resource.invoke({
    input: request,
    bindings: { credential: providerKey.id },
    revisionId: revision.id,
    signal: c.req.raw.signal,
  });

  return openAiResponseFromEvents(events, request.stream);
});
```

`openAiResponseFromEvents` is an illustrative gateway adapter. The generic RGAP server transports invocation events as NDJSON; this OpenAI-facing application converts those events into OpenAI-compatible JSON, errors, or SSE framing. It passes downstream cancellation to invocation so the runtime can cancel its upstream request.

## Security and operations

The gateway enforces:

- Model and operation allowlists
- Input schemas and token limits
- Gateway-owned per-grant request, concurrency, token, and cost budgets
- Provider destination and credential audience restrictions
- Maximum stream duration and output size
- Secret redaction from logs, errors, outputs, and audit details
- Grant, token, provider, and executable deletion or revision selection
- Usage accounting against the effective grant and token

Prompts, completions, and protected values are not included in RGAP invocation audit records. Audit events identify the executable resource and revision, runtime, binding resource IDs, timing, and result. Token usage and cost accounting are illustrative gateway records rather than fields in the generic RGAP audit contract.

The `OpenAIRuntime`, `AnthropicRuntime`, provider-resource configuration, OpenAI response adapter, and budget/accounting layer in this document are deployment-supplied illustrative APIs. The executable, secret, binding, authorization, invocation-event, SQLite, and NDJSON foundations are implemented by RGAP.
