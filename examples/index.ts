/**
 * A scratchpad. It is here to answer "what does the model do about this?", so edit it freely:
 * arrange resources, grants, and tokens, then print what authorization says about them.
 *
 * This file walks company → team → employee → agent → subagent. Company is created first so
 * it can hold the broad `acme` grant. The rest of the chain is one create at
 * `company/team/employee/agent/subagent`. Intermediate grants then receive narrower
 * resource sets, and each step issues a token.
 *
 * `pnpm scratch` runs this file against examples/scratch.db. Replace the store-construction line
 * with `new HttpRgapStore(...)` to run the same walkthrough against the Hono API. The local SQLite
 * store applies each command as one focused row-level transaction rather than replacing the store.
 */
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
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
  name: 'company',
  resources: [{
    id: acme.id,
    permissions: ['read', 'write', 'delete', 'move', 'invoke'],
  }],
  expiresAt: null,
});
const companyToken = await companyGrant.tokens.create({ label: 'company' });
const company = store.as(companyToken.value);

const platform = await company.resources.create({ name: 'acme/platform' });
const docs = await platform.create({ name: 'docs' });
const design = await docs.create({ name: 'design' });
const search = await platform.create({ name: 'tools/search' });
await search.executable.set({
  runtime: 'echo',
});
const payroll = await company.resources.create({ name: 'acme/finance/payroll' });

const companyResources = await company.resources.list({ limit: 100 });

console.log("RESOURCE TREE");
printPaths(companyResources);
console.log('\n\n');

const subagentGrant = await company.grants.create({
  name: 'company/team/employee/agent/subagent',
  resources: [{ path: 'acme/platform/docs/design', permissions: ['read'] }],
  expiresAt: null,
});
const agentGrant = await company.grants.get(subagentGrant.parentId!);
const employeeGrant = await company.grants.get(agentGrant.parentId!);
const teamGrant = await company.grants.get(employeeGrant.parentId!);
await teamGrant.resources.set([{ id: platform.id, permissions: ['read', 'write', 'invoke'] }]);
await employeeGrant.resources.set([{ id: docs.id, permissions: ['read', 'write'] }]);
await agentGrant.resources.set([{ path: 'acme/platform/docs', permissions: ['read'] }]);
const teamToken = await teamGrant.tokens.create({ label: 'team' });
const employeeToken = await employeeGrant.tokens.create({ label: 'employee' });
const agentToken = await agentGrant.tokens.create({ label: 'agent' });
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

const invokerGrant = await company.grants.create({
  name: 'company/invoker',
  resources: [{ id: search.id, permissions: ['invoke'] }],
  expiresAt: null,
});
const invokerToken = await invokerGrant.tokens.create({ label: 'invoker' });
await check('invoker', invokerToken.value, search.id, 'invoke');
await check('invoker', invokerToken.value, search.id, 'read');
await check('invoker', invokerToken.value, search.id, 'write');

const tokens = [
  ['company', companyToken.value],
  ['team', teamToken.value],
  ['employee', employeeToken.value],
  ['agent', agentToken.value],
  ['subagent', subagentToken.value],
  ['invoker', invokerToken.value],
] as const;

for (const [label, token] of tokens) {
  const visible = await store.as(token).resources.list({ limit: 100 });
  console.log(`\n${label} resource view:`);
  visible.forEach(({ id }) => {
    console.log(`  ${path(id)}`);
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
