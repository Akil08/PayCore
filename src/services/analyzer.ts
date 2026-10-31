import { PoolClient } from "pg";
import { freezeAccount } from "./accountActions.js";
import { EXTERNAL_BANK_ID, IN_TRANSIT_ID } from "../config.js";

interface TriggerEvent {
  type: string;
  payload: any;
}

export async function analyzeAccount(
  client: PoolClient,
  accountId: string,
  triggerEvent: TriggerEvent,
): Promise<void> {
  // Analyzer never touches system accounts
  if (accountId === EXTERNAL_BANK_ID || accountId === IN_TRANSIT_ID) {
    return;
  }

  const signalsToFire: Array<{ kind: string; severity: number; detail: any }> =
    [];

  if (triggerEvent.type === "transfer.declined") {
    const fc = triggerEvent.payload.failed_check;
    if (fc === "velocity") {
      signalsToFire.push({
        kind: "velocity",
        severity: 2,
        detail: { failed_check: fc },
      });
    }
    if (fc === "amount_anomaly") {
      signalsToFire.push({
        kind: "amount_anomaly",
        severity: 1,
        detail: { failed_check: fc },
      });
    }

    // Check repeat declines
    const declineRes = await client.query(
      "SELECT COUNT(*) as count FROM transfers WHERE sender_account_id = $1 AND status = 'declined' AND created_at > NOW() - INTERVAL '10 minutes'",
      [accountId],
    );
    if (parseInt(declineRes.rows[0].count, 10) >= 3) {
      signalsToFire.push({ kind: "repeat_declines", severity: 2, detail: {} });
    }
  }

  if (
    triggerEvent.type === "stats.done" ||
    triggerEvent.type === "graph.done"
  ) {
    // Check cluster
    const clusterRes = await client.query(
      "SELECT flagged FROM account_clusters WHERE account_id = $1",
      [accountId],
    );
    if (clusterRes.rows.length > 0 && clusterRes.rows[0].flagged) {
      signalsToFire.push({ kind: "cluster", severity: 3, detail: {} });
    }
  }

  // Fire signals with 5-minute deduplication
  for (const sig of signalsToFire) {
    const exists = await client.query(
      "SELECT 1 FROM signals WHERE account_id = $1 AND kind = $2 AND created_at > NOW() - INTERVAL '5 minutes'",
      [accountId, sig.kind],
    );
    if (exists.rowCount === 0) {
      await client.query(
        "INSERT INTO signals (account_id, kind, severity, detail) VALUES ($1, $2, $3, $4)",
        [accountId, sig.kind, sig.severity, JSON.stringify(sig.detail)],
      );
    }
  }

  // Auto-freeze logic
  const accRes = await client.query(
    "SELECT status FROM accounts WHERE id = $1",
    [accountId],
  );
  if (accRes.rows[0]?.status !== "active") {
    return;
  }

  // Analyst override check
  const logRes = await client.query(
    "SELECT action, set_by, created_at FROM account_flag_log WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1",
    [accountId],
  );
  if (logRes.rows.length > 0) {
    const latest = logRes.rows[0];
    if (
      latest.set_by === "analyst" &&
      (latest.action === "unfreeze" || latest.action === "unblacklist")
    ) {
      const hoursSince =
        (Date.now() - new Date(latest.created_at).getTime()) / (1000 * 60 * 60);
      if (hoursSince < 24) {
        return; // Do not auto-freeze
      }
    }
  }

  // Check severity sum in last 60 minutes
  const sevRes = await client.query(
    "SELECT SUM(severity) as total FROM signals WHERE account_id = $1 AND created_at > NOW() - INTERVAL '60 minutes'",
    [accountId],
  );
  const totalSev = parseInt(sevRes.rows[0].total || "0", 10);

  if (totalSev >= 5) {
    await freezeAccount(
      client,
      accountId,
      "Auto-frozen due to signal severity threshold",
      "analyzer",
    );
  }
}
