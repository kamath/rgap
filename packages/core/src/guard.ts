import {
  RgapError,
  grantId,
  resourceId,
  tokenId,
  type AuditEvent,
  type AuthorityView,
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
      async revisions() {
        await permit(resource.id, 'read');
        return resource.executable.revisions();
      },
      async publish(input) {
        await permit(resource.id, 'write');
        return resource.executable.publish(input);
      },
      async delete() {
        await permit(resource.id, 'write');
        return resource.executable.delete();
      },
    },
    secret: {
      async metadata() {
        await permit(resource.id, 'read');
        return resource.secret.metadata();
      },
      async write(value) {
        await permit(resource.id, 'write');
        return resource.secret.write(value);
      },
      async delete() {
        await permit(resource.id, 'write');
        return resource.secret.delete();
      },
    },
    async runtimePrivateMetadata(runtime) {
      await permit(resource.id, 'read');
      return resource.runtimePrivateMetadata(runtime);
    },
    invoke: (input) => guardedInvoke(resource.id, input),
  });

  const authorizeInvocation = async (id: ResourceId, input: Parameters<RgapRepository['invoke']>[1]) => {
    const invocation = await permit(id, 'invoke');
    for (const boundId of Object.values(input.bindings ?? {})) await permit(boundId, 'use');
    const definition = await repository.executables.get(id);
    const revisionId = input.revisionId ?? definition?.activeRevisionId;
    const revision = revisionId ? await repository.executables.getRevision(revisionId) : undefined;
    if (revision?.resourceId === id) {
      for (const [slot, boundId] of Object.entries(input.bindings ?? {})) {
        if (revision.bindingSchema[slot]?.access === 'write') await permit(boundId, 'write');
      }
    }
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
      event.action.startsWith('secret.') ||
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

  return {
    resources: {
      async create() {
        administrative('Creating a root resource');
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
      async getRevision(id) {
        const revision = await repository.executables.getRevision(id);
        if (!revision) return undefined;
        await permit(revision.resourceId, 'read');
        return revision;
      },
      async revisions(resourceId) {
        await permit(resourceId, 'read');
        return repository.executables.revisions(resourceId);
      },
      async publish(resourceId, input) {
        await permit(resourceId, 'write');
        return repository.executables.publish(resourceId, input);
      },
      async delete(resourceId) {
        await permit(resourceId, 'write');
        return repository.executables.delete(resourceId);
      },
    },
    secrets: {
      async metadata(resourceId) {
        await permit(resourceId, 'read');
        return repository.secrets.metadata(resourceId);
      },
      async write(resourceId, value) {
        await permit(resourceId, 'write');
        return repository.secrets.write(resourceId, value);
      },
      async delete(resourceId) {
        await permit(resourceId, 'write');
        return repository.secrets.delete(resourceId);
      },
    },
    async runtimePrivateMetadata(runtime, resourceId) {
      await permit(resourceId, 'read');
      return repository.runtimePrivateMetadata(runtime, resourceId);
    },
    invoke: guardedInvoke,
    grants: {
      async create(input) {
        const parent = wrapGrant(await repository.grants.get(await actingGrantId()));
        return parent.create(input);
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
