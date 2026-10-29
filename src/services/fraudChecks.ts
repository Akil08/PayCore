import { PoolClient } from 'pg';

export const VELOCITY_LIMIT = 10;
export const VELOCITY_WINDOW_SEC = 60;
export const ANOMALY_MULTIPLIER = 5;
export const ANOMALY_MIN_HISTORY = 5;

export async function runChecks(
  client: PoolClient,
  { senderAccountId, receiverAccountId, amount }: { senderAccountId: string; receiverAccountId: string; amount: number }
): Promise<{ ok: true } | { ok: false; failedCheck: string }> {
  // Q1: Sender status and balance
  const senderRes = await client.query(
    'SELECT status, balance FROM accounts WHERE id = $1',
    [senderAccountId]
  );
  if (senderRes.rows.length === 0 || senderRes.rows[0].status !== 'active') {
    return { ok: false, failedCheck: 'sender_status' };
  }
  if (senderRes.rows[0].balance < amount) {
    return { ok: false, failedCheck: 'insufficient_balance' };
  }

  // Q2: Receiver validity and status
  const receiverRes = await client.query(
    'SELECT type, status FROM accounts WHERE id = $1',
    [receiverAccountId]
  );
  if (receiverRes.rows.length === 0 || receiverRes.rows[0].type !== 'user') {
    return { ok: false, failedCheck: 'receiver_invalid' };
  }
  if (receiverRes.rows[0].status !== 'active') {
    return { ok: false, failedCheck: 'receiver_status' };
  }

  // Q3: Velocity check
  const velocityRes = await client.query(
    `SELECT COUNT(*) as count FROM transfers 
     WHERE sender_account_id = $1 AND created_at > NOW() - INTERVAL '${VELOCITY_WINDOW_SEC} seconds'`,
    [senderAccountId]
  );
  if (parseInt(velocityRes.rows[0].count, 10) >= VELOCITY_LIMIT) {
    return { ok: false, failedCheck: 'velocity' };
  }

  // Q4: Amount anomaly check
  const statsRes = await client.query(
    'SELECT txn_count, avg_amount FROM user_stats WHERE account_id = $1',
    [senderAccountId]
  );
  if (statsRes.rows.length > 0) {
    const { txn_count, avg_amount } = statsRes.rows[0];
    if (txn_count >= ANOMALY_MIN_HISTORY && amount > ANOMALY_MULTIPLIER * avg_amount) {
      return { ok: false, failedCheck: 'amount_anomaly' };
    }
  }

  // Q5: Cluster check
  const clusterRes = await client.query(
    'SELECT flagged FROM account_clusters WHERE account_id = $1',
    [senderAccountId]
  );
  if (clusterRes.rows.length > 0 && clusterRes.rows[0].flagged === true) {
    return { ok: false, failedCheck: 'cluster' };
  }

  return { ok: true };
}