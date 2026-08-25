import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'
import { tokenValue, type TokenValue } from '@rgap/core'

const algorithm = 'aes-256-gcm'

export class BearerVault {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) {
      throw new Error('Bearer encryption requires a 32-byte key.')
    }
  }

  encrypt(value: TokenValue) {
    const nonce = randomBytes(12)
    const cipher = createCipheriv(algorithm, this.key, nonce)
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()
    return [nonce, tag, ciphertext]
      .map((part) => part.toString('base64url'))
      .join('.')
  }

  decrypt(value: string) {
    const parts = value.split('.')
    if (parts.length !== 3) throw new Error('Encrypted bearer is invalid.')
    const [nonceValue, tagValue, ciphertextValue] = parts
    const decipher = createDecipheriv(
      algorithm,
      this.key,
      Buffer.from(nonceValue!, 'base64url'),
    )
    decipher.setAuthTag(Buffer.from(tagValue!, 'base64url'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue!, 'base64url')),
      decipher.final(),
    ])
    return tokenValue(plaintext.toString('utf8'))
  }
}
