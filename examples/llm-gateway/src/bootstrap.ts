import type { ResourceHandle, RgapRepository } from '@rgap/core';
import { SqliteRgapStore } from '@rgap/sqlite';
import { databaseUrl } from './config';

const store = new SqliteRgapStore({ url: databaseUrl() });

try {
  const admin = store.admin();
  const llm = await child(admin, null, 'llm');
  const openai = await child(admin, llm, 'openai');
  const employee = process.env.EMPLOYEE_NAME?.trim() || 'employee';
  const grant = await admin.grants.create({
    name: `${employee} OpenAI gateway`,
    capabilities: [{ resourceId: openai.id, permissions: ['invoke'] }],
    expiresAt: null,
  });
  const issued = await grant.tokens.create({ label: employee });

  console.log(`OPENAI_RESOURCE_ID=${openai.id}`);
  console.log(`OPENAI_GATEWAY_TOKEN=${issued.value}`);
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
