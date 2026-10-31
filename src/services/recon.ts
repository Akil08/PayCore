import { withTx } from "../db.js";
import { IN_TRANSIT_ID } from "../config.js";

let isReconRunning = false;

export async function runReconciliation(): Promise<{
  ledger_sum: number;
  mismatched_accounts: {
    account_id: string;
    balance: number;
    ledger_sum: number;
  }[];
  in_transit_ledger_sum: number;
  held_sum: number;
  in_transit_ok: boolean;
  stuck_holds: number;
  passed: boolean;
}> {
  if (isReconRunning) {
    throw new Error("Reconciliation already running");
  }
  isReconRunning = true;

  try {
    return await withTx(async (client) => {
      const ledgerSumRes = await client.query<{ ledger_sum: string }>(
        "SELECT COALESCE(SUM(amount), 0)::bigint as ledger_sum FROM ledger",
      );
      const ledger_sum = parseInt(ledgerSumRes.rows[0].ledger_sum, 10);

      const mismatchedRes = await client.query<{
        account_id: string;
        balance: string;
        ledger_sum: string;
      }>(`
        SELECT a.id as account_id, a.balance, COALESCE(SUM(l.amount), 0)::bigint as ledger_sum
        FROM accounts a
        LEFT JOIN ledger l ON a.id = l.account_id
        WHERE a.type = 'user'
        GROUP BY a.id, a.balance
        HAVING a.balance != COALESCE(SUM(l.amount), 0)
      `);
      const mismatched_accounts = mismatchedRes.rows.map((row) => ({
        account_id: row.account_id,
        balance: parseInt(row.balance, 10),
        ledger_sum: parseInt(row.ledger_sum, 10),
      }));

      const inTransitLedgerRes = await client.query<{
        in_transit_ledger_sum: string;
      }>(
        `
        SELECT COALESCE(SUM(amount), 0)::bigint as in_transit_ledger_sum
        FROM ledger
        WHERE account_id = $1
      `,
        [IN_TRANSIT_ID],
      );
      const in_transit_ledger_sum = parseInt(
        inTransitLedgerRes.rows[0].in_transit_ledger_sum,
        10,
      );

      const heldSumRes = await client.query<{ held_sum: string }>(`
        SELECT COALESCE(SUM(amount), 0)::bigint as held_sum
        FROM transfers
        WHERE status = 'held'
      `);
      const held_sum = parseInt(heldSumRes.rows[0].held_sum, 10);

      const in_transit_ok = in_transit_ledger_sum === held_sum;

      const stuckHoldsRes = await client.query<{ stuck_holds: string }>(`
        SELECT COUNT(*)::int as stuck_holds
        FROM transfers
        WHERE status = 'held' AND created_at < NOW() - INTERVAL '15 minutes'
      `);
      const stuck_holds = parseInt(stuckHoldsRes.rows[0].stuck_holds, 10);

      const passed =
        ledger_sum === 0 &&
        mismatched_accounts.length === 0 &&
        in_transit_ok &&
        stuck_holds === 0;

      await client.query(
        `
        INSERT INTO recon_runs (ledger_sum, mismatched_accounts, in_transit_ok, stuck_holds, passed)
        VALUES ($1, $2, $3, $4, $5)
      `,
        [
          ledger_sum,
          mismatched_accounts.length,
          in_transit_ok,
          stuck_holds,
          passed,
        ],
      );

      return {
        ledger_sum,
        mismatched_accounts,
        in_transit_ledger_sum,
        held_sum,
        in_transit_ok,
        stuck_holds,
        passed,
      };
    });
  } finally {
    isReconRunning = false;
  }
}
