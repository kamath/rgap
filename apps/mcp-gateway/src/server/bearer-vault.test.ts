import { randomBytes } from 'node:crypto'
import { tokenValue } from '@rgap/core'
import { describe, expect, it } from 'vitest'
import { BearerVault } from './bearer-vault'

describe('BearerVault', () => {
  it('round-trips an RGAP bearer without storing plaintext', () => {
    const vault = new BearerVault(randomBytes(32))
    const bearer = tokenValue('rgap_example_secret')
    const encrypted = vault.encrypt(bearer)

    expect(encrypted).not.toContain(bearer)
    expect(vault.decrypt(encrypted)).toBe(bearer)
  })

  it('rejects ciphertext encrypted with another key', () => {
    const encrypted = new BearerVault(randomBytes(32)).encrypt(
      tokenValue('rgap_example_secret'),
    )

    expect(() => new BearerVault(randomBytes(32)).decrypt(encrypted)).toThrow()
  })
})
