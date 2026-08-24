import {
  resourcePath,
  type Grant,
  type GrantId,
  type Resource,
  type ResourceId,
  type RgapRepository,
  type RgapStore,
} from '@rgap/core';

export type ConformanceSnapshot = {
  resources: string[];
  grants: string[];
  decisions: {
    childReadsDesign: boolean;
    childWritesDesign: boolean;
    childReadsPayroll: boolean;
    parentReadsPayroll: boolean;
    childReadsAfterRevocation: boolean;
  };
};

function grantPath(grants: readonly Grant[], id: GrantId) {
  const byId = new Map(grants.map((grant) => [grant.id, grant]));
  const segments: string[] = [];
  const seen = new Set<GrantId>();
  let current = byId.get(id);
  while (current) {
    if (seen.has(current.id)) throw new Error(`grant cycle at ${current.id}`);
    seen.add(current.id);
    segments.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return segments.join('/');
}

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

/**
 * Runs one semantic trace through a real store. Adapter suites compare this normalized
 * snapshot, which excludes generated IDs, bearer hashes, and wall-clock timestamps.
 */
export async function runAdapterConformance(
  store: RgapStore,
): Promise<ConformanceSnapshot> {
  const admin = store.admin();
  await admin.reset();

  const acme = await admin.resources.create({ name: 'acme' });
  const platform = await acme.create({ name: 'platform' });
  const docs = await platform.create({ name: 'docs' });
  const design = await docs.create({ name: 'design' });
  const finance = await acme.create({ name: 'finance' });
  const payroll = await finance.create({ name: 'payroll' });
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
    name: 'company/team/agent',
    bindings: [{
      id: docs.id,
      permissions: ['read'],
    }],
    expiresAt: null,
  });
  const agentToken = await agentGrant.tokens.create({ label: 'agent' });

  const childReadsDesign = (
    await admin.authorize(agentToken.value, design.id, 'read')
  ).allowed;
  const childWritesDesign = (
    await admin.authorize(agentToken.value, design.id, 'write')
  ).allowed;
  const childReadsPayroll = (
    await admin.authorize(agentToken.value, payroll.id, 'read')
  ).allowed;
  const parentReadsPayroll = (
    await admin.authorize(companyToken.value, payroll.id, 'read')
  ).allowed;

  await companyGrant.revoke();
  const childReadsAfterRevocation = (
    await admin.authorize(agentToken.value, design.id, 'read')
  ).allowed;

  const resources = await listResourceTree(admin);
  const grants = await admin.grants.list({ limit: 100 });

  return {
    resources: resources
      .map((resource) => resourcePath(resources, resource.id))
      .sort(),
    grants: grants.map((grant) => grantPath(grants, grant.id)).sort(),
    decisions: {
      childReadsDesign,
      childWritesDesign,
      childReadsPayroll,
      parentReadsPayroll,
      childReadsAfterRevocation,
    },
  };
}
