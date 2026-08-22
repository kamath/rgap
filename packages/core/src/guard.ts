import { RgapError, type Capability, type CreateGrantInput, type CreateResourceInput, type GrantId, type Permission, type ResourceId, type TokenId, type TokenValue } from './domain';
import type { RgapRepository } from './repository';

/**
 * Wraps a repository so each command authorizes the token before it runs.
 *
 * RGAP decides and the host enforces, so repository commands themselves take no token. This guard is
 * the enforced path, stated once here rather than re-derived by every host. It guards commands only:
 * reads pass straight through, and `inspectToken` remains the read-side lens.
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

  return {
    readState: () => repository.readState(),
    authorize: (bearer, resourceId, permission) => repository.authorize(bearer, resourceId, permission),
    inspectToken: (bearer) => repository.inspectToken(bearer),

    async createResource(input: CreateResourceInput) {
      if (!input.parentId) administrative('Creating a root resource');
      await permit(input.parentId, 'write');
      return repository.createResource(input);
    },

    async moveResource(id: ResourceId, parentId: ResourceId | null) {
      if (!parentId) administrative('Moving a resource to a root');
      await permit(id, 'move');
      await permit(parentId, 'write');
      return repository.moveResource(id, parentId);
    },

    async deleteResource(id: ResourceId) {
      await permit(id, 'delete');
      return repository.deleteResource(id);
    },

    async createGrant(input: CreateGrantInput) {
      if (!input.parentId) administrative('Creating a root grant');
      if (input.parentId !== (await actingGrantId())) {
        throw new RgapError('unauthorized', 'A token may only delegate from the grant it references.');
      }
      return repository.createGrant(input);
    },

    /**
     * A token sets what a grant below it reaches, never what its own grant reaches: amending its own
     * entries would let a holder widen itself to its parent's full authority, which its issuer withheld.
     */
    async setCapabilities(grantId: GrantId, capabilities: Capability[]) {
      const { grants } = await repository.readState();
      const grant = grants[grantId];
      if (!grant) throw new RgapError('missing_grant', 'Grant does not exist.');
      if (!grant.parentId) administrative("Setting a root grant's capabilities");
      if (grantId === (await actingGrantId())) {
        throw new RgapError('unauthorized', 'A token may not set the capabilities of its own grant.');
      }
      await withinActingGrant(grantId);
      return repository.setCapabilities(grantId, capabilities);
    },

    async issueToken(grantId: GrantId, label: string) {
      await withinActingGrant(grantId);
      return repository.issueToken(grantId, label);
    },

    async revokeToken(id: TokenId) {
      const { tokens } = await repository.readState();
      const record = tokens[id];
      if (!record) throw new RgapError('missing_token', 'Token does not exist.');
      await withinActingGrant(record.grantId);
      return repository.revokeToken(id);
    },

    async revokeGrant(id: GrantId) {
      await withinActingGrant(id);
      return repository.revokeGrant(id);
    },

    async reset() {
      administrative('Resetting the store');
    },
  };
}
