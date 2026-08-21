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

/**
 * Splits a parent path into the deepest resource that exists and the segments that do not.
 * The interface creates each missing segment as its own command before it creates the named resource.
 */
export function planPath(resources: State['resources'], path: string) {
  let parentId: string | null = null;
  const missing: string[] = [];
  for (const segment of segments(path)) {
    if (missing.length) {
      missing.push(segment);
      continue;
    }
    const existing: Resource | undefined = childrenOf(resources, parentId).find((item) => item.name === segment);
    if (existing) parentId = existing.id;
    else missing.push(segment);
  }
  return { parentId, missing };
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

/** Depth-first grant rows, so the delegation tree renders as indented rows. */
export function grantRows(grants: State['grants']) {
  const rows: { grant: Grant; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    Object.values(grants)
      .filter((grant) => grant.parentId === parentId)
      .sort((left, right) => left.name.localeCompare(right.name))
      .forEach((grant) => {
        rows.push({ grant, depth });
        walk(grant.id, depth + 1);
      });
  };
  walk(null, 0);
  return rows;
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
