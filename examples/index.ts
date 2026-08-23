/**
 * A scratchpad. It is here to answer "what does the model do about this?", so edit it freely:
 * arrange resources, grants, and tokens, then print what authorization says about them.
 *
 * This file walks company → team → employee → agent → subagent. Each step issues a token,
 * selects that plane with `store.as`, and creates a narrower child grant.
 *
 * `pnpm scratch` runs this file against examples/scratch.db. Replace the store-construction line
 * with `new HttpRgapStore(...)` to run the same walkthrough against the Hono API.
 */
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  resourceId,
  resourcePath,
  type InvokeRuntime,
  type Permission,
  type ResourceId,
  type TokenValue,
} from '@rgap/core';
import { HttpRgapStore } from '@rgap/server';
import { SqliteRgapStore } from '@rgap/sqlite';

type TreeNode<Id extends string> = { id: Id; parentId: Id | null; name: string };

// To use Hono, replace the next line with:
// const store = new HttpRgapStore({ baseUrl: 'http://localhost:3000', adminToken: process.env.RGAP_ADMIN_TOKEN ?? 'test' });
const EchoInputSchema = z.object({ query: z.string() });
const EchoOutputSchema = z.object({ message: z.string(), searchedWithin: z.string() });
const echo: InvokeRuntime<
  z.infer<typeof EchoInputSchema>,
  z.infer<typeof EchoOutputSchema>
> = {
  inputSchema: EchoInputSchema,
  outputSchema: EchoOutputSchema,
  bindings: {
    searchWithin: { kind: 'resource' },
  },
  async invoke({ input, bindings }) {
    return {
      message: `result: ${input.query}`,
      searchedWithin: bindings.searchWithin.resourceId,
    };
  },
};
const store = new SqliteRgapStore({
  url: fileURLToPath(new URL('scratch.db', import.meta.url)),
  runtimes: { echo },
});
const root = store.admin();

// Every run starts from an empty store. Remove this to keep what the last run wrote.
await root.reset();

const acme = await root.resources.create({ name: 'acme' });
const companyGrant = await root.grants.create({
  name: 'Company',
  resources: [{
    id: acme.id,
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
await search.executable.set({
  runtime: 'echo',
});
const finance = await companyRoot.create({ name: 'finance' });
const payroll = await finance.create({ name: 'payroll' });

const companyResources = await company.resources.list({ limit: 100 });

console.log("RESOURCE TREE");
printPaths(companyResources);
console.log('\n\n');

const teamGrant = await company.grants.create({
  name: 'Team',
  resources: [{ id: platform.id, permissions: ['read', 'write', 'invoke'] }],
  expiresAt: null,
});
const teamToken = await teamGrant.tokens.create({ label: 'team' });
const team = store.as(teamToken.value);

const employeeGrant = await team.grants.create({
  name: 'Employee',
  resources: [{ id: docs.id, permissions: ['read', 'write'] }],
  expiresAt: null,
});
const employeeToken = await employeeGrant.tokens.create({ label: 'employee' });
const employee = store.as(employeeToken.value);

const agentGrant = await employee.grants.create({
  name: 'Agent',
  resources: [{ path: 'acme/platform/docs', permissions: ['read'] }],
  expiresAt: null,
});
const agentToken = await agentGrant.tokens.create({ label: 'agent' });
const agent = store.as(agentToken.value);

const subagentGrant = await agent.grants.create({
  name: 'Subagent',
  resources: [{ path: 'acme/platform/docs/design', permissions: ['read'] }],
  expiresAt: null,
});
const subagentToken = await subagentGrant.tokens.create({ label: 'subagent' });

const resources = await company.resources.list({ limit: 100 });
const grants = await company.grants.list({ limit: 100 });
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

console.log('\nINVOKE');
for await (const event of search.invoke({
  input: { query: 'design' },
  bindings: { searchWithin: docs.id },
})) {
  console.log(event);
}

// console.log(await root.resources.list({ limit: 100 }));

store.close();

function printPaths<Id extends string>(nodes: readonly TreeNode<Id>[]) {
  const visit = (currentId: Id | null, pathSoFar: string[]) => {
    const children = nodes
      .filter((node) => node.parentId === currentId)
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const path = [...pathSoFar, child.name];
      console.log(path.join('/'));
      visit(child.id, path);
    }
  };
  visit(null, []);
}
