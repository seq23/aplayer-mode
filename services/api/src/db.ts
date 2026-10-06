import { Client, type QueryResultRow } from 'pg';
import type { ApiEnv } from './env';
import { requireDatabaseConnectionString } from './env';

export async function withDb<T>(env: ApiEnv, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: requireDatabaseConnectionString(env),
  });

  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function queryOne<T extends QueryResultRow>(
  client: Client,
  text: string,
  values: unknown[] = [],
): Promise<T | null> {
  const result = await client.query<T>(text, values);
  return result.rows[0] ?? null;
}
