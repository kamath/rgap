import {
  authorize,
  permissions,
  resourceAuthorizes,
  stateIntegrity,
  tokenHash,
  tokenId,
  type Grant,
  type GrantId,
  type State,
} from '@rgap/core';

export const testTime = '2026-08-24T03:00:00.000Z';

const isActive = (
  item: { revokedAt: string | null; expiresAt: string | null },
  at = testTime,
) => item.revokedAt === null && (item.expiresAt === null || item.expiresAt > at);

function ancestors(state: State, grant: Grant) {
  const result: Grant[] = [];
  const seen = new Set<GrantId>();
  let current: Grant | undefined = grant;
  while (current) {
    if (seen.has(current.id)) {
      throw new Error(`grant cycle at ${current.id}`);
    }
    seen.add(current.id);
    result.push(current);
    current = current.parentId ? state.grants[current.parentId] : undefined;
  }
  return result;
}

function decisionForGrant(
  state: State,
  grantId: GrantId,
  resourceId: Parameters<typeof authorize>[2],
  permission: Parameters<typeof authorize>[3],
) {
  const hash = tokenHash(`formal-${grantId}`);
  const modeled = structuredClone(state);
  modeled.tokens[`formal-${grantId}`] = {
    id: tokenId(`formal-${grantId}`),
    grantId,
    label: 'invariant probe',
    hash,
    expiresAt: modeled.grants[grantId].expiresAt,
    revokedAt: null,
  };
  return authorize(modeled, hash, resourceId, permission, testTime);
}

export function assertStateInvariants(state: State) {
  const integrity = stateIntegrity(state);
  if (integrity.length) {
    throw new Error(integrity.join('\n'));
  }

  for (const grant of Object.values(state.grants)) {
    const chain = ancestors(state, grant);
    if (grant.parentId && chain.length < 2) {
      throw new Error(`grant ${grant.id} has no parent`);
    }

    const parent = grant.parentId ? state.grants[grant.parentId] : undefined;
    if (parent) {
      if (
        parent.expiresAt !== null &&
        (grant.expiresAt === null || grant.expiresAt > parent.expiresAt)
      ) {
        throw new Error(`grant ${grant.id} outlives ${parent.id}`);
      }
      if (isActive(grant) && !isActive(parent)) {
        throw new Error(`active grant ${grant.id} has an inactive parent`);
      }

      if (isActive(grant) && isActive(parent)) {
        for (const resource of Object.values(state.resources)) {
          if (resource.deletedAt) continue;
          for (const permission of permissions) {
            const child = decisionForGrant(
              state,
              grant.id,
              resource.id,
              permission,
            );
            if (
              child.allowed &&
              !decisionForGrant(
                state,
                parent.id,
                resource.id,
                permission,
              ).allowed
            ) {
              throw new Error(
                `${grant.id} exceeds ${parent.id} at ${resource.id}:${permission}`,
              );
            }
          }
        }
      }
    }

    if (grant.revokedAt) {
      for (const candidate of Object.values(state.grants)) {
        if (
          candidate.id !== grant.id &&
          ancestors(state, candidate).some((item) => item.id === grant.id) &&
          candidate.revokedAt === null
        ) {
          throw new Error(
            `revoked grant ${grant.id} has live descendant ${candidate.id}`,
          );
        }
      }
    }

    if (isActive(grant)) {
      for (const resource of Object.values(state.resources)) {
        if (resource.deletedAt) continue;
        for (const permission of permissions) {
          const decision = decisionForGrant(
            state,
            grant.id,
            resource.id,
            permission,
          );
          if (decision.allowed) {
            for (const member of chain) {
              if (
                !member.resources.some((entry) =>
                  resourceAuthorizes(
                    entry,
                    state.resources,
                    resource.id,
                    permission,
                  )
                )
              ) {
                throw new Error(
                  `allowed request is absent from ancestor ${member.id}`,
                );
              }
            }
          }
        }
      }
    }
  }
}
