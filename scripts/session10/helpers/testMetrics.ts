import type { Pool } from "pg";
import * as fs from "fs";
import * as path from "path";
import { IN_TRANSIT_ID } from "../../../src/config.js";
import type { TestAccount } from "./testAccounts.js";

export async function waitForDrain(
  pool: Pool,
  timeoutMs: number = 60000,
  options?: {
    checkStatsForAccounts?: Array<{
      accountId: string;
      expectedTxnCount: number;
    }>;
    checkClustersForAccounts?: string[];
  },
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const outboxRes = await pool.query(
      "SELECT COUNT(*) as count FROM outbox WHERE status = 'pending'",
    );
    const heldRes = await pool.query(
      "SELECT COUNT(*) as count FROM transfers WHERE status = 'held'",
    );
    const dlqRes = await pool.query(
      "SELECT COUNT(*) as count FROM dead_letters WHERE created_at > NOW() - INTERVAL '2 minutes'",
    );

    const pending = parseInt(outboxRes.rows[0].count, 10);
    const held = parseInt(heldRes.rows[0].count, 10);
    const recentDlq = parseInt(dlqRes.rows[0].count, 10);

    let statsComplete = true;
    if (options?.checkStatsForAccounts) {
      for (const {
        accountId,
        expectedTxnCount,
      } of options.checkStatsForAccounts) {
        const statsRes = await pool.query(
          "SELECT txn_count FROM user_stats WHERE account_id = $1",
          [accountId],
        );
        const currentTxnCount =
          statsRes.rows.length > 0
            ? parseInt(statsRes.rows[0].txn_count, 10)
            : 0;
        if (currentTxnCount < expectedTxnCount) {
          statsComplete = false;
          break;
        }
      }
    }

    let clustersComplete = true;
    if (options?.checkClustersForAccounts) {
      const clusterRes = await pool.query(
        "SELECT account_id FROM account_clusters WHERE account_id = ANY($1::uuid[])",
        [options.checkClustersForAccounts],
      );
      clustersComplete =
        clusterRes.rows.length === options.checkClustersForAccounts.length;
    }

    // Best-effort database drain check
    if (
      pending === 0 &&
      held === 0 &&
      recentDlq === 0 &&
      statsComplete &&
      clustersComplete
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1500)); // Settling delay
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

