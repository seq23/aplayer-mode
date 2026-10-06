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

async function stateKey(env: ApiEnv): Promise<CryptoKey> {
  if (!env.OAUTH_STATE_SECRET) throw new Error('OAuth state signing is not configured');
  return crypto.subtle.importKey(
    'raw',
    asArrayBuffer(encoder.encode(env.OAUTH_STATE_SECRET)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function createOAuthState(env: ApiEnv, payload: Record<string, unknown>): Promise<string> {
  const encoded = bytesToBase64(encoder.encode(JSON.stringify({ ...payload, exp: Date.now() + 10 * 60_000 })))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', await stateKey(env), asArrayBuffer(encoder.encode(encoded))),
  );
  const sig = bytesToBase64(signature).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `${encoded}.${sig}`;
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  return base64ToBytes(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
}

export async function verifyOAuthState<T extends { exp: number }>(env: ApiEnv, state: string): Promise<T> {
  const [encoded, signature] = state.split('.');
  if (!encoded || !signature) throw new Error('invalid_oauth_state');
  const valid = await crypto.subtle.verify(
    'HMAC',
    await stateKey(env),
    asArrayBuffer(fromBase64Url(signature)),
    asArrayBuffer(encoder.encode(encoded)),
  );
  if (!valid) throw new Error('invalid_oauth_state');
  const payload = JSON.parse(decoder.decode(fromBase64Url(encoded))) as T;
  if (!payload.exp || payload.exp < Date.now()) throw new Error('expired_oauth_state');
  return payload;
}
