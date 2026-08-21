import { isLive, resourceIdAtPath, resourcePath, type AuthorityView, type Grant, type Resource, type State } from '@rgap/core';

export const segments = (path: string) => path.split('/').map((part) => part.trim()).filter(Boolean);
export const canonical = (path: string) => segments(path).join('/');
export const parentPath = (path: string) => segments(path).slice(0, -1).join('/');

/** Resolves a path to a stable resource ID. An empty path, and any path that names nothing, is the tree root. */
export const resolvePath = (resources: State['resources'], path: string) => resourceIdAtPath(resources, path);

export const pathOf = (resources: State['resources'], id: string) => resourcePath(resources, id);

export function childrenOf(resources: State['resources'], parentId: string | null): Resource[] {
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
    for (let current: string | null = id; current; current = resources[current]?.parentId ?? null) {
      visible.add(current);
    }
  });
  return visible;
}

export const isActive = (record: { expiresAt: string | null; revokedAt: string | null }) =>
  !record.revokedAt && (!record.expiresAt || record.expiresAt > new Date().toISOString());

export const grantStatus = (grant: Grant) =>
  grant.revokedAt ? 'revoked' : isActive(grant) ? 'active' : 'expired';

/** The grants delegated directly from one grant, or the root grants when no grant is given. */
export function childGrants(grants: State['grants'], parentId: string | null): Grant[] {
  return Object.values(grants)
    .filter((grant) => grant.parentId === parentId)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function grantLineage(grants: State['grants'], grantId: string) {
  const chain: Grant[] = [];
  for (let id: string | null = grantId; id; id = grants[id]?.parentId ?? null) {
    const grant = grants[id];
    if (!grant) break;
    chain.unshift(grant);
  }
  return chain;
}

export const isDelegatedFrom = (grants: State['grants'], grantId: string, ancestorId: string) =>
  grantLineage(grants, grantId).some((grant) => grant.id === ancestorId);

/** Grants the active token explains: its own lineage, and everything delegated from its grant. */
export function visibleGrantIds(grants: State['grants'], authority: AuthorityView | null) {
  if (!authority) return null;
  const visible = new Set<string>();
  if (!authority.valid) return visible;
  authority.lineage.forEach((id) => visible.add(id));
  Object.keys(grants).forEach((id) => {
    if (authority.grantId && isDelegatedFrom(grants, id, authority.grantId)) visible.add(id);
  });
  return visible;
}
