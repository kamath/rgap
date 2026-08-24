import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import type { InvokeRuntime } from '@rgap/core';
import { SqliteRgapStore } from '@rgap/sqlite';

const OpenAIInputSchema = z.object({
  prompt: z.string().min(1),
});
const OpenAIOutputSchema = z.object({
  text: z.string(),
});

type OpenAIInput = z.infer<typeof OpenAIInputSchema>;
type OpenAIOutput = z.infer<typeof OpenAIOutputSchema>;

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

const store = new SqliteRgapStore({
  url: ':memory:',
  runtimes: { openai },
});

try {
  const admin = store.admin();
  const model = await admin.resources.create({
    name: 'acme/models/openai',
    executable: { runtime: 'openai' },
  });

  const agentGrant = await admin.grants.create({
    name: 'company/openai-agent',
    resources: [{ id: model.id, permissions: ['invoke'] }],
    expiresAt: null,
  });
  const agentToken = await agentGrant.tokens.create({ label: 'openai-agent' });
  const agent = store.as(agentToken.value);
  const authorizedModel = await agent.resources.get(model.id);

  for await (const event of authorizedModel.invoke({
    input: { prompt: 'Summarize why capability attenuation matters.' },
  })) {
    console.log(event);
  }
} finally {
  store.close();
}
