import { PoolClient } from 'pg';

export async function enqueueEvent(
  client: PoolClient,
  type: string,
  payload: object
): Promise<void> {
  await client.query(
    `INSERT INTO outbox (event_type, payload) VALUES ($1, $2)`,
    [type, payload]
  );
}