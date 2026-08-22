import type { ResourceHandle, RgapRepository } from '@rgap/core';
import { store } from './config';

try {
  const admin = store.admin();
  const llm = await child(admin, null, 'llm');
  const openai = await child(admin, llm, 'openai');

  console.log(`OPENAI_RESOURCE_ID=${openai.id}`);
} finally {
  store.close();
}

async function child(
  repository: RgapRepository,
  parent: ResourceHandle | null,
  name: string,
) {
  const records = await repository.resources.list({ parentId: parent?.id ?? null, limit: 100 });
  const existing = records.find((record) => record.name === name);
  if (existing) return repository.resources.get(existing.id);
  return parent ? parent.create({ name }) : repository.resources.create({ name });
}
