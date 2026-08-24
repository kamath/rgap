import {
  createAtPath,
  createGrant,
  deleteResource,
  grantId,
  permissions,
  recordToken,
  resourceId,
  revokeGrant,
  revokeToken,
  setBindings,
  tokenHash,
  tokenId,
  updateResource,
  type GrantBinding,
  type State,
} from '@rgap/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Operation, operations } from './generators';
import { assertStateInvariants, testTime } from './invariants';

const future = '2027-08-24T03:00:00.000Z';

function initialState() {
  let state: State = {
    resources: {},
    grants: {},
    tokens: {},
    audit: [],
  };
  state = createAtPath(state, 'acme/docs/design', null, testTime);
  state = createAtPath(state, 'acme/tools/search', null, testTime);
  state = createAtPath(state, 'acme/finance/payroll', null, testTime);
  state = createGrant(state, {
    name: 'company',
    parentId: null,
    bindings: [{
      id: resourceId('acme'),
      permissions: [...permissions],
    }],
    expiresAt: future,
  }, grantId('company'), testTime);
  return recordToken(state, {
    id: tokenId('company-token'),
    grantId: grantId('company'),
    label: 'company',
    hash: tokenHash('company-token'),
    expiresAt: future,
    revokedAt: null,
  }, testTime);
}

const active = (
  item: { revokedAt: string | null; expiresAt: string | null },
) => item.revokedAt === null &&
  (item.expiresAt === null || item.expiresAt > testTime);

const choose = <T>(items: T[], index: number) =>
  items.length ? items[index % items.length] : undefined;

function narrowed(binding: GrantBinding, mask: number): GrantBinding {
  const selected = binding.permissions.filter(
    (permission, index) => permission === 'read' || (mask & (1 << index)) !== 0,
  );
  return { id: binding.id, permissions: selected };
}

function applyOperation(state: State, operation: Operation, step: number) {
  const grants = Object.values(state.grants);
  const activeGrants = grants.filter(active);
  const tokens = Object.values(state.tokens);
  const liveResources = Object.values(state.resources)
    .filter((resource) => resource.deletedAt === null);

  switch (operation.kind) {
    case 'delegate': {
      const parent = choose(activeGrants, operation.first);
      if (!parent) return state;
      const binding = choose(parent.bindings, operation.second);
      const id = grantId(`delegated-${step}`);
      let next = createGrant(state, {
        name: `delegated-${step}`,
        parentId: parent.id,
        bindings: binding ? [narrowed(binding, operation.mask)] : [],
        expiresAt: parent.expiresAt,
      }, id, testTime);
      next = recordToken(next, {
        id: tokenId(`delegated-token-${step}`),
        grantId: id,
        label: `delegated-${step}`,
        hash: tokenHash(`delegated-token-${step}`),
        expiresAt: parent.expiresAt,
        revokedAt: null,
      }, testTime);
      return next;
    }
    case 'issue': {
      const grant = choose(activeGrants, operation.first);
      if (!grant) return state;
      return recordToken(state, {
        id: tokenId(`issued-token-${step}`),
        grantId: grant.id,
        label: `issued-${step}`,
        hash: tokenHash(`issued-token-${step}`),
        expiresAt: grant.expiresAt,
        revokedAt: null,
      }, testTime);
    }
    case 'revoke-grant': {
      const grant = choose(grants, operation.first);
      return grant ? revokeGrant(state, grant.id, testTime) : state;
    }
    case 'revoke-token': {
      const token = choose(tokens, operation.first);
      return token ? revokeToken(state, token.id, testTime) : state;
    }
    case 'amend': {
      const grant = choose(activeGrants, operation.first);
      if (!grant) return state;
      const binding = choose(grant.bindings, operation.second);
      const bindings = operation.mask % 3 === 0 || !binding
        ? []
        : [narrowed(binding, operation.mask)];
      return setBindings(state, grant.id, bindings, testTime);
    }
    case 'move': {
      const resource = choose(liveResources, operation.first);
      if (!resource) return state;
      const destination = operation.mask % 4 === 0
        ? null
        : choose(liveResources, operation.second)?.id ?? null;
      return updateResource(state, resource.id, { parentId: destination }, testTime);
    }
    case 'delete': {
      const resource = choose(liveResources, operation.first);
      return resource ? deleteResource(state, resource.id, testTime) : state;
    }
  }
}

describe('generated RGAP state transitions', () => {
  it('preserves delegation invariants after every transition', () => {
    fc.assert(fc.property(
      fc.array(operations, { maxLength: 40 }),
      (trace) => {
        let state = initialState();
        assertStateInvariants(state);

        trace.forEach((operation, step) => {
          const before = structuredClone(state);
          try {
            state = applyOperation(state, operation, step);
          } catch {
            expect(state).toEqual(before);
          }
          assertStateInvariants(state);
        });
      },
    ), { numRuns: 100 });
  });

  it('rejects a child that outlives its parent without changing state', () => {
    const state = initialState();
    const before = structuredClone(state);

    expect(() => createGrant(state, {
      name: 'unbounded',
      parentId: grantId('company'),
      bindings: [],
      expiresAt: null,
    }, grantId('unbounded'), testTime)).toThrow('must not exceed');
    expect(state).toEqual(before);
  });
});
