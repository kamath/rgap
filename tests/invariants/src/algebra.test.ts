import { bindingAuthorizes, covers, permissions } from '@rgap/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bindingFromSeed, bindingSeeds, resourceTrees } from './generators';

describe('grant-binding containment algebra', () => {
  it('is reflexive for every valid binding', () => {
    fc.assert(fc.property(
      resourceTrees,
      bindingSeeds,
      (resources, seed) => {
        const binding = bindingFromSeed(resources, seed);
        expect(covers(binding, binding, resources)).toBe(true);
      },
    ));
  });

  it('is transitive', () => {
    fc.assert(fc.property(
      resourceTrees,
      bindingSeeds,
      bindingSeeds,
      bindingSeeds,
      (resources, firstSeed, secondSeed, thirdSeed) => {
        const first = bindingFromSeed(resources, firstSeed);
        const second = bindingFromSeed(resources, secondSeed);
        const third = bindingFromSeed(resources, thirdSeed);

        if (
          covers(first, second, resources) &&
          covers(second, third, resources)
        ) {
          expect(covers(first, third, resources)).toBe(true);
        }
      },
    ));
  });

  it('means every child request is also a parent request', () => {
    fc.assert(fc.property(
      resourceTrees,
      bindingSeeds,
      bindingSeeds,
      (resources, parentSeed, childSeed) => {
        const parent = bindingFromSeed(resources, parentSeed);
        const child = bindingFromSeed(resources, childSeed);
        if (!covers(parent, child, resources)) return;

        for (const resource of Object.values(resources)) {
          for (const permission of permissions) {
            if (
              bindingAuthorizes(
                child,
                resources,
                resource.id,
                permission,
              )
            ) {
              expect(
                bindingAuthorizes(
                  parent,
                  resources,
                  resource.id,
                  permission,
                ),
              ).toBe(true);
            }
          }
        }
      },
    ));
  });
});
