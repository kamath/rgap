import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import type { InvokeRuntime } from '@rgap/core';
import { SqliteRgapStore } from '@rgap/sqlite';

const OpenAIInputSchema = z.object({
  apiKey: z.string(),
  model: z.string(),
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
    const apiKey = apiKeys.get(input.apiKey);
    if (!apiKey) throw new Error('OPENAI_API_KEY is required.');
    const model = modelNames.get(input.model);
    if (!model) throw new Error('OpenAI model is unavailable.');

    const provider = createOpenAI({ apiKey });
    const { text } = await generateText({
      model: provider(model),
      prompt: input.prompt,
      abortSignal: signal,
    });
    return { text };
  },
};

const apiKeys = new Map<string, string>();
const modelNames = new Map<string, string>();
const store = new SqliteRgapStore({
  url: ':memory:',
  runtimes: { openai },
});

try {
  const admin = store.admin();
  const apiKey = await admin.resources.create({ name: 'secrets/openai/api-key' });
  apiKeys.set(apiKey.id, process.env.OPENAI_API_KEY ?? '');
  const modelName = await admin.resources.create({
    name: 'models/openai/gpt-5.6-sol',
  });
  modelNames.set(modelName.id, 'gpt-5.6-sol');

  const model = await admin.resources.create({
    name: 'openai/gpt-5.6-sol',
    executable: {
      runtime: 'openai',
      bind: {
        apiKey: apiKey.id,
        model: modelName.id,
      },
    },
  });

  const agentGrant = await admin.grants.create({
    name: 'company/platform-team/employee',
    resources: [{ id: model.id, permissions: ['invoke'] }],
    expiresAt: null,
  });
  const employeeToken = await agentGrant.tokens.create({ label: 'employee' });
  const employee = store.as(employeeToken.value);
  const authorizedModel = await employee.resources.get(model.id);

  for await (const event of authorizedModel.invoke({
    input: { prompt: 'Summarize why capability attenuation matters.' },
  })) {
    console.log(event);
  }
} finally {
  store.close();
}
