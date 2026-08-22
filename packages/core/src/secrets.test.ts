import { describe, expect, it } from 'vitest';
import { resourceId, RgapError } from './domain';
import { decryptSecret, encryptSecret, type SecretEnvelope } from './secrets';

const id = resourceId('provider-key');
const key = (fill = 7) => new Uint8Array(32).fill(fill);

describe('universal secret envelopes', () => {
  it('round-trips Unicode plaintext in portable fields with fresh nonces', async () => {
    const first = await encryptSecret(key(), id, 'one', 'sëcret 🔐');
    const second = await encryptSecret(key(), id, 'one', 'sëcret 🔐');

    expect(await decryptSecret(key(), id, first)).toBe('sëcret 🔐');
    expect(first).toEqual({
      ciphertext: expect.any(String),
      nonce: expect.any(String),
      tag: expect.any(String),
      version: 'one',
      updatedAt: expect.any(String),
    });
    expect(first.nonce).not.toBe(second.nonce);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it('accepts an AES-256-GCM CryptoKey with the required usage', async () => {
    const cryptoKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    const envelope = await encryptSecret(cryptoKey, id, 'one', '');
    expect(await decryptSecret(cryptoKey, id, envelope)).toBe('');
  });

  it('rejects raw keys that are not exactly 256 bits', async () => {
    await expect(encryptSecret(new Uint8Array(31), id, 'one', 'value'))
      .rejects.toMatchObject({
        name: 'RgapError',
        code: 'invalid_secret_key',
        message: 'Secret key must contain exactly 32 bytes.',
      });
    await expect(decryptSecret(new Uint8Array(33), id, envelope()))
      .rejects.toMatchObject({ code: 'invalid_secret_key' });
  });

  it('rejects incompatible CryptoKeys without leaking crypto errors', async () => {
    const hmac = await crypto.subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const aes128 = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 128 },
      false,
      ['encrypt'],
    );
    const encryptOnly = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );
    const { publicKey } = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    );

    await expect(encryptSecret(hmac, id, 'one', 'value'))
      .rejects.toMatchObject({ code: 'invalid_secret_key' });
    await expect(encryptSecret(publicKey, id, 'one', 'value'))
      .rejects.toMatchObject({ code: 'invalid_secret_key' });
    await expect(encryptSecret(aes128, id, 'one', 'value'))
      .rejects.toMatchObject({ code: 'invalid_secret_key' });
    await expect(decryptSecret(encryptOnly, id, envelope()))
      .rejects.toMatchObject({ code: 'invalid_secret_key' });
  });

  it('authenticates resource ID and version and rejects altered ciphertext or tag', async () => {
    const protectedValue = await encryptSecret(key(), id, 'one', 'value');
    const alteredCiphertext = {
      ...protectedValue,
      ciphertext: flipFirstByte(protectedValue.ciphertext),
    };
    const alteredTag = { ...protectedValue, tag: flipFirstByte(protectedValue.tag) };

    for (const attempt of [
      decryptSecret(key(), resourceId('other'), protectedValue),
      decryptSecret(key(), id, { ...protectedValue, version: 'two' }),
      decryptSecret(key(), id, alteredCiphertext),
      decryptSecret(key(), id, alteredTag),
      decryptSecret(key(8), id, protectedValue),
    ]) {
      await expect(attempt).rejects.toEqual(
        new RgapError('invalid_secret_envelope', 'Secret envelope authentication failed.'),
      );
    }
  });

  it('rejects malformed, non-canonical, and incorrectly sized envelope fields safely', async () => {
    for (const invalid of [
      { ...envelope(), nonce: '***' },
      { ...envelope(), ciphertext: 'AA' },
      { ...envelope(), nonce: btoa('short') },
      { ...envelope(), tag: btoa('short') },
    ]) {
      await expect(decryptSecret(key(), id, invalid))
        .rejects.toMatchObject({
          code: 'invalid_secret_envelope',
          message: 'Secret envelope authentication failed.',
        });
    }
  });
});

const envelope = (): SecretEnvelope => ({
  ciphertext: '',
  nonce: btoa('\0'.repeat(12)),
  tag: btoa('\0'.repeat(16)),
  version: 'one',
  updatedAt: '2026-08-22T00:00:00.000Z',
});

const flipFirstByte = (encoded: string) => {
  const binary = atob(encoded);
  return btoa(String.fromCharCode(binary.charCodeAt(0) ^ 1) + binary.slice(1));
};
