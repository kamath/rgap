import {
  grantId,
  isLive,
  normalizePath,
  resourceId,
  resourceIdAtPath,
  resourcePath,
  tryResourcePath,
  type AuthorityView,
  type Capability,
  type Grant,
  type GrantId,
  type Resource,
  type ResourceId,
  type State,
} from '@rgap/core';

export const segments = (path: string) => path.split('/').map((part) => part.trim()).filter(Boolean);
export const canonical = (path: string) => segments(path).join('/');
export const parentPath = (path: string) => segments(path).slice(0, -1).join('/');

/** Resolves a path to a stable resource ID. An empty path, and any path that names nothing, is the tree root. */
export const resolvePath = (resources: State['resources'], path: string) => resourceIdAtPath(resources, path);

export const pathOf = (resources: State['resources'], id: ResourceId) => resourcePath(resources, id);

export function childrenOf(resources: State['resources'], parentId: ResourceId | null): Resource[] {
  return Object.values(resources)
    .filter((resource) => isLive(resource) && resource.parentId === parentId)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Resources the active token may see, including the ancestors that explain their paths. */
export function visibleIds(resources: State['resources'], authority: AuthorityView | null) {
  if (!authority) return null;
  const visible = new Set<string>();
  if (!authority.valid) return visible;
  Object.keys(authority.permissions).forEach((id) => {
    for (let current: ResourceId | null = resourceId(id); current; current = resources[current]?.parentId ?? null) {
      visible.add(current);
    }
  });
  return visible;
}

export const isActive = (record: { expiresAt: string | null; revokedAt: string | null }) =>
  !record.revokedAt && (!record.expiresAt || record.expiresAt > new Date().toISOString());

export const grantStatus = (grant: Grant) =>
  grant.revokedAt ? 'revoked' : isActive(grant) ? 'active' : 'expired';

/**
 * A grant's status within its lineage. An inactive ancestor disables everything beneath it, so a
 * grant that is itself neither revoked nor expired is still inactive when an ancestor is.
 */
export function lineageStatus(grants: State['grants'], grantId: GrantId) {
  const chain = grantLineage(grants, grantId);
  const grant = grants[grantId];
  const own = grant ? grantStatus(grant) : 'missing';
  if (own !== 'active') return own;
  return chain.slice(0, -1).every((ancestor) => grantStatus(ancestor) === 'active') ? 'active' : 'inactive ancestor';
}

/** What a capability entry points at, which is readable even once the resource is gone. */
export function capabilityTarget(resources: State['resources'], capability: Capability) {
  if (capability.target.type === 'path') {
    const path = normalizePath(capability.target.path);
    return {
      type: 'path' as const,
      value: path,
      path,
      state: resourceIdAtPath(resources, path) ? ('live' as const) : ('empty' as const),
    };
  }
  const resource = resources[capability.target.resourceId];
  const path = tryResourcePath(resources, capability.target.resourceId);
  if (!resource || path === null) {
    return { type: 'resource' as const, value: capability.target.resourceId, path: null, state: 'missing' as const };
  }
  return {
    type: 'resource' as const,
    value: capability.target.resourceId,
    path,
    state: isLive(resource) ? ('live' as const) : ('deleted' as const),
  };
}

/** A capability entry as one readable value: what it reaches, and what it may do there. */
export function capabilityLabel(resources: State['resources'], capability: Capability) {
  const target = capabilityTarget(resources, capability);
  const reach = target.path ?? target.value;
  return `${reach}${capability.descendants ? '/…' : ''} ${capability.permissions.join('+')}`;
}

/** Every grant delegated from one grant, which is the extent revoking it would disable. */
export function grantDescendants(grants: State['grants'], grantId: GrantId): Grant[] {
  return childGrants(grants, grantId).flatMap((child) => [child, ...grantDescendants(grants, child.id)]);
}

/** The grants delegated directly from one grant, or the root grants when no grant is given. */
export function childGrants(grants: State['grants'], parentId: GrantId | null): Grant[] {
  return Object.values(grants)
    .filter((grant) => grant.parentId === parentId)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function grantLineage(grants: State['grants'], grantId: GrantId) {
  const chain: Grant[] = [];
  for (let id: GrantId | null = grantId; id; id = grants[id]?.parentId ?? null) {
    const grant = grants[id];
    if (!grant) break;
    chain.unshift(grant);
  }
  return chain;
}

export const isDelegatedFrom = (grants: State['grants'], grantId: GrantId, ancestorId: GrantId) =>
  grantLineage(grants, grantId).some((grant) => grant.id === ancestorId);

/** Grants the active token explains: its own lineage, and everything delegated from its grant. */
export function visibleGrantIds(grants: State['grants'], authority: AuthorityView | null) {
  if (!authority) return null;
  const visible = new Set<string>();
  if (!authority.valid) return visible;
  authority.lineage.forEach((id) => visible.add(id));
  Object.keys(grants).forEach((id) => {
    if (authority.grantId && isDelegatedFrom(grants, grantId(id), authority.grantId)) visible.add(id);
  });
  return visible;
}
