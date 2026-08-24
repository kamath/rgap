import fc from 'fast-check';
import {
  permissions,
  resourceId,
  type GrantBinding,
  type Permission,
  type Resource,
  type State,
} from '@rgap/core';

export const resourceTrees = fc
  .array(fc.nat(), { minLength: 1, maxLength: 12 })
  .map((parents): State['resources'] => {
    const resources: State['resources'] = {};
    parents.forEach((rawParent, index) => {
      const id = resourceId(`resource-${index}`);
      const parentId = index === 0
        ? null
        : resourceId(`resource-${rawParent % index}`);
      resources[id] = {
        id,
        parentId,
        name: `node-${index}`,
        deletedAt: null,
        executable: null,
      };
    });
    return resources;
  });

export const bindingSeeds = fc.record({
  target: fc.nat(),
  permissionMask: fc.nat(),
});

export type BindingSeed = {
  target: number;
  permissionMask: number;
};

export function bindingFromSeed(
  resources: State['resources'],
  seed: BindingSeed,
): GrantBinding {
  const records = Object.values(resources) as Resource[];
  const target = records[seed.target % records.length];
  const selected = permissions.filter(
    (_, index) => index === 0 || (seed.permissionMask & (1 << index)) !== 0,
  ) as Permission[];

  return { id: target.id, permissions: selected };
}

export type Operation = {
  kind: 'delegate' | 'issue' | 'revoke-grant' | 'revoke-token' | 'amend' | 'move' | 'delete';
  first: number;
  second: number;
  mask: number;
};

export const operations = fc.record({
  kind: fc.constantFrom<Operation['kind']>(
    'delegate',
    'issue',
    'revoke-grant',
    'revoke-token',
    'amend',
    'move',
    'delete',
  ),
  first: fc.nat(),
  second: fc.nat(),
  mask: fc.nat(),
});
