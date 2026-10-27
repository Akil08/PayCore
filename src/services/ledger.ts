import { PoolClient } from 'pg';
import { EXTERNAL_BANK_ID, IN_TRANSIT_ID } from '../config.js';
import { InsufficientFundsError } from '../http/errors.js';

export async function moveMoney(
  client: PoolClient,
  args: {
    fromAccountId: string;
    toAccountId: string;
    amount: number;
    transferId: string | null;
    reason: 'deposit' | 'withdrawal' | 'hold' | 'settle' | 'refund';
  }
): Promise<void> {
  const { fromAccountId, toAccountId, amount, transferId, reason } = args;

  // 1. Insert the two ledger rows (from: -amount, to: +amount)
  
  await client.query(
    `INSERT INTO ledger (account_id, amount, transfer_id, reason)
     VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
    [
      fromAccountId, -amount, transferId, reason,
      toAccountId, amount, transferId, reason
    ]
  );

  // 2. Update balances only for non-system accounts
  const isSystem = (id: string) => id === EXTERNAL_BANK_ID || id === IN_TRANSIT_ID;
  
  if (!isSystem(fromAccountId)) {
    const res = await client.query(
      `UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1`,
      [amount, fromAccountId]
    );
    if (res.rowCount === 0) {
      throw new InsufficientFundsError();
    }
  }

  if (!isSystem(toAccountId)) {
    await client.query(
      `UPDATE accounts SET balance = balance + $1 WHERE id = $2`,
      [amount, toAccountId]
    );
  }
}