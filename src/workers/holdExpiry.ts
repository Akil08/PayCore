import { withTx } from "../db.js";
import { moveMoney } from "../services/ledger.js";
import { enqueueEvent } from "../services/outbox.js";
import { IN_TRANSIT_ID } from "../config.js";

const HOLD_EXPIRY_SECONDS = parseInt(
  process.env.HOLD_EXPIRY_SECONDS || "300",
  10,
);
const EXPIRY_SWEEP_MS = parseInt(process.env.EXPIRY_SWEEP_MS || "30000", 10);

async function runExpirySweep(): Promise<void> {
  await withTx(async (client) => {
    const res = await client.query<{
      id: string;
      sender_account_id: string;
      amount: string;
    }>(
      `
      SELECT id, sender_account_id, amount
      FROM transfers
      WHERE status = 'held' AND created_at < NOW() - make_interval(secs => $1)
      FOR UPDATE SKIP LOCKED
      LIMIT 50
    `,
      [HOLD_EXPIRY_SECONDS],
    );

    for (const row of res.rows) {
      const amount = parseInt(row.amount, 10);

      await moveMoney(client, {
        fromAccountId: IN_TRANSIT_ID,
        toAccountId: row.sender_account_id,
        amount,
        transferId: row.id,
        reason: "refund",
      });

      await client.query(
        `
        UPDATE transfers
        SET status = 'expired', updated_at = NOW()
        WHERE id = $1
      `,
        [row.id],
      );

      await enqueueEvent(client, "transfer.expired", {
        transfer_id: row.id,
        sender_account_id: row.sender_account_id,
        amount,
      });
    }

    if (res.rows.length === 50) {
      setImmediate(runExpirySweep);
    }
  });
}

export function startHoldExpiry(): void {
  const schedule = async (): Promise<void> => {
    try {
      await runExpirySweep();
    } catch (err) {
      console.error("Expiry sweep failed:", err);
    }

    setTimeout(schedule, EXPIRY_SWEEP_MS);
  };

  setTimeout(schedule, EXPIRY_SWEEP_MS);
}
