import {
  covers,
  isPathCapability,
  normalizePath,
  permissions as allPermissions,
  type Capability,
  type Grant,
  type PathCapability,
  type Permission,
  type ResourceCapability,
  type State,
} from '@rgap/core';

type CapabilityTarget = Pick<ResourceCapability, 'resourceId'> | Pick<PathCapability, 'path'>;

/**
 * What a delegating grant permits at one target. A child entry must be covered by a single parent
 * entry, so these bounds narrow what the form can ask for; `uncovered` remains the authority on
 * whether a whole entry is legal.
 */
export function boundsAt(parent: Grant | null, resources: State['resources'], target: CapabilityTarget) {
  if (!parent) return { selectable: true, permissions: [...allPermissions] };
  const candidate = (permissions: Permission[]): Capability => ({ ...target, permissions });
  const allowedPermissions = allPermissions.filter((permission) =>
    parent.capabilities.some((entry) => covers(entry, candidate([permission]), resources)),
  );
  return {
    selectable: allowedPermissions.length > 0,
    permissions: allowedPermissions,
  };
}

/** The reason an entry is not legal, or null when some parent entry covers it. */
export function uncovered(parent: Grant | null, resources: State['resources'], entry: Capability) {
  if (isPathCapability(entry) && !normalizePath(entry.path)) return 'path required';
  if (!entry.permissions.length) return 'no permission';
  if (!parent) return null;
  return parent.capabilities.some((parentEntry) => covers(parentEntry, entry, resources)) ? null : 'not covered';
}

export const withPermission = (held: Permission[], permission: Permission, on: boolean) =>
  on ? [...held, permission] : held.filter((item) => item !== permission);
