import {
  RgapError,
  grantId,
  pathParts,
  permissions,
  bindingAuthorizes,
  tokenId,
  type AuditEvent,
  type BearerContext,
  type GrantBinding,
  type GrantId,
  type Permission,
  type Resource,
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
import {
  withAuthorizedBindings,
  withAuthorizedLineage,
  type SetExecutableInput,
} from './executable';

/**
 * Wraps a repository so each command authorizes the token before it runs.
 *
 * RGAP decides and the host enforces, so repository commands themselves take no token. This guard is
 * the enforced path, stated once here rather than re-derived by every host. Collection reads expose
 * only records in the acting token's resource and delegation views. Handles inherit the same checks.
 */
export function guardCommands(
  repository: RgapRepository,
  token: TokenValue,
  resolveBearer: (token: TokenValue) => Promise<BearerContext>,
): RgapRepository {
  const bearerContext = () => resolveBearer(token);

  const actingGrantId = async () => {
    return (await bearerContext()).grantId;
  };

  const permit = async (id: ResourceId, permission: Permission) => {
    await bearerContext();
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

  const authorizeExecutable = async (input: SetExecutableInput) => {
    const bindings = Object.fromEntries(await Promise.all(
      Object.entries(input.bind ?? {}).map(async ([name, id]) => [
        name,
        (await permit(id, 'bind')).lineage,
      ]),
    ));
    return withAuthorizedBindings(input, bindings);
  };

  const wrapResource = (resource: ResourceHandle): ResourceHandle => ({
    ...resource,
    async create(input) {
      await permit(resource.id, 'write');
      return wrapResource(await resource.create(input.executable
        ? { ...input, executable: await authorizeExecutable(input.executable) }
        : input));
    },
    async move(parentId) {
      await bearerContext();
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
        return resource.executable.set(await authorizeExecutable(input));
      },
      async delete() {
        await permit(resource.id, 'write');
        return resource.executable.delete();
      },
    },
    invoke: (input) => guardedInvoke(resource.id, input),
  });

  const authorizeInvocation = async (id: ResourceId) => (await permit(id, 'invoke')).lineage;

  async function* guardedInvoke(
    id: ResourceId,
    input: Parameters<RgapRepository['invoke']>[1],
  ) {
    const lineage = await authorizeInvocation(id);
    yield* repository.invoke(id, withAuthorizedLineage(input, lineage));
  }

  const wrapGrant = (grant: GrantHandle): GrantHandle => {
    const bindings = Object.assign([...grant.bindings], {
      async set(entries: GrantBinding[]) {
        await bearerContext();
        if (!grant.parentId) administrative("Setting a root grant's bindings");
        if (grant.id === (await actingGrantId())) {
          throw new RgapError('unauthorized', 'A token may not set the bindings of its own grant.');
        }
        await withinActingGrant(grant.id);
        return wrapGrant(await grant.bindings.set(entries));
      },
    });
    return {
      ...grant,
      bindings,
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

  const allResources = async () => {
    const records: Resource[] = [];
    let cursor: string | undefined;
    while (true) {
      const page = await repository.resources.list({ cursor, limit: maximumPageLimit });
      records.push(...page);
      if (page.length < maximumPageLimit) return records;
      cursor = page.at(-1)!.id;
    }
  };

  const visibleResourceIds = async (context?: BearerContext) => {
    const currentContext = context ?? await bearerContext();
    const [resources, grants] = await Promise.all([
      allResources(),
      Promise.all(currentContext.lineage.map((id) => repository.grants.get(id))),
    ]);
    const byId = new Map(resources.map((resource) => [resource.id, resource]));
    const resourceState = Object.fromEntries(resources.map((resource) => [resource.id, resource]));
    const visible = new Set<string>();
    for (const resource of resources) {
      const reached = permissions.some((permission) =>
        grants.every((grant) =>
          grant.bindings.some((binding) => bindingAuthorizes(binding, resourceState, resource.id, permission))
        )
      );
      if (!reached) continue;
      for (let current: ResourceId | null = resource.id; current;) {
        if (visible.has(current)) break;
        visible.add(current);
        current = byId.get(current)?.parentId ?? null;
      }
    }
    return visible;
  };

  const grantIsVisible = async (id: GrantId, context?: BearerContext) => {
    const currentContext = context ?? await bearerContext();
    if (currentContext.lineage.includes(id)) return true;
    try {
      for (let current: GrantId | null = id; current;) {
        if (current === currentContext.grantId) return true;
        current = (await repository.grants.get(current)).parentId;
      }
    } catch {
      return false;
    }
    return false;
  };

  const tokenIsVisible = async (id: TokenHandle['id'], context?: BearerContext) => {
    const currentContext = context ?? await bearerContext();
    try {
      const record = await repository.tokens.get(id);
      return grantIsVisible(record.grantId, currentContext);
    } catch {
      return false;
    }
  };

  const auditIsVisible = async (event: AuditEvent, context: BearerContext, resources: Set<string>) => {
    if (
      event.action === 'authorize' ||
      event.action.startsWith('resource.') ||
      event.action.startsWith('executable.') ||
      event.action.startsWith('invoke.')
    ) {
      return resources.has(event.target);
    }
    if (event.action.startsWith('grant.')) return grantIsVisible(grantId(event.target), context);
    if (event.action.startsWith('token.')) return tokenIsVisible(tokenId(event.target), context);
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
        await bearerContext();
        await authorizeCreateFrom(null, input.name);
        return wrapResource(await repository.resources.create(input.executable
          ? { ...input, executable: await authorizeExecutable(input.executable) }
          : input));
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
        return repository.executables.set(resourceId, await authorizeExecutable(input));
      },
      async delete(resourceId) {
        await permit(resourceId, 'write');
        return repository.executables.delete(resourceId);
      },
    },
    invoke: guardedInvoke,
    grants: {
      async create(input) {
        await bearerContext();
        await authorizeGrantCreateRoute(input.name);
        return wrapGrant(await repository.grants.create(input));
      },
      async get(id) {
        if (!(await grantIsVisible(id))) throw new RgapError('unauthorized', 'That grant is outside this token\'s view.');
        return wrapGrant(await repository.grants.get(id));
      },
      async list(query) {
        const context = await bearerContext();
        return filtered(query, (page) => repository.grants.list(page), (grant) => grantIsVisible(grant.id, context));
      },
    },
    tokens: {
      async get(id) {
        if (!(await tokenIsVisible(id))) throw new RgapError('unauthorized', 'That token is outside this token\'s view.');
        return wrapToken(await repository.tokens.get(id));
      },
      async list(query) {
        const context = await bearerContext();
        return filtered(query, (page) => repository.tokens.list(page), (record) => grantIsVisible(record.grantId, context));
      },
    },
    audit: {
      async list(query) {
        const context = await bearerContext();
        const resources = await visibleResourceIds(context);
        return filtered(query, (page) => repository.audit.list(page), (event) => auditIsVisible(event, context, resources));
      },
    },
    async authorize(bearer, resourceId, permission) {
      await bearerContext();
      return repository.authorize(bearer, resourceId, permission);
    },
    async reset() {
      await bearerContext();
      administrative('Resetting the store');
    },
  };
}
