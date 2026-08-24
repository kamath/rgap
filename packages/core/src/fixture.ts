import {
  authorize, grantId, resolveBearer, resourceId, tokenHash, tokenId, tokenValue,
  type GrantResource, type Resource, type State,
} from './domain';
import { paginateRecords, repositoryFrom, type RgapCommands } from './repository';

export function fixture(): State {
  const resources = [
    resource('acme', null), resource('drive', 'acme'), resource('search-files', 'drive'), resource('read-file', 'drive'),
    resource('slack', 'acme'), resource('slack-tools', 'slack'), resource('post-message', 'slack-tools'),
    resource('create-issue', 'acme'),
  ];
  return {
    resources: Object.fromEntries(resources.map((item) => [item.id, item])),
    grants: {
      coordinator: {
        id: grantId('coordinator'), name: 'Coordinator', parentId: null,
        resources: [cap('search-files'), cap('create-issue')],
        expiresAt: '2027-08-21T23:00:00.000Z', revokedAt: null,
      },
      researcher: {
        id: grantId('researcher'), name: 'Researcher', parentId: grantId('coordinator'),
        resources: [cap('search-files')],
        expiresAt: '2027-08-21T22:00:00.000Z', revokedAt: null,
      },
    },
    tokens: {
      demo: {
        id: tokenId('demo'), grantId: grantId('coordinator'), label: 'demo',
        hash: tokenHash('b528aaf0496a7f1b670eaf73987ee9237eaddbbefa1ade4844e5d318d4d35bc3'),
        expiresAt: '2027-08-21T23:00:00.000Z', revokedAt: null,
      },
    },
    audit: [],
  };
}

const resource = (id: string, parent: string | null): Resource => ({
  id: resourceId(id), parentId: parent ? resourceId(parent) : null, name: id, deletedAt: null,
  executable: null,
});

const cap = (id: string): GrantResource => ({
  id: resourceId(id), permissions: ['read', 'invoke'],
});

/** A call the guard forwarded to the command sink, in the order the guard made it. */
export type RecordedCall = { method: string; args: unknown[] };

/**
 * A command sink that answers the guard's reads from a fixed state and records its commands.
 *
 * The guard decides which commands may run; it does not compute state transitions. Recording the
 * forwarded call rather than applying it keeps a guard test about the decision alone, and keeps it
 * independent of any repository implementation.
 */
export function stubCommands(state: State, at: string) {
  const calls: RecordedCall[] = [];
  const record = <T>(method: string, args: unknown[], result: T) => {
    calls.push({ method, args });
    return Promise.resolve(result);
  };
  const resourceStub = (id: Resource['id'], parentId: Resource['parentId']): Resource =>
    ({ id, parentId, name: id, deletedAt: null, executable: null });
  const executable = (input: NonNullable<Parameters<RgapCommands['createResource']>[0]['executable']>) => ({
    runtime: input.runtime,
    input: structuredClone(input.input ?? {}),
    bind: Object.fromEntries(Object.entries(input.bind ?? {}).map(([name, boundId]) => [
      name,
      { resourceId: boundId, grantLineage: null },
    ])),
  });

  const commands: RgapCommands = {
    getResource: (id) => Promise.resolve(state.resources[id]),
    listResources: (query = {}) => Promise.resolve(paginateRecords(
      Object.values(state.resources)
        .filter((item) => !item.deletedAt && (query.parentId === undefined || item.parentId === query.parentId))
        .sort((left, right) => left.id.localeCompare(right.id)),
      query,
    )),
    getGrant: (id) => Promise.resolve(state.grants[id]),
    listGrants: (query = {}) => Promise.resolve(paginateRecords(
      Object.values(state.grants)
        .filter((item) => query.parentId === undefined || item.parentId === query.parentId)
        .sort((left, right) => left.id.localeCompare(right.id)),
      query,
    )),
    getToken: (id) => Promise.resolve(state.tokens[id]),
    listTokens: (query = {}) => Promise.resolve(paginateRecords(
      Object.values(state.tokens)
        .filter((item) => query.grantId === undefined || item.grantId === query.grantId)
        .sort((left, right) => left.id.localeCompare(right.id)),
      query,
    )),
    listAudit: (query = {}) => Promise.resolve(paginateRecords(state.audit, query)),
    // Tests treat the bearer as the stored hash, so the stub re-brands rather than hashing.
    authorize: (token, id, permission) => Promise.resolve(authorize(state, tokenHash(token), id, permission, at)),
    createResource: (input) => record('createResource', [input], {
      id: resourceId('created'),
      parentId: input.parentId,
      name: input.name,
      deletedAt: null,
      executable: input.executable ? executable(input.executable) : null,
    }),
    updateResource: (id, input) => record('updateResource', [id, input], {
      ...resourceStub(id, input.parentId ?? state.resources[id]?.parentId ?? null),
      ...state.resources[id],
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      ...(input.executable === undefined ? {} : { executable: executable(input.executable) }),
    }),
    deleteResource: (id) => record('deleteResource', [id], undefined),
    invoke: (id, input) => {
      calls.push({ method: 'invoke', args: [id, input] });
      return (async function* () {
        yield { type: 'done' as const };
      })();
    },
    createGrant: (input) => record('createGrant', [input], { ...input, id: grantId('created'), revokedAt: null }),
    setResources: (id, resources) =>
      record('setResources', [id, resources], { ...state.grants[id], resources }),
    issueToken: (id, label) => record('issueToken', [id, label], {
      record: {
        id: tokenId('issued'), grantId: id, label, hash: tokenHash('issued-hash'), expiresAt: null, revokedAt: null,
      },
      value: tokenValue('issued-value'),
    }),
    revokeToken: (id) => record('revokeToken', [id], undefined),
    revokeGrant: (id) => record('revokeGrant', [id], undefined),
    reset: () => record('reset', [], undefined),
  };
  const resolve = (token: ReturnType<typeof tokenValue>) =>
    Promise.resolve(resolveBearer(state, tokenHash(token), at));
  return { commands, calls, resolveBearer: resolve };
}
