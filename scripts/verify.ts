import { pool } from "../src/db.js";
import { IN_TRANSIT_ID } from "../src/config.js";

async function main(): Promise<void> {
  console.log("🔍 Running PayCore Invariant Verification...\n");

  let passed = true;

  function report(name: string, rows: any[]): void {
    if (rows.length > 0) {
      console.error(`❌ FAIL: ${name}`);
      console.error(rows);
      passed = false;
    } else {
      console.log(`✅ PASS: ${name}`);
    }
  }

  try {
    // 1. Global ledger sum must equal zero
    const globalSumRes = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM ledger
    `);

    const globalSum = BigInt(globalSumRes.rows[0].total);

    if (globalSum !== 0n) {
      console.error(`❌ FAIL: Global ledger sum is ${globalSum}, expected 0.`);
      passed = false;
    } else {
      console.log("✅ PASS: Global ledger sum is 0.");
    }

    // 2. Every user account balance must match its ledger sum
    const balanceRes = await pool.query(`
      SELECT
        a.id,
        a.balance AS stored_balance,
        COALESCE(SUM(l.amount), 0) AS ledger_sum
      FROM accounts a
      LEFT JOIN ledger l ON l.account_id = a.id
      WHERE a.type = 'user'
      GROUP BY a.id, a.balance
      HAVING a.balance <> COALESCE(SUM(l.amount), 0)
    `);

    report("User balances match their ledger sums.", balanceRes.rows);

    // 3. No user account can have a negative balance
    const negativeRes = await pool.query(`
      SELECT id, balance
      FROM accounts
      WHERE type = 'user' AND balance < 0
    `);

    report("No user account has a negative balance.", negativeRes.rows);

    // 4. In-transit ledger total must equal held transfer total
    const transitRes = await pool.query(
      `
      WITH ledger_total AS (
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM ledger
        WHERE account_id = $1
      ),
      held_total AS (
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM transfers
        WHERE status = 'held'
      )
      SELECT
        ledger_total.total AS ledger_total,
        held_total.total AS held_total
      FROM ledger_total, held_total
      WHERE ledger_total.total <> held_total.total
    `,
      [IN_TRANSIT_ID],
    );

    report("In-transit ledger matches held transfers.", transitRes.rows);

    // 5. No transfer can have duplicate settle or refund pairs (using PayCore 'reason' column and 'settle' value)
    const duplicateRes = await pool.query(`
      SELECT
        transfer_id,
        reason,
        COUNT(*) AS pair_count
      FROM ledger
      WHERE transfer_id IS NOT NULL
        AND reason IN ('settle', 'refund')
      GROUP BY transfer_id, reason
      HAVING COUNT(*) > 2
    `);

    report("No transfer has duplicate settle/refund pairs.", duplicateRes.rows);

    // 6. A transfer cannot be both settled and refunded
    const conflictingRes = await pool.query(`
      SELECT
        transfer_id,
        COUNT(DISTINCT reason) AS outcome_count
      FROM ledger
      WHERE transfer_id IS NOT NULL
        AND reason IN ('settle', 'refund')
      GROUP BY transfer_id
      HAVING COUNT(DISTINCT reason) > 1
    `);

    report("No transfer is both settled and refunded.", conflictingRes.rows);

    console.log(
      "\n" +
        (passed
          ? "🎉 All invariants PASSED."
          : "⚠️ Verification FAILED. Check errors above."),
    );

    if (!passed) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error("❌ Verification script crashed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
