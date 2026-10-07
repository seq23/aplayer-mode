// Device storage for the intake draft: WEB build (localStorage). The native build uses
// storage.native.ts (expo-sqlite/kv-store, synchronous writes, so a tap is on disk before
// the app can be killed). Metro picks the platform file; both export the same API.
// Every access is guarded: private windows and blocked storage fall back to memory.
const memory = new Map<string, string>();

function local(): Storage | undefined {
  try { return typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage; } catch { return undefined; }
}

export function readSync(key: string): string | null {
  try { const value = local()?.getItem(key); if (value !== undefined && value !== null) return value; } catch { /* fall through */ }
  return memory.get(key) ?? null;
}

export function writeSync(key: string, value: string): void {
  memory.set(key, value);
  try { local()?.setItem(key, value); } catch { /* memory only */ }
}

export function removeSync(key: string): void {
  memory.delete(key);
  try { local()?.removeItem(key); } catch { /* memory only */ }
}

export const STORAGE_KIND = 'web' as const;
