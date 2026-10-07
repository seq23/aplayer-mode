// Device storage for the intake draft: iOS / Android. expo-sqlite/kv-store writes
// synchronously (setItemSync), so an answer is on disk before the app can be killed
// (docs/34 §5.1, §6 rule 2). The web build uses storage.ts (localStorage).
import Storage from 'expo-sqlite/kv-store';

const memory = new Map<string, string>();

export function readSync(key: string): string | null {
  try { return Storage.getItemSync(key) ?? memory.get(key) ?? null; } catch { return memory.get(key) ?? null; }
}

export function writeSync(key: string, value: string): void {
  memory.set(key, value);
  try { Storage.setItemSync(key, value); } catch { /* memory only; the server copy still syncs */ }
}

export function removeSync(key: string): void {
  memory.delete(key);
  try { Storage.removeItemSync(key); } catch { /* ignore */ }
}

export const STORAGE_KIND = 'native' as const;
