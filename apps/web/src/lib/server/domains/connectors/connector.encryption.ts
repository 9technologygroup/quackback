/**
 * Data-connector secret encryption. Purpose-based key derivation keeps
 * connector secrets isolated from webhook signing secrets and other domains
 * that use lib/server/encryption.ts.
 */
import { encrypt, decrypt } from '@/lib/server/encryption'

const PURPOSE = 'data-connector'

/** Encrypt a connector's auth secret for storage. */
export function encryptConnectorSecret(secret: string): string {
  return encrypt(secret, PURPOSE)
}

/** Decrypt a connector's auth secret. Called only just-in-time, at call execution. */
export function decryptConnectorSecret(ciphertext: string): string {
  return decrypt(ciphertext, PURPOSE)
}
