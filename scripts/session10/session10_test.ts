import "dotenv/config";
import { Pool } from "pg";
import { EXTERNAL_BANK_ID } from "../../src/config.js";
import {
  registerAndFundAccount,
  makeTransfer,
  generateIdempotencyKey,
  checkTransferSettled,
  type TestAccount,
} from "./helpers/testAccounts.js";
import {
  waitForDrain,
  verifyIntegrity,
  calculateMetrics,
  evaluateScenarios,
  generateReport,
} from "./helpers/testMetrics.js";

const ssl =
  process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: ssl as any,
});

const RUN_ID = Date.now().toString();

async function main() {
  console.log(`🚀 Starting Session 10 Fraud Test (Run ID: ${RUN_ID})`);

  const accounts: TestAccount[] = [];
  let drainPassed = true;
  let clusterSetupPassed = false;
  const scenarioExecutionResults: Record<string, boolean> = {};
  let errorMessage: string | undefined;

  try {
    // ==========================================
    // Phase 0: Resolve a real, non-user receiver for invalid-recipient scenarios
    // ==========================================
    // A nonexistent UUID cannot be used: fraudChecks returns receiver_invalid, but
    // transfers.ts then inserts a declined row referencing it and Postgres rejects
    // it on transfers_receiver_account_id_fkey. EXTERNAL_BANK_ID exists, so the
    // insert succeeds while Q2 still declines it as receiver_invalid.
    const receiverRes = await pool.query(
      "SELECT type, status FROM accounts WHERE id = $1",
      [EXTERNAL_BANK_ID],
    );

    if (receiverRes.rows.length === 0) {
      throw new Error(
        `EXTERNAL_BANK_ID ${EXTERNAL_BANK_ID} does not exist in accounts. ` +
          `Run the schema seed before this test. Stopping instead of inventing a receiver.`,
      );
    }

    const invalidReceiverType = String(receiverRes.rows[0].type);
    if (invalidReceiverType === "user") {
      throw new Error(
        `EXTERNAL_BANK_ID ${EXTERNAL_BANK_ID} has type 'user' and is unsuitable as an ` +
          `invalid receiver. Stopping instead of inventing a receiver.`,
      );
    }

    const INVALID_RECEIVER_ID = EXTERNAL_BANK_ID;
    console.log(
      `✅ Invalid-recipient target verified: ${INVALID_RECEIVER_ID} (type=${invalidReceiverType})`,
    );

    // ==========================================
    // Phase 1: Setup Accounts
    // ==========================================
    console.log("\n📦 Phase 1: Setup Accounts");

    for (let i = 1; i <= 2; i++)
      accounts.push(
        await registerAndFundAccount(
          pool,
          RUN_ID,
          "A_cluster_velocity",
          i,
          true,
        ),
      );
    for (let i = 1; i <= 2; i++)
      accounts.push(
        await registerAndFundAccount(
          pool,
          RUN_ID,
          "B_cluster_declines",
          i,
          true,
        ),
      );
    accounts.push(
      await registerAndFundAccount(pool, RUN_ID, "C_cluster_legit", 1, false),
    );
    for (let i = 1; i <= 2; i++)
      accounts.push(
        await registerAndFundAccount(pool, RUN_ID, "D_velocity_only", i, true),
      );
    for (let i = 1; i <= 2; i++)
      accounts.push(
        await registerAndFundAccount(pool, RUN_ID, "E_amount_anomaly", i, true),
      );
    for (let i = 1; i <= 2; i++)
      accounts.push(
        await registerAndFundAccount(pool, RUN_ID, "F_declines_only", i, true),
      );
    for (let i = 1; i <= 20; i++)
      accounts.push(
        await registerAndFundAccount(pool, RUN_ID, "G_pure_legit", i, false),
      );

    const fraudCount = accounts.filter((a) => a.isFraud).length;
    const legitCount = accounts.filter((a) => !a.isFraud).length;
    console.log(
      `✅ Created and verified funding for ${accounts.length} accounts (${fraudCount} fraud, ${legitCount} legitimate).`,
    );

    const sinkAccount = accounts.find((a) => a.scenario === "G_pure_legit")!;
    const clusterDeviceId = `cluster-dev-${RUN_ID}`;

    // ==========================================
    // Phase 2a: Cluster Setup
    // ==========================================
    console.log(
      "\n⚡ Phase 2a: Cluster Setup (Establish device graph before attacks)",
    );
    const clusterAccounts = accounts.filter(
      (a) =>
        a.scenario === "A_cluster_velocity" ||
        a.scenario === "B_cluster_declines" ||
        a.scenario === "C_cluster_legit",
    );

    const setupTransferIds: string[] = [];
    let clusterSetupExecutionPassed = true;

    for (const acc of clusterAccounts) {
      const result = await makeTransfer(
        acc.token,
        sinkAccount.accountId,
        1000,
        clusterDeviceId,
        generateIdempotencyKey(),
      );
      if (
        result.type !== "success" ||
        result.status !== "held" ||
        !result.transferId
      ) {
        console.error(
          `❌ Cluster setup transfer failed for ${acc.email}: ${result.type}`,
        );
        clusterSetupExecutionPassed = false;
      } else {
        setupTransferIds.push(result.transferId);
      }
    }

    console.log(
      "Waiting for cluster setup transfers to settle and graph to process...",
    );
    const clusterAccountIds = clusterAccounts.map((a) => a.accountId);
    const clusterDrained = await waitForDrain(pool, 30000, {
      checkClustersForAccounts: clusterAccountIds,
    });

    if (!clusterDrained || !clusterSetupExecutionPassed) {
      console.error("❌ Cluster setup drain timed out or transfers failed.");
      drainPassed = false;
      clusterSetupPassed = false;
      scenarioExecutionResults.cluster_setup = false;
    } else {
      let allSettled = true;
      for (const transferId of setupTransferIds) {
        if (!(await checkTransferSettled(pool, transferId))) {
          console.error(`❌ Setup transfer ${transferId} did not settle`);
          allSettled = false;
        }
      }

      const clusterRes = await pool.query(
        `SELECT account_id, flagged FROM account_clusters WHERE account_id = ANY($1::uuid[])`,
        [clusterAccountIds],
      );

      const allFlagged = clusterAccounts.every((acc) => {
        const row = clusterRes.rows.find(
          (r: any) => r.account_id === acc.accountId,
        );
        return row && row.flagged === true;
      });

      if (allSettled && allFlagged) {
        console.log(
          "✅ Cluster successfully established and flagged for all 5 accounts.",
        );
        clusterSetupPassed = true;
        scenarioExecutionResults.cluster_setup = true;
      } else {
        console.error(
          "❌ Cluster setup failed: transfers did not settle or accounts not flagged.",
        );
        clusterSetupPassed = false;
        scenarioExecutionResults.cluster_setup = false;
      }
    }

    // ==========================================
    // Phase 2b: Execute Attack Scenarios
    // ==========================================
    console.log("\n⚡ Phase 2b: Execute Attack Scenarios");

    // Scenario A: Cluster + Velocity
    // After bootstrap, each account has 1 transfer row. Velocity check runs before cluster.
    // Attempts 1-9: velocity count < 10 → pass velocity, fail cluster.
    // Attempts 10-15: velocity count >= 10 → fail velocity (cluster not reached).
    if (clusterSetupPassed) {
      console.log("Running Scenario A: Cluster + Velocity");
      let scenarioAExecutionPassed = true;
      for (const acc of accounts.filter(
        (a) => a.scenario === "A_cluster_velocity",
      )) {
        for (let i = 1; i <= 15; i++) {
          const result = await makeTransfer(
            acc.token,
            sinkAccount.accountId,
            1000,
            clusterDeviceId,
            generateIdempotencyKey(),
          );
          const expectedCheck = i <= 9 ? "cluster" : "velocity";
          if (
            result.type !== "declined" ||
            result.failedCheck !== expectedCheck
          ) {
            console.error(
              `❌ Scenario A transfer ${i} for ${acc.email} should be declined by ${expectedCheck}, got: ${result.type}, ${result.failedCheck}`,
            );
            scenarioAExecutionPassed = false;
          }
        }
      }
      scenarioExecutionResults.A_cluster_velocity = scenarioAExecutionPassed;
    } else {
      console.warn("⚠️ Skipping Scenario A due to cluster setup failure");
      scenarioExecutionResults.A_cluster_velocity = false;
    }

    // Scenario B: Cluster + Repeat Declines (invalid receiver = EXTERNAL_BANK_ID)
    if (clusterSetupPassed) {
      console.log("Running Scenario B: Cluster + Repeat Declines");
      let scenarioBExecutionPassed = true;
      for (const acc of accounts.filter(
        (a) => a.scenario === "B_cluster_declines",
      )) {
        for (let i = 1; i <= 4; i++) {
          const result = await makeTransfer(
            acc.token,
            INVALID_RECEIVER_ID,
            1000,
            clusterDeviceId,
            generateIdempotencyKey(),
          );
          if (
            result.type !== "declined" ||
            result.failedCheck !== "receiver_invalid"
          ) {
            console.error(
              `❌ Scenario B transfer ${i} for ${acc.email} should be declined for receiver_invalid, got: ${result.type}, ${result.failedCheck}`,
            );
            scenarioBExecutionPassed = false;
          }
        }
      }
      scenarioExecutionResults.B_cluster_declines = scenarioBExecutionPassed;
    } else {
      console.warn("⚠️ Skipping Scenario B due to cluster setup failure");
      scenarioExecutionResults.B_cluster_declines = false;
    }

    // Scenario C: Cluster Legitimate (deliberate signal false-positive)
    if (clusterSetupPassed) {
      console.log("Running Scenario C: Cluster Legitimate");
      let scenarioCExecutionPassed = true;
      for (const acc of accounts.filter(
        (a) => a.scenario === "C_cluster_legit",
      )) {
        const result = await makeTransfer(
          acc.token,
          sinkAccount.accountId,
          2000,
          clusterDeviceId,
          generateIdempotencyKey(),
        );
        if (result.type !== "declined" || result.failedCheck !== "cluster") {
          console.error(
            `❌ Scenario C transfer for ${acc.email} should be declined for cluster, got: ${result.type}, ${result.failedCheck}`,
          );
          scenarioCExecutionPassed = false;
        }
      }
      scenarioExecutionResults.C_cluster_legit = scenarioCExecutionPassed;
    } else {
      console.warn("⚠️ Skipping Scenario C due to cluster setup failure");
      scenarioExecutionResults.C_cluster_legit = false;
    }

    // Scenario D: Velocity Only
    console.log("Running Scenario D: Velocity Only");
    let scenarioDExecutionPassed = true;
    for (const acc of accounts.filter(
      (a) => a.scenario === "D_velocity_only",
    )) {
      const deviceId = `dev-d-${acc.accountId}-${RUN_ID}`;
      for (let i = 1; i <= 15; i++) {
        const result = await makeTransfer(
          acc.token,
          sinkAccount.accountId,
          1000,
          deviceId,
          generateIdempotencyKey(),
        );
        if (i <= 10) {
          if (result.type !== "success" || result.status !== "held") {
            console.error(
              `❌ Scenario D transfer ${i} for ${acc.email} should be held, got: ${result.type}`,
            );
            scenarioDExecutionPassed = false;
          }
        } else {
          if (result.type !== "declined" || result.failedCheck !== "velocity") {
            console.error(
              `❌ Scenario D transfer ${i} for ${acc.email} should be declined for velocity, got: ${result.type}, ${result.failedCheck}`,
            );
            scenarioDExecutionPassed = false;
          }
        }
      }
    }
    scenarioExecutionResults.D_velocity_only = scenarioDExecutionPassed;

    // Scenario E: Amount Anomaly Only
    console.log("Running Scenario E: Amount Anomaly Only");
    let scenarioEExecutionPassed = true;
    const eAccounts = accounts.filter((a) => a.scenario === "E_amount_anomaly");
    const eTransferIds: Record<string, string[]> = {};

    for (const acc of eAccounts) {
      eTransferIds[acc.accountId] = [];
      for (let i = 1; i <= 5; i++) {
        const result = await makeTransfer(
          acc.token,
          sinkAccount.accountId,
          1000,
          `dev-e-${acc.accountId}-${RUN_ID}`,
          generateIdempotencyKey(),
        );
        if (
          result.type !== "success" ||
          result.status !== "held" ||
          !result.transferId
        ) {
          console.error(
            `❌ Scenario E small transfer ${i} failed for ${acc.email}: ${result.type}`,
          );
          scenarioEExecutionPassed = false;
        } else {
          eTransferIds[acc.accountId].push(result.transferId);
        }
      }

      if (eTransferIds[acc.accountId].length !== 5) {
        console.error(
          `❌ Scenario E: Account ${acc.email} has ${eTransferIds[acc.accountId].length} successful transfers, expected 5`,
        );
        scenarioEExecutionPassed = false;
      }
    }

    console.log(
      "Waiting for Scenario E transfers to settle and stats to update (expected txn_count: 5)...",
    );
    const eStatsCheck = eAccounts.map((a) => ({
      accountId: a.accountId,
      expectedTxnCount: 5,
    }));
    const eDrained = await waitForDrain(pool, 30000, {
      checkStatsForAccounts: eStatsCheck,
    });

    if (!eDrained) {
      console.warn("⚠️ Scenario E drain timed out. Stats may not be updated.");
      scenarioEExecutionPassed = false;
    } else if (scenarioEExecutionPassed) {
      let allSettled = true;
      for (const acc of eAccounts) {
        for (const transferId of eTransferIds[acc.accountId]) {
          if (!(await checkTransferSettled(pool, transferId))) {
            console.error(
              `❌ Scenario E transfer ${transferId} did not settle`,
            );
            allSettled = false;
          }
        }
      }

      if (!allSettled) {
        console.error(
          "❌ Scenario E aborted: not all small transfers settled.",
        );
        scenarioEExecutionPassed = false;
      } else {
        for (const acc of eAccounts) {
          const result = await makeTransfer(
            acc.token,
            sinkAccount.accountId,
            6000,
            `dev-e-large-${acc.accountId}-${RUN_ID}`,
            generateIdempotencyKey(),
          );
          if (
            result.type !== "declined" ||
            result.failedCheck !== "amount_anomaly"
          ) {
            console.error(
              `❌ Scenario E large transfer not declined for amount_anomaly: ${result.type}, ${result.failedCheck}`,
            );
            scenarioEExecutionPassed = false;
          }
        }
      }
    } else {
      console.error(
        "❌ Scenario E aborted: insufficient successful small transfers.",
      );
    }
    scenarioExecutionResults.E_amount_anomaly = scenarioEExecutionPassed;

    // Scenario F: Repeat Declines Only (invalid receiver = EXTERNAL_BANK_ID)
    console.log("Running Scenario F: Repeat Declines Only");
    let scenarioFExecutionPassed = true;
    for (const acc of accounts.filter(
      (a) => a.scenario === "F_declines_only",
    )) {
      for (let i = 1; i <= 4; i++) {
        const result = await makeTransfer(
          acc.token,
          INVALID_RECEIVER_ID,
          1000,
          `dev-f-${acc.accountId}-${RUN_ID}`,
          generateIdempotencyKey(),
        );
        if (
          result.type !== "declined" ||
          result.failedCheck !== "receiver_invalid"
        ) {
          console.error(
            `❌ Scenario F transfer ${i} for ${acc.email} should be declined for receiver_invalid, got: ${result.type}, ${result.failedCheck}`,
          );
          scenarioFExecutionPassed = false;
        }
      }
    }
    scenarioExecutionResults.F_declines_only = scenarioFExecutionPassed;

    // Scenario G: Pure Legitimate
    console.log("Running Scenario G: Pure Legitimate");
    let scenarioGExecutionPassed = true;
    const gTransferIds: string[] = [];
    const legitAccounts = accounts.filter((a) => a.scenario === "G_pure_legit");

    for (let i = 0; i < legitAccounts.length; i++) {
      const acc = legitAccounts[i];
      const target = legitAccounts[(i + 1) % legitAccounts.length];

      const result1 = await makeTransfer(
        acc.token,
        target.accountId,
        3000,
        `dev-g-${acc.accountId}-${RUN_ID}`,
        generateIdempotencyKey(),
      );
      const result2 = await makeTransfer(
        acc.token,
        target.accountId,
        4000,
        `dev-g-${acc.accountId}-${RUN_ID}-2`,
        generateIdempotencyKey(),
      );

      if (
        result1.type !== "success" ||
        result1.status !== "held" ||
        !result1.transferId
      ) {
        console.error(
          `❌ Scenario G transfer 1 failed for ${acc.email}: ${result1.type}`,
        );
        scenarioGExecutionPassed = false;
      } else {
        gTransferIds.push(result1.transferId);
      }

      if (
        result2.type !== "success" ||
        result2.status !== "held" ||
        !result2.transferId
      ) {
        console.error(
          `❌ Scenario G transfer 2 failed for ${acc.email}: ${result2.type}`,
        );
        scenarioGExecutionPassed = false;
      } else {
        gTransferIds.push(result2.transferId);
      }
    }
    scenarioExecutionResults.G_pure_legit = scenarioGExecutionPassed;

    // ==========================================
    // Phase 3: Final Async Drain
    // ==========================================
    console.log("\n⏳ Phase 3: Final Async Drain");
    const finalDrained = await waitForDrain(pool, 60000);
    if (!finalDrained) {
      console.warn("⚠️ Warning: System did not fully drain within 60 seconds.");
      drainPassed = false;
    } else {
      console.log("✅ System drained successfully.");
    }

    // Verify Scenario G transfers settled
    if (scenarioExecutionResults.G_pure_legit) {
      console.log("Verifying Scenario G transfers settled...");
      for (const transferId of gTransferIds) {
        if (!(await checkTransferSettled(pool, transferId))) {
          console.error(`❌ Scenario G transfer ${transferId} did not settle`);
          scenarioExecutionResults.G_pure_legit = false;
        }
      }
    }

    // ==========================================
    // Phase 4: Measurement & Integrity
    // ==========================================
    console.log("\n📊 Phase 4: Measurement & Integrity");
    const metrics = await calculateMetrics(pool, accounts);
    const integrity = await verifyIntegrity(pool);
    const scenarioDetectionResults = await evaluateScenarios(
      pool,
      accounts,
      clusterSetupPassed,
    );

    // ==========================================
    // Phase 5: Generate Report & Console Output
    // ==========================================
    console.log("\n📝 Phase 5: Generate Report");
    const report = await generateReport(
      metrics,
      integrity,
      accounts,
      scenarioExecutionResults,
      scenarioDetectionResults,
      drainPassed,
      clusterSetupPassed,
      "test-results/session10_test_results.json",
    );

    console.log("\n=== PayCore Fraud Detection Test Results ===");
    console.log(
      `Total Accounts: ${report.total_accounts} (Fraud: ${report.fraud_accounts}, Legit: ${report.legit_accounts})`,
    );

    console.log("\n🛡️ Freeze-based Metrics (Auto-freeze enforcement):");
    console.log(
      `  TP: ${metrics.freeze.tp}, FP: ${metrics.freeze.fp}, FN: ${metrics.freeze.fn}, TN: ${metrics.freeze.tn}`,
    );
    console.log(`  Precision: ${(metrics.freeze.precision * 100).toFixed(2)}%`);
    console.log(`  Recall: ${(metrics.freeze.recall * 100).toFixed(2)}%`);
    console.log(
      `  False-Positive Rate: ${(metrics.freeze.fpr * 100).toFixed(2)}%`,
    );

    console.log("\n🔍 Signal-based Metrics (Detection recall):");
    console.log(
      `  TP: ${metrics.signal.tp}, FP: ${metrics.signal.fp}, FN: ${metrics.signal.fn}, TN: ${metrics.signal.tn}`,
    );
    console.log(`  Precision: ${(metrics.signal.precision * 100).toFixed(2)}%`);
    console.log(`  Recall: ${(metrics.signal.recall * 100).toFixed(2)}%`);
    console.log(
      `  False-Positive Rate: ${(metrics.signal.fpr * 100).toFixed(2)}%`,
    );

    console.log("\n🎯 Scenario Execution Results:");
    Object.entries(scenarioExecutionResults).forEach(([scenario, passed]) =>
      console.log(`  ${passed ? "✅" : "❌"} ${scenario}`),
    );

    console.log("\n🎯 Scenario Detection Results:");
    Object.entries(scenarioDetectionResults).forEach(([scenario, passed]) =>
      console.log(`  ${passed ? "✅" : "❌"} ${scenario}`),
    );

    console.log("\n🗄️ Database Integrity:");
    if (integrity.passed) {
      console.log("✅ All 8 invariant checks PASSED.");
    } else {
      console.log("❌ Integrity checks FAILED:");
      integrity.errors.forEach((err: string) => console.log(`  - ${err}`));
    }

    console.log(
      `\n💾 Report saved to: test-results/session10_test_results.json`,
    );

    if (report.overall_passed) {
      console.log("\n🎉 OVERALL TEST PASSED.");
    } else {
      console.error(
        "\n❌ OVERALL TEST FAILED. Check scenario results, drain status, or integrity errors above.",
      );
      process.exitCode = 1;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    console.error("\n❌ Test execution failed:", errorMessage);

    try {
      const partialMetrics =
        accounts.length > 0
          ? await calculateMetrics(pool, accounts)
          : {
              freeze: {
                tp: 0,
                fp: 0,
                fn: 0,
                tn: 0,
                precision: 0,
                recall: 0,
                fpr: 0,
              },
              signal: {
                tp: 0,
                fp: 0,
                fn: 0,
                tn: 0,
                precision: 0,
                recall: 0,
                fpr: 0,
              },
            };
      const partialIntegrity = {
        passed: false,
        errors: ["Test execution failed before integrity check"],
      };

      const partialDetectionResults: Record<string, boolean> = {
        cluster_setup: false,
        A_cluster_velocity: false,
        B_cluster_declines: false,
        C_cluster_legit: false,
        D_velocity_only: false,
        E_amount_anomaly: false,
        F_declines_only: false,
        G_pure_legit: false,
      };

      await generateReport(
        partialMetrics,
        partialIntegrity,
        accounts,
        scenarioExecutionResults,
        partialDetectionResults,
        drainPassed,
        clusterSetupPassed,
        "test-results/session10_test_results.json",
        errorMessage,
      );
      console.log(
        "💾 Partial failure report saved to: test-results/session10_test_results.json",
      );
    } catch (reportErr) {
      console.error("Failed to generate partial report:", reportErr);
    }

    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
