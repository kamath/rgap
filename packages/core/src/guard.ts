import {
  RgapError,
  grantId,
  resourceId,
  tokenId,
  type AuditEvent,
  type Capability,
  type GrantId,
  type Permission,
  type ResourceId,
  type TokenValue,
} from './domain';
import {
  maximumPageLimit,
  pageLimit,
  type GrantHandle,
  type GrantWrite,
  type IssuedToken,
  type ListQuery,
  type Page,
  type ResourceHandle,
  type RgapRepository,
  type TokenHandle,
} from './repository';

/**
 * Wraps a repository so each command authorizes the token before it runs.
 *
 * RGAP decides and the host enforces, so repository commands themselves take no token. This guard is
 * the enforced path, stated once here rather than re-derived by every host. Collection reads expose
 * only records in the acting token's resource and delegation views. Handles inherit the same checks.
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
    for (let current: GrantId | null = id; current;) {
      if (current === acting) return;
      current = (await repository.grants.get(current)).parentId;
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

  const visibleResourceIds = async () => {
    const view = await repository.inspectToken(token);
    if (!view.valid) return new Set<string>();
    const visible = new Set<string>();
    for (const reached of Object.keys(view.permissions)) {
      for (let current: ResourceId | null = resourceId(reached); current;) {
        if (visible.has(current)) break;
        visible.add(current);
        current = (await repository.resources.get(current)).parentId;
      }
    }
    return visible;
  };

  const grantIsVisible = async (id: GrantId) => {
    const view = await repository.inspectToken(token);
    if (!view.valid || !view.grantId) return false;
    if (view.lineage.includes(id)) return true;
    for (let current: GrantId | null = id; current;) {
      if (current === view.grantId) return true;
      current = (await repository.grants.get(current)).parentId;
    }
    return false;
  };

  const tokenIsVisible = async (id: TokenHandle['id']) => {
    const record = await repository.tokens.get(id);
    return grantIsVisible(record.grantId);
  };

  const auditIsVisible = async (event: AuditEvent) => {
    if (event.action === 'authorize' || event.action.startsWith('resource.')) {
      return (await visibleResourceIds()).has(event.target);
    }
    if (event.action.startsWith('grant.')) return grantIsVisible(grantId(event.target));
    if (event.action.startsWith('token.')) return tokenIsVisible(tokenId(event.target));
    return false;
  };

  const filtered = async <T extends { id: string }, Q extends ListQuery>(
    query: Q | undefined,
    load: (query: Q) => Promise<Page<T>>,
    allowed: (record: T) => Promise<boolean>,
  ): Promise<Page<T>> => {
    const limit = pageLimit(query?.limit);
    const records: T[] = [];
    let cursor = query?.cursor;
    while (records.length < limit) {
      const page = await load({ ...query, cursor, limit: maximumPageLimit } as Q);
      for (let index = 0; index < page.records.length; index += 1) {
        const record = page.records[index];
        if (await allowed(record)) records.push(record);
        if (records.length === limit) {
          const more = index < page.records.length - 1 || page.cursor !== null;
          return { records, cursor: more ? record.id : null };
        }
      }
      if (!page.cursor) return { records, cursor: null };
      cursor = page.cursor;
    }
    return { records, cursor: cursor ?? null };
  };

  return {
    resources: {
      async create() {
        administrative('Creating a root resource');
      },
      async get(id) {
        const resource = await repository.resources.get(id);
        if (!(await visibleResourceIds()).has(id)) throw new RgapError('unauthorized', 'That resource is outside this token\'s view.');
        return wrapResource(resource);
      },
      list: (query) => filtered(query, (page) => repository.resources.list(page), async (resource) =>
        (await visibleResourceIds()).has(resource.id)),
    },
    grants: {
      async create(input) {
        const parent = wrapGrant(await repository.grants.get(await actingGrantId()));
        return parent.create(input);
      },
      async get(id) {
        const grant = await repository.grants.get(id);
        if (!(await grantIsVisible(id))) throw new RgapError('unauthorized', 'That grant is outside this token\'s view.');
        return wrapGrant(grant);
      },
      list: (query) => filtered(query, (page) => repository.grants.list(page), (grant) => grantIsVisible(grant.id)),
    },
    tokens: {
      async get(id) {
        const record = await repository.tokens.get(id);
        if (!(await grantIsVisible(record.grantId))) throw new RgapError('unauthorized', 'That token is outside this token\'s view.');
        return wrapToken(record);
      },
      list: (query) => filtered(query, (page) => repository.tokens.list(page), (record) => grantIsVisible(record.grantId)),
    },
    audit: {
      list: (query) => filtered(query, (page) => repository.audit.list(page), auditIsVisible),
    },
    authorize: (bearer, resourceId, permission) => repository.authorize(bearer, resourceId, permission),
    inspectToken: (bearer) => repository.inspectToken(bearer),
    async reset() {
      administrative('Resetting the store');
    },
  };
}
