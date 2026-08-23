# RGAP

RGAP provides hierarchical capability access for resources, tools, and
agent-accessible services. Resources form a mutable tree, grants form an
attenuated delegation tree, and opaque tokens select the grant lineage used by
each authorization decision.

## Deployment-owned runtimes

Executable resources resolve to deployment-owned runtimes. A runtime keeps
provider credentials inside trusted application code while an agent receives
only an RGAP token.

An OpenAI runtime reads `OPENAI_API_KEY` and uses AI SDK `generateText` with
the OpenAI provider:

```ts
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';

const openai: InvokeRuntime<OpenAIInput, OpenAIOutput> = {
  inputSchema: OpenAIInputSchema,
  outputSchema: OpenAIOutputSchema,
  async invoke({ input, signal }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is required.');

    const provider = createOpenAI({ apiKey });
    const { text } = await generateText({
      model: provider(process.env.OPENAI_MODEL ?? 'gpt-5-mini'),
      prompt: input.prompt,
      abortSignal: signal,
    });
    return { text };
  },
};
```

The runtime is registered on the store and associated with a resource. An
authorized resource handle invokes it without receiving the OpenAI API key:

```ts
await model.executable.set({ runtime: 'openai' });

for await (const event of authorizedModel.invoke({
  input: { prompt: 'Summarize the design notes.' },
})) {
  console.log(event);
}
```

See `examples/openai.ts` for the complete executable example and
`apps/docs/content/docs` for the protocol and integration guides.

## Invoke over HTTP

An HTTP client creates the resource and grant, issues an RGAP token, and invokes
the resource without defining the OpenAI runtime. The server owns that runtime
and `OPENAI_API_KEY`.

The invoke route returns NDJSON events. A caller that does not need incremental
delivery reads the complete HTTP response and parses it once:

```ts
const response = await fetch(`${baseUrl}/resources/${model.id}/invoke`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${agentToken}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    input: { prompt: 'Summarize the design notes.' },
  }),
});

const events = (await response.text())
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
```

This is a regular HTTP request that waits for one complete response body. It
does not use server-sent events.
