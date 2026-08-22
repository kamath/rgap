import { RgapError, type Capability, type GrantId, type Permission, type ResourceId, type TokenValue } from './domain';
import type { GrantHandle, GrantWrite, IssuedToken, ResourceHandle, RgapRepository, TokenHandle } from './repository';

/**
 * Wraps a repository so each command authorizes the token before it runs.
 *
 * RGAP decides and the host enforces, so repository commands themselves take no token. This guard is
 * the enforced path, stated once here rather than re-derived by every host. It guards commands only:
 * reads pass straight through, and `inspectToken` remains the read-side lens. Handles it returns
 * inherit the same checks.
 */
export function guardCommands(repository: RgapRepository, token: TokenValue): RgapRepository {
  const actingGrantId = async () => {
    const view = await repository.inspectToken(token);
    if (!view.valid || !view.grantId) throw new RgapError('unauthorized', view.detail);
    return view.grantId;
  };

  const permit = async (id: ResourceId, permission: Permission) => {
    const decision = await repository.authorize(token, id, permission);
    if (!decision.allowed) throw new RgapError('unauthorized', decision.detail);
  };

  /** Tokens reach their own grant and everything delegated from it, and nothing above or beside it. */
  const withinActingGrant = async (id: GrantId) => {
    const acting = await actingGrantId();
    const { grants } = await repository.readState();
    for (let current: GrantId | null = id; current; current = grants[current]?.parentId ?? null) {
      if (current === acting) return;
    }
    throw new RgapError('unauthorized', 'That grant is neither this token\'s grant nor delegated from it.');
  };

  // Declared, not assigned: a `never` return only narrows control flow from a function declaration.
  function administrative(operation: string): never {
    throw new RgapError('unauthorized', `${operation} is an administrative operation that no token authorizes.`);
  }

  const wrapResource = (resource: ResourceHandle): ResourceHandle => ({
    ...resource,
    async create(input) {
      await permit(resource.id, 'write');
      return wrapResource(await resource.create(input));
    },
    async move(parentId) {
      if (!parentId) administrative('Moving a resource to a root');
      await permit(resource.id, 'move');
      await permit(parentId, 'write');
      return wrapResource(await resource.move(parentId));
    },
    async delete() {
      await permit(resource.id, 'delete');
      return resource.delete();
    },
  });

  const wrapGrant = (grant: GrantHandle): GrantHandle => {
    const capabilities = Object.assign([...grant.capabilities], {
      async set(entries: Capability[]) {
        if (!grant.parentId) administrative("Setting a root grant's capabilities");
        if (grant.id === (await actingGrantId())) {
          throw new RgapError('unauthorized', 'A token may not set the capabilities of its own grant.');
        }
        await withinActingGrant(grant.id);
        return wrapGrant(await grant.capabilities.set(entries));
      },
    });
    return {
      ...grant,
      capabilities,
      async create(input: GrantWrite) {
        if (grant.id !== (await actingGrantId())) {
          throw new RgapError('unauthorized', 'A token may only delegate from the grant it references.');
        }
        return wrapGrant(await grant.create(input));
      },
      tokens: {
        async create(input): Promise<IssuedToken> {
          await withinActingGrant(grant.id);
          return wrapIssued(await grant.tokens.create(input));
        },
      },
      async revoke() {
        await withinActingGrant(grant.id);
        return grant.revoke();
      },
    };
  };

  const wrapToken = (record: TokenHandle): TokenHandle => ({
    ...record,
    async revoke() {
      await withinActingGrant(record.grantId);
      return record.revoke();
    },
  });

  const wrapIssued = (issued: IssuedToken): IssuedToken => ({
    ...wrapToken(issued),
    value: issued.value,
  });

  return {
    resources: {
      async create() {
        administrative('Creating a root resource');
      },
      async get(id) {
        return wrapResource(await repository.resources.get(id));
      },
    },
    grants: {
      async create(input) {
        const parent = wrapGrant(await repository.grants.get(await actingGrantId()));
        return parent.create(input);
      },
      async get(id) {
        return wrapGrant(await repository.grants.get(id));
      },
    },
    tokens: {
      async get(id) {
        return wrapToken(await repository.tokens.get(id));
      },
    },
    readState: () => repository.readState(),
    authorize: (bearer, resourceId, permission) => repository.authorize(bearer, resourceId, permission),
    inspectToken: (bearer) => repository.inspectToken(bearer),
    async reset() {
      administrative('Resetting the store');
    },
  };
}
