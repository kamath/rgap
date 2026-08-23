# RGAP

RGAP provides hierarchical capability access for resources, tools, and
agent-accessible services. Resources form a mutable tree, grants form an
attenuated delegation tree, and opaque tokens select the grant lineage used by
each authorization decision.

## Deployment-owned runtimes

Executable resources resolve to deployment-owned runtimes. A runtime keeps
provider credentials inside trusted application code while an agent receives
only an RGAP token.

An OpenAI runtime reads `OPENAI_API_KEY` when it invokes the Responses API:

```ts
const openai: InvokeRuntime<OpenAIInput, OpenAIOutput> = {
  inputSchema: OpenAIInputSchema,
  outputSchema: OpenAIOutputSchema,
  async invoke({ input, signal }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is required.');

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
        input: input.prompt,
      }),
      signal,
    });

    // Parse and return the provider response.
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
