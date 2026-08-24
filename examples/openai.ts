import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import type { InvokeRuntime } from '@rgap/core';
import { SqliteRgapStore } from '@rgap/sqlite';

const OpenAIInputSchema = z.object({
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
    const { text } = await generateText({
      model: openai(input.model),
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
    name: 'openai/gpt-5.6-sol',
    executable: {
      runtime: 'openai',
      input: {
        model: 'gpt-5.6-sol',
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
