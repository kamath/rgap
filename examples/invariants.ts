import assert from 'node:assert/strict';
import {
  permissions,
  type Resource,
  type ResourceId,
  type RgapRepository,
} from '@rgap/core';
import { PostgresRgapStore } from '@rgap/store-postgres';
import { SqliteRgapStore } from '@rgap/store-sqlite';

async function listResourceTree(repository: RgapRepository) {
  const resources: Resource[] = [];
  const visit = async (parentId: ResourceId | null) => {
    let cursor: string | undefined;
    do {
      const page = await repository.resources.list({ parentId, cursor, limit: 100 });
      resources.push(...page);
      for (const resource of page) await visit(resource.id);
      cursor = page.length === 100 ? page.at(-1)!.id : undefined;
    } while (cursor);
  };
  await visit(null);
  return resources;
}

const postgresUrl = process.env.RGAP_POSTGRES_URL;
const store = postgresUrl
  ? new PostgresRgapStore({ url: postgresUrl })
  : new SqliteRgapStore({ url: ':memory:' });

try {
  if (store instanceof PostgresRgapStore) await store.migrate();
  const admin = store.admin();
  await admin.reset();
  const acme = await admin.resources.create({ name: 'acme' });
  const platform = await acme.create({ name: 'platform' });
  const docs = await platform.create({ name: 'docs' });
  const design = await docs.create({ name: 'design' });
  const finance = await acme.create({ name: 'finance' });
  await finance.create({ name: 'payroll' });

  const companyGrant = await admin.grants.create({
    name: 'company',
    bindings: [{
      id: acme.id,
      permissions: ['read', 'write'],
    }],
    expiresAt: null,
  });
  const companyToken = await companyGrant.tokens.create({ label: 'company' });
  const company = store.as(companyToken.value);

  const agentGrant = await company.grants.create({
    name: 'company/team/user/agent',
    bindings: [{
      id: docs.id,
      permissions: ['read'],
    }],
    expiresAt: null,
  });
  const agentToken = await agentGrant.tokens.create({ label: 'agent' });

  const resources = await listResourceTree(admin);
  for (const resource of resources) {
    for (const permission of permissions) {
      const child = await admin.authorize(
        agentToken.value,
        resource.id,
        permission,
      );
      const parent = await admin.authorize(
        companyToken.value,
        resource.id,
        permission,
      );

      assert(
        !child.allowed || parent.allowed,
        `child authorization exceeds parent at ${resource.name}:${permission}`,
      );
    }
  }

  assert.equal(
    (await admin.authorize(
      agentToken.value,
      design.id,
      'read',
    )).allowed,
    true,
  );

  await companyGrant.revoke();

  assert.equal(
    (await admin.authorize(
      agentToken.value,
      design.id,
      'read',
    )).allowed,
    false,
  );

  console.log('Invariant walkthrough passed.');
} finally {
  await store.close();
}