export async function verifyIntegrity(
  pool: Pool,
): Promise<{ passed: boolean; errors: string[] }> {
  const errors: string[] = [];

  // 1. Global ledger sum must equal zero
  const globalSumRes = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM ledger`,
  );
  if (BigInt(String(globalSumRes.rows[0].total)) !== 0n) {
    errors.push(
      `Global ledger sum is ${globalSumRes.rows[0].total}, expected 0.`,
    );
  }

  // 2. Every user account balance must match its ledger sum
  const balanceRes = await pool.query(`
    SELECT a.id, a.balance AS stored_balance, COALESCE(SUM(l.amount), 0) AS ledger_sum
    FROM accounts a
    LEFT JOIN ledger l ON l.account_id = a.id
    WHERE a.type = 'user'
    GROUP BY a.id, a.balance
    HAVING a.balance <> COALESCE(SUM(l.amount), 0)
  `);
  if (balanceRes.rows.length > 0) {
    errors.push(`User balances mismatch: ${JSON.stringify(balanceRes.rows)}`);
  }

  // 3. No user account can have a negative balance
  const negativeRes = await pool.query(
    `SELECT id, balance FROM accounts WHERE type = 'user' AND balance < 0`,
  );
  if (negativeRes.rows.length > 0) {
    errors.push(`Negative balances found: ${JSON.stringify(negativeRes.rows)}`);
  }

  // 4. In-transit ledger total must equal held transfer total
  const transitRes = await pool.query(
    `
    WITH ledger_total AS (
      SELECT COALESCE(SUM(amount), 0) AS total FROM ledger WHERE account_id = $1
    ),
    held_total AS (
      SELECT COALESCE(SUM(amount), 0) AS total FROM transfers WHERE status = 'held'
    )
    SELECT ledger_total.total AS ledger_total, held_total.total AS held_total
    FROM ledger_total, held_total
    WHERE ledger_total.total <> held_total.total
  `,
    [IN_TRANSIT_ID],
  );
  if (transitRes.rows.length > 0) {
    errors.push(`In-transit mismatch: ${JSON.stringify(transitRes.rows)}`);
  }

  // 5. Every settled or refunded transfer must have exactly two corresponding outcome ledger entries
  const outcomeRes = await pool.query(`
    SELECT t.id AS transfer_id, t.status, COUNT(l.transfer_id) AS outcome_count
    FROM transfers t
    LEFT JOIN ledger l ON l.transfer_id = t.id AND l.reason IN ('settle', 'refund')
    WHERE t.status IN ('settled', 'refunded')
    GROUP BY t.id, t.status
    HAVING COUNT(l.transfer_id) <> 2
  `);
  if (outcomeRes.rows.length > 0) {
    errors.push(`Invalid outcome entries: ${JSON.stringify(outcomeRes.rows)}`);
  }

  // 6. No transfer can have both settled and refunded entries
  const conflictingRes = await pool.query(`
    SELECT transfer_id, COUNT(DISTINCT reason) AS outcome_count
    FROM ledger
    WHERE transfer_id IS NOT NULL AND reason IN ('settle', 'refund')
    GROUP BY transfer_id
    HAVING COUNT(DISTINCT reason) > 1
  `);
  if (conflictingRes.rows.length > 0) {
    errors.push(`Conflicting outcomes: ${JSON.stringify(conflictingRes.rows)}`);
  }

  // 7. No transfer can have more than two entries for the same outcome
  const duplicateRes = await pool.query(`
    SELECT transfer_id, reason, COUNT(*) AS entry_count
    FROM ledger
    WHERE transfer_id IS NOT NULL AND reason IN ('settle', 'refund')
    GROUP BY transfer_id, reason
    HAVING COUNT(*) > 2
  `);
  if (duplicateRes.rows.length > 0) {
    errors.push(
      `Duplicate outcome entries: ${JSON.stringify(duplicateRes.rows)}`,
    );
  }

  // 8. No ledger entry can reference a nonexistent transfer
  const orphanedRes = await pool.query(`
    SELECT l.transfer_id, COUNT(*) AS entry_count
    FROM ledger l
    LEFT JOIN transfers t ON t.id = l.transfer_id
    WHERE l.transfer_id IS NOT NULL AND t.id IS NULL
    GROUP BY l.transfer_id
  `);
  if (orphanedRes.rows.length > 0) {
    errors.push(`Orphaned ledger entries: ${JSON.stringify(orphanedRes.rows)}`);
  }

  return { passed: errors.length === 0, errors };
}

export async function evaluateScenarios(
  pool: Pool,
  accounts: TestAccount[],
  clusterSetupPassed: boolean,
): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};
  const accountResults: Record<
    string,
    {
      hasVelocity: boolean;
      hasRepeatDeclines: boolean;
      hasClusterSignal: boolean;
      hasAmountAnomaly: boolean;
      hasAnySignal: boolean;
      isClusterFlagged: boolean;
    }
  > = {};

  for (const acc of accounts) {
    const signalRes = await pool.query(
      "SELECT kind FROM signals WHERE account_id = $1",
      [acc.accountId],
    );
    const signals = signalRes.rows.map((r: any) => r.kind);

    const clusterRes = await pool.query(
      "SELECT flagged FROM account_clusters WHERE account_id = $1",
      [acc.accountId],
    );
    const isClusterFlagged =
      clusterRes.rows.length > 0 && clusterRes.rows[0].flagged === true;

    accountResults[acc.accountId] = {
      hasVelocity: signals.includes("velocity"),
      hasRepeatDeclines: signals.includes("repeat_declines"),
      hasClusterSignal: signals.includes("cluster"),
      hasAmountAnomaly: signals.includes("amount_anomaly"),
      hasAnySignal: signals.length > 0,
      isClusterFlagged,
    };
  }

  const aggregate = (
    scenario: string,
    predicate: (r: (typeof accountResults)[string]) => boolean,
  ) => {
    const scenarioAccounts = accounts.filter((a) => a.scenario === scenario);
    return (
      scenarioAccounts.length > 0 &&
      scenarioAccounts.every((a) => predicate(accountResults[a.accountId]))
    );
  };

  results.A_cluster_velocity =
    clusterSetupPassed &&
    aggregate("A_cluster_velocity", (r) => r.hasVelocity && r.isClusterFlagged);
  results.B_cluster_declines =
    clusterSetupPassed &&
    aggregate(
      "B_cluster_declines",
      (r) => r.hasRepeatDeclines && r.isClusterFlagged,
    );
  results.C_cluster_legit =
    clusterSetupPassed &&
    aggregate("C_cluster_legit", (r) => r.hasClusterSignal); // Deliberate signal FP, true-negative for freeze
  results.D_velocity_only = aggregate("D_velocity_only", (r) => r.hasVelocity);
  results.E_amount_anomaly = aggregate(
    "E_amount_anomaly",
    (r) => r.hasAmountAnomaly,
  );
  results.F_declines_only = aggregate(
    "F_declines_only",
    (r) => r.hasRepeatDeclines,
  );
  results.G_pure_legit = aggregate("G_pure_legit", (r) => !r.hasAnySignal);

  return results;
}

export async function calculateMetrics(pool: Pool, accounts: TestAccount[]) {
  const metrics = {
    freeze: { tp: 0, fp: 0, fn: 0, tn: 0 },
    signal: { tp: 0, fp: 0, fn: 0, tn: 0 },
  };

  for (const acc of accounts) {
    const statusRes = await pool.query(
      "SELECT status FROM accounts WHERE id = $1",
      [acc.accountId],
    );
    const isFrozen = statusRes.rows[0]?.status === "frozen";

    const signalRes = await pool.query(
      "SELECT 1 FROM signals WHERE account_id = $1 LIMIT 1",
      [acc.accountId],
    );
    const hasSignal = signalRes.rows.length > 0;

    if (acc.isFraud) {
      if (isFrozen) metrics.freeze.tp++;
      else metrics.freeze.fn++;
      if (hasSignal) metrics.signal.tp++;
      else metrics.signal.fn++;
    } else {
      if (isFrozen) metrics.freeze.fp++;
      else metrics.freeze.tn++;
      if (hasSignal) metrics.signal.fp++;
      else metrics.signal.tn++;
    }
  }

  const calc = (tp: number, fp: number, fn: number, tn: number) => ({
    precision: tp + fp === 0 ? 0 : tp / (tp + fp),
    recall: tp + fn === 0 ? 0 : tp / (tp + fn),
    fpr: fp + tn === 0 ? 0 : fp / (fp + tn),
  });

  return {
    freeze: {
      ...metrics.freeze,
      ...calc(
        metrics.freeze.tp,
        metrics.freeze.fp,
        metrics.freeze.fn,
        metrics.freeze.tn,
      ),
    },
    signal: {
      ...metrics.signal,
      ...calc(
        metrics.signal.tp,
        metrics.signal.fp,
        metrics.signal.fn,
        metrics.signal.tn,
      ),
    },
  };
}

export async function generateReport(
  metrics: any,
  integrity: any,
  accounts: TestAccount[],
  scenarioExecutionResults: Record<string, boolean>,
  scenarioDetectionResults: Record<string, boolean>,
  drainPassed: boolean,
  clusterSetupPassed: boolean,
  outputPath: string,
  errorMessage?: string,
) {
  const executionPassed = Object.values(scenarioExecutionResults).every(
    (v) => v,
  );
  const detectionPassed = Object.values(scenarioDetectionResults).every(
    (v) => v,
  );
  const scenariosPassed = executionPassed && detectionPassed;
  const overallPassed =
    scenariosPassed && drainPassed && integrity.passed && clusterSetupPassed;

  const report = {
    timestamp: new Date().toISOString(),
    total_accounts: accounts.length,
    fraud_accounts: accounts.filter((a) => a.isFraud).length,
    legit_accounts: accounts.filter((a) => !a.isFraud).length,
    metrics,
    scenario_execution_results: scenarioExecutionResults,
    scenario_detection_results: scenarioDetectionResults,
    execution_passed: executionPassed,
    detection_passed: detectionPassed,
    scenarios_passed: scenariosPassed,
    drain_passed: drainPassed,
    cluster_setup_passed: clusterSetupPassed,
    integrity: {
      passed: integrity.passed,
      errors: integrity.errors,
    },
    overall_passed: overallPassed,
    error: errorMessage,
    notes: [
      "Small simulated evaluation (30 accounts). One false positive changes FPR by ~4.76 percentage points.",
      "Scenario C is a deliberate signal false-positive (legitimate account in flagged cluster) but true-negative for freeze.",
      "Drain check is a best-effort database verification, not a guarantee that RabbitMQ queues are empty.",
    ],
  };

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  return report;
}
