import { SqliteRgapStore } from '@rgap/sqlite';

// Each command loads the records needed by its rule and commits only its changed rows and audit
// event. `:memory:` changes durability, not the focused transaction model.
const store = new SqliteRgapStore({ url: ':memory:' });

try {
  const admin = store.admin();

  const design = await admin.resources.create({
    name: 'acme/platform/docs/design',
  });

  const agent = await admin.grants.create({
    name: 'company/documentation-agent',
    resources: [{
      path: 'acme/platform/docs',
      permissions: ['read'],
    }],
    expiresAt: null,
  });

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

  await agent.revoke();

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
