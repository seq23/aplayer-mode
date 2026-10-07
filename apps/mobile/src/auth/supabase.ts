import { AppState, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const supabasePublishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const CHUNK_SIZE = 1800;

interface StoredMeta {
  count: number;
}

const secureStorage = {
  async getItem(key: string): Promise<string | null> {
    const rawMeta = await SecureStore.getItemAsync(`${key}:meta`);
    if (!rawMeta) return null;

    const meta = JSON.parse(rawMeta) as StoredMeta;
    const chunks = await Promise.all(
      Array.from({ length: meta.count }, (_, index) => SecureStore.getItemAsync(`${key}:${index}`)),
    );

    if (chunks.some((chunk) => chunk == null)) {
      await secureStorage.removeItem(key);
      return null;
    }

    return chunks.join('');
  },

  async setItem(key: string, value: string): Promise<void> {
    const previousMetaRaw = await SecureStore.getItemAsync(`${key}:meta`);
    const previousMeta = previousMetaRaw ? (JSON.parse(previousMetaRaw) as StoredMeta) : null;
    const chunks = value.match(new RegExp(`.{1,${CHUNK_SIZE}}`, 'gs')) ?? [''];

    await Promise.all(
      chunks.map((chunk, index) =>
        SecureStore.setItemAsync(`${key}:${index}`, chunk, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED,
        }),
      ),
    );

    await SecureStore.setItemAsync(`${key}:meta`, JSON.stringify({ count: chunks.length }), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED,
    });

    if (previousMeta && previousMeta.count > chunks.length) {
      await Promise.all(
        Array.from({ length: previousMeta.count - chunks.length }, (_, index) =>
          SecureStore.deleteItemAsync(`${key}:${chunks.length + index}`),
        ),
      );
    }
  },

  async removeItem(key: string): Promise<void> {
    const rawMeta = await SecureStore.getItemAsync(`${key}:meta`);
    const meta = rawMeta ? (JSON.parse(rawMeta) as StoredMeta) : null;

    if (meta) {
      await Promise.all(
        Array.from({ length: meta.count }, (_, index) => SecureStore.deleteItemAsync(`${key}:${index}`)),
      );
    }

    await SecureStore.deleteItemAsync(`${key}:meta`);
  },
};

export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl && supabasePublishableKey);
}

let client: SupabaseClient | null = null;
let autoRefreshRegistered = false;

export function getSupabaseClient(): SupabaseClient {
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error('Account configuration is not configured on this build');
  }

  if (!client) {
    client = createClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        ...(Platform.OS !== 'web' ? { storage: secureStorage } : {}),
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
        // PKCE: Google sign-in returns a code the app exchanges itself (docs/34 §5).
        flowType: 'pkce',
      },
    });
  }

  if (!autoRefreshRegistered && Platform.OS !== 'web') {
    autoRefreshRegistered = true;
    AppState.addEventListener('change', (state) => {
      if (!client) return;
      if (state === 'active') {
        void client.auth.startAutoRefresh();
      } else {
        void client.auth.stopAutoRefresh();
      }
    });
  }

  return client;
}
