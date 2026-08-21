import {
  covers,
  isWithin,
  permissions as allPermissions,
  type Capability,
  type Grant,
  type Permission,
  type RelocationPolicy,
  type State,
} from '@rgap/core';

export const relocationPolicies: RelocationPolicy[] = ['deny_move', 'revoke_on_scope_exit', 'follow_resource'];

/**
 * What a delegating grant permits at one resource. A child entry must be covered by a single parent
 * entry, so these bounds narrow what the form can ask for; `uncovered` remains the authority on
 * whether a whole entry is legal.
 */
export function boundsAt(parent: Grant | null, resources: State['resources'], resourceId: string) {
  if (!parent) {
    return { selectable: true, permissions: [...allPermissions], relocations: relocationPolicies, descendants: true };
  }
  const reaching = parent.capabilities.filter(
    (entry) => entry.resourceId === resourceId || (entry.descendants && isWithin(resources, resourceId, entry.resourceId)),
  );
  const rank = Math.max(-1, ...reaching.map((entry) => relocationPolicies.indexOf(entry.relocation)));
  return {
    selectable: reaching.length > 0,
    permissions: allPermissions.filter((permission) => reaching.some((entry) => entry.permissions.includes(permission))),
    relocations: relocationPolicies.slice(0, rank + 1),
    descendants: reaching.some((entry) => entry.descendants),
  };
}

/** The reason an entry is not legal, or null when some parent entry covers it. */
export function uncovered(parent: Grant | null, resources: State['resources'], entry: Capability) {
  if (!entry.permissions.length) return 'no permission';
  if (!parent) return null;
  return parent.capabilities.some((parentEntry) => covers(parentEntry, entry, resources)) ? null : 'not covered';
}

export const withPermission = (held: Permission[], permission: Permission, on: boolean) =>
  on ? [...held, permission] : held.filter((item) => item !== permission);
