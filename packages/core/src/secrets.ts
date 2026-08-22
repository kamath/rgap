import { RgapError, type ResourceId } from './domain';

/** A portable, JSON-compatible AES-256-GCM protected value. */
export type SecretEnvelope = {
  ciphertext: string;
  nonce: string;
  tag: string;
  version: string;
  updatedAt: string;
};

export type SecretKey = Uint8Array | CryptoKey;

const nonceBytes = 12;
const tagBytes = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const base64 = (value: Uint8Array) => {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const bytes = (value: string) => {
  try {
    const binary = atob(value);
    const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (base64(decoded) !== value) throw new Error('non-canonical base64');
    return decoded;
  } catch {
    throw new RgapError('invalid_secret_envelope', 'Secret envelope is invalid.');
  }
};

const encryptionKey = async (key: SecretKey, usage: 'encrypt' | 'decrypt') => {
  if (key instanceof Uint8Array) {
    if (key.byteLength !== 32) {
      throw new RgapError('invalid_secret_key', 'Secret key must contain exactly 32 bytes.');
    }
    const raw = new Uint8Array(key.byteLength);
    raw.set(key);
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);
  }
  if (
    key.type !== 'secret'
    || key.algorithm.name !== 'AES-GCM'
    || !key.usages.includes(usage)
  ) {
    throw new RgapError('invalid_secret_key', 'Secret key must be an AES-GCM key permitted for this operation.');
  }
  const length = (key.algorithm as { length?: number }).length;
  if (length !== 256) throw new RgapError('invalid_secret_key', 'Secret key must use 256-bit AES.');
  return key;
};

const authenticatedData = (resourceId: ResourceId, version: string) =>
  encoder.encode(`${resourceId}:${version}`);

/** Encrypts a secret with a fresh 96-bit nonce and resource/version authenticated data. */
export async function encryptSecret(
  key: SecretKey,
  resourceId: ResourceId,
  version: string,
  value: string,
): Promise<SecretEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(nonceBytes));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: authenticatedData(resourceId, version),
      tagLength: tagBytes * 8,
    },
    await encryptionKey(key, 'encrypt'),
    encoder.encode(value),
  ));
  const boundary = encrypted.byteLength - tagBytes;
  return {
    ciphertext: base64(encrypted.slice(0, boundary)),
    nonce: base64(nonce),
    tag: base64(encrypted.slice(boundary)),
    version,
    updatedAt: new Date().toISOString(),
  };
}

/** Decrypts an envelope without exposing Web Crypto's authentication failure details. */
export async function decryptSecret(
  key: SecretKey,
  resourceId: ResourceId,
  envelope: SecretEnvelope,
): Promise<string> {
  try {
    const nonce = bytes(envelope.nonce);
    const ciphertext = bytes(envelope.ciphertext);
    const tag = bytes(envelope.tag);
    if (nonce.byteLength !== nonceBytes || tag.byteLength !== tagBytes) {
      throw new RgapError('invalid_secret_envelope', 'Secret envelope is invalid.');
    }
    const encrypted = new Uint8Array(ciphertext.byteLength + tag.byteLength);
    encrypted.set(ciphertext);
    encrypted.set(tag, ciphertext.byteLength);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: authenticatedData(resourceId, envelope.version),
        tagLength: tagBytes * 8,
      },
      await encryptionKey(key, 'decrypt'),
      encrypted,
    );
    return decoder.decode(plaintext);
  } catch (error) {
    if (error instanceof RgapError && error.code === 'invalid_secret_key') throw error;
    throw new RgapError('invalid_secret_envelope', 'Secret envelope authentication failed.');
  }
}
