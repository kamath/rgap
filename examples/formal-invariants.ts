import assert from 'node:assert/strict';
import { type Permission } from '@rgap/core';
import { SqliteRgapStore } from '@rgap/sqlite';

const permissions = ['read', 'write', 'invoke', 'move', 'delete'] as const
  satisfies readonly Permission[];

const store = new SqliteRgapStore({ url: ':memory:' });

try {
  const admin = store.admin();
  const design = await admin.resources.create({
    name: 'acme/platform/docs/design',
  });
  await admin.resources.create({
    name: 'acme/finance/payroll',
  });

  const companyGrant = await admin.grants.create({
    name: 'company',
    resources: [{
      path: 'acme',
      permissions: ['read', 'write'],
    }],
    expiresAt: null,
  });
  const companyToken = await companyGrant.tokens.create({ label: 'company' });
  const company = store.as(companyToken.value);

  const agentGrant = await company.grants.create({
    name: 'company/team/user/agent',
    resources: [{
      path: 'acme/platform/docs',
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

  console.log('Formal invariant walkthrough passed.');
} finally {
  store.close();
}
