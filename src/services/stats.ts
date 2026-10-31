import { PoolClient } from "pg";

export async function updateStats(
  client: PoolClient,
  senderAccountId: string,
  amount: number,
): Promise<void> {
  await client.query(
    `INSERT INTO user_stats (account_id, txn_count, total_amount, avg_amount, updated_at)
     VALUES ($1, 1, $2, $2, NOW())
     ON CONFLICT (account_id) DO UPDATE
     SET
       txn_count = user_stats.txn_count + 1,
       total_amount = user_stats.total_amount + $2,
       avg_amount = (user_stats.total_amount + $2) / (user_stats.txn_count + 1),
       updated_at = NOW()`,
    [senderAccountId, amount],
  );
}
