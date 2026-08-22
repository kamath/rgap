import { resourceId } from '@rgap/core';
import OpenAI from 'openai';
import { requiredEnvironment, store } from './config';

const employee = process.env.EMPLOYEE_NAME?.trim() || 'employee';

try {
  const grant = await store.admin().grants.create({
    name: `${employee} OpenAI gateway`,
    capabilities: [{
      resourceId: resourceId(requiredEnvironment('OPENAI_RESOURCE_ID')),
      permissions: ['invoke'],
    }],
    expiresAt: null,
  });
  const { value } = await grant.tokens.create({ label: employee });
  const openai = new OpenAI({
    apiKey: value,
    baseURL: process.env.OPENAI_BASE_URL?.trim() || 'http://localhost:8787/v1',
  });
  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL?.trim() || 'gpt-5',
    input: process.env.OPENAI_PROMPT?.trim() || 'Say hello from the RGAP gateway.',
  });

  console.log(response.output_text);
} finally {
  store.close();
}
