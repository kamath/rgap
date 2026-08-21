import { describe, expect, it } from 'vitest'

import {
  createResourceInputSchema,
  rgapRequestSchema,
} from '../src/index.js'

describe('RGAP schemas', () => {
  it('applies safe resource defaults', () => {
    expect(
      createResourceInputSchema.parse({ name: 'alpha', type: 'folder' }),
    ).toEqual({
      name: 'alpha',
      type: 'folder',
      parent_resource_id: null,
      move_policy: 'normal',
      delete_policy: 'revoke',
    })
  })

  it('rejects unknown protocol methods', () => {
    expect(() =>
      rgapRequestSchema.parse({ id: '1', method: 'grant.expand', params: {} }),
    ).toThrow()
  })
})
