import assert from 'node:assert/strict';
import { permissions } from '@rgap/core';
import { SqliteRgapStore } from '@rgap/sqlite';

const store = new SqliteRgapStore({ url: ':memory:' });

try {
  const admin = store.admin();
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

  const resources = await admin.resources.list({ limit: 100 });
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
  store.close();
}
