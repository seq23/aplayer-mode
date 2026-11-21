import type { ApiEnv } from './env';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function credentialKey(env: ApiEnv): Promise<CryptoKey> {
  if (!env.CONNECTOR_CREDENTIAL_KEY) throw new Error('Connector credential encryption is not configured');
  const raw = base64ToBytes(env.CONNECTOR_CREDENTIAL_KEY);
  if (raw.byteLength !== 32) throw new Error('CONNECTOR_CREDENTIAL_KEY must be a base64-encoded 32-byte key');
  return crypto.subtle.importKey('raw', asArrayBuffer(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptConnectorCredential(env: ApiEnv, value: unknown): Promise<{ ciphertext: string; iv: string }> {
  const key = await credentialKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(iv) },
    key,
    asArrayBuffer(plaintext),
  );
  return { ciphertext: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}

export async function decryptConnectorCredential<T>(env: ApiEnv, ciphertext: string, iv: string): Promise<T> {
  const key = await credentialKey(env);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(base64ToBytes(iv)) },
    key,
    asArrayBuffer(base64ToBytes(ciphertext)),
  );
  return JSON.parse(decoder.decode(decrypted)) as T;
}
