import { covers, permissions, resourceAuthorizes } from '@rgap/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { entryFromSeed, entrySeeds, resourceTrees } from './generators';

describe('grant-resource containment algebra', () => {
  it('is reflexive for every valid entry', () => {
    fc.assert(fc.property(
      resourceTrees,
      entrySeeds,
      (resources, seed) => {
        const entry = entryFromSeed(resources, seed);
        expect(covers(entry, entry, resources)).toBe(true);
      },
    ));
  });

  it('is transitive', () => {
    fc.assert(fc.property(
      resourceTrees,
      entrySeeds,
      entrySeeds,
      entrySeeds,
      (resources, firstSeed, secondSeed, thirdSeed) => {
        const first = entryFromSeed(resources, firstSeed);
        const second = entryFromSeed(resources, secondSeed);
        const third = entryFromSeed(resources, thirdSeed);

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
      entrySeeds,
      entrySeeds,
      (resources, parentSeed, childSeed) => {
        const parent = entryFromSeed(resources, parentSeed);
        const child = entryFromSeed(resources, childSeed);
        if (!covers(parent, child, resources)) return;

        for (const resource of Object.values(resources)) {
          for (const permission of permissions) {
            if (
              resourceAuthorizes(
                child,
                resources,
                resource.id,
                permission,
              )
            ) {
              expect(
                resourceAuthorizes(
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
