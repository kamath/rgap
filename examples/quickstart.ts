import { SqliteRgapStore } from '@rgap/sqlite';

const store = new SqliteRgapStore({ url: ':memory:' });

try {
  const admin = store.admin();

  const acme = await admin.resources.create({ name: 'acme' });
  const platform = await acme.create({ name: 'platform' });
  const docs = await platform.create({ name: 'docs' });
  const design = await docs.create({ name: 'design' });

  const company = await admin.grants.create({
    name: 'Company',
    capabilities: [],
    expiresAt: null,
  });

  await company.capabilities.set([
    {
      resourceId: acme.id,
      permissions: ['read', 'write', 'invoke'],
    },
  ]);

  const companyToken = await company.tokens.create({
    label: 'platform-service',
  });
  const companyPlane = store.as(companyToken.value);

  const agent = await companyPlane.grants.create({
    name: 'Documentation agent',
    capabilities: [],
    expiresAt: null,
  });

  await agent.capabilities.set([
    {
      path: 'acme/platform/docs',
      permissions: ['read'],
    },
  ]);

  const agentToken = await agent.tokens.create({
    label: 'research-run',
  });
  const agentPlane = store.as(agentToken.value);

  const visibleDesign = await agentPlane.resources.get(design.id);
  const read = await agentPlane.authorize(
    agentToken.value,
    design.id,
    'read',
  );
  const write = await agentPlane.authorize(
    agentToken.value,
    design.id,
    'write',
  );

  console.log({
    resource: visibleDesign.name,
    read: read.allowed,
    write: write.allowed,
  });

  await company.revoke();

  const afterRevocation = await agentPlane.authorize(
    agentToken.value,
    design.id,
    'read',
  );

  console.log({
    readAfterAncestorRevocation: afterRevocation.allowed,
  });
} finally {
  store.close();
}
