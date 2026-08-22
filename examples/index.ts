/**
 * A scratchpad. It is here to answer "what does the model do about this?", so edit it freely:
 * arrange resources, grants, and tokens, then print what authorization says about them.
 *
 * This file walks company → team → employee → agent → subagent. Each step issues a token,
 * selects that plane with `store.as`, and creates a narrower child grant.
 *
 * `pnpm scratch` runs this file against examples/scratch.db.
 */
import { fileURLToPath } from 'node:url';
import { resourceId, resourcePath, type Permission, type ResourceId, type TokenValue } from '@rgap/core';
import { SqliteRgapStore } from '@rgap/sqlite';

type TreeNode<Id extends string> = { id: Id; parentId: Id | null; name: string };

const store = new SqliteRgapStore({ url: fileURLToPath(new URL('scratch.db', import.meta.url)) });
const root = store.admin();

// Every run starts from an empty store. Remove this to keep what the last run wrote.
await root.reset();

const acme = await root.resources.create({ name: 'acme' });
const companyGrant = await root.grants.create({
  name: 'Company',
  capabilities: [{
    resourceId: acme.id,
    permissions: ['read', 'write', 'delete', 'move', 'invoke'],
  }],
  expiresAt: null,
});
const companyToken = await companyGrant.tokens.create({ label: 'company' });
const company = store.as(companyToken.value);

const companyRoot = await company.resources.get(acme.id);
const platform = await companyRoot.create({ name: 'platform' });
const docs = await platform.create({ name: 'docs' });
const design = await docs.create({ name: 'design' });
const tools = await platform.create({ name: 'tools' });
const search = await tools.create({ name: 'search' });
const finance = await companyRoot.create({ name: 'finance' });
const payroll = await finance.create({ name: 'payroll' });

const { resources: companyResources } = await company.readState();

function printPaths<Id extends string>(
  nodes: Record<string, TreeNode<Id>>,
  currentId: Id | null = null,
  pathSoFar: string[] = []
) {
  const children = Object.values(nodes)
    .filter(node => node.parentId === currentId)
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) {
    const newPath = [...pathSoFar, child.name];
    console.log(newPath.join('/'));
    printPaths(nodes, child.id, newPath);
  }
}

console.log("RESOURCE TREE");
printPaths(companyResources);
console.log('\n\n');

const teamGrant = await company.grants.create({
  name: 'Team',
  capabilities: [{ resourceId: platform.id, permissions: ['read', 'write', 'invoke'] }],
  expiresAt: null,
});
const teamToken = await teamGrant.tokens.create({ label: 'team' });
const team = store.as(teamToken.value);

const employeeGrant = await team.grants.create({
  name: 'Employee',
  capabilities: [{ resourceId: docs.id, permissions: ['read', 'write'] }],
  expiresAt: null,
});
const employeeToken = await employeeGrant.tokens.create({ label: 'employee' });
const employee = store.as(employeeToken.value);

const agentGrant = await employee.grants.create({
  name: 'Agent',
  capabilities: [{ path: 'acme/platform/docs', permissions: ['read'] }],
  expiresAt: null,
});
const agentToken = await agentGrant.tokens.create({ label: 'agent' });
const agent = store.as(agentToken.value);

const subagentGrant = await agent.grants.create({
  name: 'Subagent',
  capabilities: [{ path: 'acme/platform/docs/design', permissions: ['read'] }],
  expiresAt: null,
});
const subagentToken = await subagentGrant.tokens.create({ label: 'subagent' });

const { resources, grants } = await company.readState();
const path = (id: ResourceId) => resourcePath(resources, id);

console.log("GRANT PATHS");
printPaths(grants);
console.log('\n\n');

const check = async (label: string, token: TokenValue, target: ResourceId, permission: Permission) => {
  const decision = await company.authorize(token, target, permission);
  const verdict = decision.allowed ? 'allow' : 'deny ';
  console.log(`${verdict}  ${label.padEnd(8)} ${permission.padEnd(7)} ${path(target).padEnd(26)} ${decision.detail}`);
};

await check('company', companyToken.value, payroll.id, 'read');
await check('team', teamToken.value, payroll.id, 'read');
await check('team', teamToken.value, docs.id, 'write');
await check('team', teamToken.value, search.id, 'invoke');
await check('employee', employeeToken.value, docs.id, 'write');
await check('employee', employeeToken.value, search.id, 'invoke');
await check('agent', agentToken.value, docs.id, 'write');
await check('agent', agentToken.value, docs.id, 'read');
await check('agent', agentToken.value, design.id, 'read');
await check('subagent', subagentToken.value, design.id, 'read');
await check('subagent', subagentToken.value, docs.id, 'read');
await check('subagent', subagentToken.value, search.id, 'invoke');

const tokens = [
  ['company', companyToken.value],
  ['team', teamToken.value],
  ['employee', employeeToken.value],
  ['agent', agentToken.value],
  ['subagent', subagentToken.value],
] as const;

for (const [label, token] of tokens) {
  const authority = await company.inspectToken(token);
  console.log(`\n${label}: ${authority.detail}`);
  Object.entries(authority.permissions).forEach(([id, held]) => {
    console.log(`  ${path(resourceId(id)).padEnd(26)} ${held.join(' ')}`);
  });
}

// console.log(await root.readState());

store.close();
