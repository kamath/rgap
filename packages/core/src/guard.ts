import {
  RgapError,
  grantId,
  pathParts,
  resourceId,
  tokenId,
  type AuditEvent,
  type AuthorityView,
  type GrantResource,
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
  type ResourceWrite,
  type RgapRepository,
  type TokenHandle,
} from './repository';
import { withAuthorizedLineage } from './executable';

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
    return decision;
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
    executable: {
      async get() {
        await permit(resource.id, 'read');
        return resource.executable.get();
      },
      async set(input) {
        await permit(resource.id, 'write');
        return resource.executable.set(input);
      },
      async delete() {
        await permit(resource.id, 'write');
        return resource.executable.delete();
      },
    },
    invoke: (input) => guardedInvoke(resource.id, input),
  });

  const authorizeInvocation = async (id: ResourceId, input: Parameters<RgapRepository['invoke']>[1]) => {
    const invocation = await permit(id, 'invoke');
    for (const boundId of Object.values(input.bindings ?? {})) await permit(boundId, 'invoke');
    return invocation.lineage;
  };

  async function* guardedInvoke(
    id: ResourceId,
    input: Parameters<RgapRepository['invoke']>[1],
  ) {
    const lineage = await authorizeInvocation(id, input);
    yield* repository.invoke(id, withAuthorizedLineage(input, lineage));
  }

  const wrapGrant = (grant: GrantHandle): GrantHandle => {
    const resources = Object.assign([...grant.resources], {
      async set(entries: GrantResource[]) {
        if (!grant.parentId) administrative("Setting a root grant's resources");
        if (grant.id === (await actingGrantId())) {
          throw new RgapError('unauthorized', 'A token may not set the resources of its own grant.');
        }
        await withinActingGrant(grant.id);
        return wrapGrant(await grant.resources.set(entries));
      },
    });
    return {
      ...grant,
      resources,
      async create(input: GrantWrite) {
        await withinActingGrant(grant.id);
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

  const visibleResourceIds = async (view?: AuthorityView) => {
    const currentView = view ?? await repository.inspectToken(token);
    if (!currentView.valid) return new Set<string>();
    const visible = new Set<string>();
    for (const reached of Object.keys(currentView.permissions)) {
      for (let current: ResourceId | null = resourceId(reached); current;) {
        if (visible.has(current)) break;
        visible.add(current);
        current = (await repository.resources.get(current)).parentId;
      }
    }
    return visible;
  };

  const grantIsVisible = async (id: GrantId, view?: AuthorityView) => {
    const currentView = view ?? await repository.inspectToken(token);
    if (!currentView.valid || !currentView.grantId) return false;
    if (currentView.lineage.includes(id)) return true;
    try {
      for (let current: GrantId | null = id; current;) {
        if (current === currentView.grantId) return true;
        current = (await repository.grants.get(current)).parentId;
      }
    } catch {
      return false;
    }
    return false;
  };

  const tokenIsVisible = async (id: TokenHandle['id'], view?: AuthorityView) => {
    try {
      const record = await repository.tokens.get(id);
      return grantIsVisible(record.grantId, view);
    } catch {
      return false;
    }
  };

  const auditIsVisible = async (event: AuditEvent, view: AuthorityView, resources: Set<string>) => {
    if (
      event.action === 'authorize' ||
      event.action.startsWith('resource.') ||
      event.action.startsWith('executable.') ||
      event.action.startsWith('invoke.')
    ) {
      return resources.has(event.target);
    }
    if (event.action.startsWith('grant.')) return grantIsVisible(grantId(event.target), view);
    if (event.action.startsWith('token.')) return tokenIsVisible(tokenId(event.target), view);
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
    while (true) {
      const page = await load({ ...query, cursor, limit: maximumPageLimit } as Q);
      for (const record of page) {
        if (await allowed(record)) records.push(record);
        if (records.length === limit) return records;
      }
      if (page.length < maximumPageLimit) return records;
      cursor = page.at(-1)!.id;
    }
  };

  const childNamed = async (parentId: ResourceId | null, name: string) => {
    let cursor: string | undefined;
    while (true) {
      const page = await repository.resources.list({ parentId, cursor, limit: maximumPageLimit });
      const match = page.find((resource) => resource.name === name);
      if (match) return match;
      if (page.length < maximumPageLimit) return undefined;
      cursor = page.at(-1)!.id;
    }
  };

  const actingGrantRoute = async () => {
    const route: { id: GrantId; name: string }[] = [];
    for (let current: GrantId | null = await actingGrantId(); current;) {
      const grant = await repository.grants.get(current);
      route.unshift({ id: grant.id, name: grant.name });
      current = grant.parentId;
    }
    return route;
  };

  const authorizeGrantCreateRoute = async (path: string) => {
    const requested = pathParts(path);
    const route = await actingGrantRoute();
    const reachesActingGrant =
      requested.length > route.length &&
      route.every((grant, index) => requested[index] === grant.name);
    if (!reachesActingGrant) {
      throw new RgapError(
        'unauthorized',
        'Grant create must follow existing ancestors to the acting grant before creating inside its branch.',
      );
    }
  };

  const authorizeCreateFrom = async (parentId: ResourceId | null, path: string) => {
    let current = parentId;
    for (const name of pathParts(path)) {
      const existing = await childNamed(current, name);
      if (existing) {
        current = existing.id;
        continue;
      }
      if (!current) administrative('Creating a root resource');
      await permit(current, 'write');
      return;
    }
  };

  return {
    resources: {
      async create(input: ResourceWrite) {
        await authorizeCreateFrom(null, input.name);
        return wrapResource(await repository.resources.create(input));
      },
      async get(id) {
        if (!(await visibleResourceIds()).has(id)) throw new RgapError('unauthorized', 'That resource is outside this token\'s view.');
        return wrapResource(await repository.resources.get(id));
      },
      async list(query) {
        const visible = await visibleResourceIds();
        return filtered(query, (page) => repository.resources.list(page), async (resource) => visible.has(resource.id));
      },
    },
    executables: {
      async get(resourceId) {
        await permit(resourceId, 'read');
        return repository.executables.get(resourceId);
      },
      async set(resourceId, input) {
        await permit(resourceId, 'write');
        return repository.executables.set(resourceId, input);
      },
      async delete(resourceId) {
        await permit(resourceId, 'write');
        return repository.executables.delete(resourceId);
      },
    },
    invoke: guardedInvoke,
    grants: {
      async create(input) {
        await authorizeGrantCreateRoute(input.name);
        return wrapGrant(await repository.grants.create(input));
      },
      async get(id) {
        if (!(await grantIsVisible(id))) throw new RgapError('unauthorized', 'That grant is outside this token\'s view.');
        return wrapGrant(await repository.grants.get(id));
      },
      async list(query) {
        const view = await repository.inspectToken(token);
        return filtered(query, (page) => repository.grants.list(page), (grant) => grantIsVisible(grant.id, view));
      },
    },
    tokens: {
      async get(id) {
        if (!(await tokenIsVisible(id))) throw new RgapError('unauthorized', 'That token is outside this token\'s view.');
        return wrapToken(await repository.tokens.get(id));
      },
      async list(query) {
        const view = await repository.inspectToken(token);
        return filtered(query, (page) => repository.tokens.list(page), (record) => grantIsVisible(record.grantId, view));
      },
    },
    audit: {
      async list(query) {
        const view = await repository.inspectToken(token);
        const resources = await visibleResourceIds(view);
        return filtered(query, (page) => repository.audit.list(page), (event) => auditIsVisible(event, view, resources));
      },
    },
    authorize: (bearer, resourceId, permission) => repository.authorize(bearer, resourceId, permission),
    inspectToken: (bearer) => repository.inspectToken(bearer),
    async reset() {
      administrative('Resetting the store');
    },
  };
}
