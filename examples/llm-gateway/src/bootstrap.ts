import { requiredEnvironment, store } from './config';

try {
  const admin = store.admin();
  await admin.reset();
  const llm = await admin.resources.create({ name: 'llm' });
  const openai = await llm.create({ name: 'openai' });
  const protectedValues = await admin.resources.create({ name: 'secrets' });
  const openaiKey = await protectedValues.create({ name: 'openai-key' });
  await openaiKey.secret.write(requiredEnvironment('OPENAI_API_KEY'));

  console.log(`OPENAI_RESOURCE_ID=${openai.id}`);
  console.log(`OPENAI_SECRET_ID=${openaiKey.id}`);
} finally {
  store.close();
}
