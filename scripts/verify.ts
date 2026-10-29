import { pool } from "../src/db.js";
import { EXTERNAL_BANK_ID, IN_TRANSIT_ID } from "../src/config.js";

async function main(): Promise<void> {
  console.log("🔍 Running PayCore Invariant Verification...\n");
  let passed = true;

  try {
    // Invariant 1: Global ledger sum must be exactly 0
    const globalSumRes = await pool.query("SELECT SUM(amount) AS total FROM ledger");
    const globalSum = parseInt(globalSumRes.rows[0].total || "0", 10);
    if (globalSum !== 0) {
      console.error(`❌ FAIL: Global ledger sum is ${globalSum}, expected 0.`);
      console.error("   This indicates orphaned ledger entries (e.g., from manual DB edits or buggy test scripts).");
      passed = false;
    } else {
      console.log("✅ PASS: Global ledger sum is 0.");
    }

    // Invariant 2: Every user account balance must match its ledger sum
    const balanceCheckRes = await pool.query(`
      SELECT a.id, a.balance AS stored_balance, COALESCE(SUM(l.amount), 0) AS ledger_sum
      FROM accounts a
      LEFT JOIN ledger l ON a.id = l.account_id
      WHERE a.type = 'user'
      GROUP BY a.id, a.balance
      HAVING a.balance <> COALESCE(SUM(l.amount), 0)
    `);
    
    if (balanceCheckRes.rows.length > 0) {
      console.error("❌ FAIL: Account balances do not match ledger sums:");
      console.error(balanceCheckRes.rows);
      passed = false;
    } else {
      console.log("✅ PASS: All user account balances match their ledger sums.");
    }

    // Invariant 3: No user balance can be negative (enforced by DB CHECK, but good to verify)
    const negativeBalanceRes = await pool.query(
      "SELECT id, balance FROM accounts WHERE type = 'user' AND balance < 0"
    );
    if (negativeBalanceRes.rows.length > 0) {
      console.error("❌ FAIL: Found accounts with negative balances:");
      console.error(negativeBalanceRes.rows);
      passed = false;
    } else {
      console.log("✅ PASS: No user accounts have negative balances.");
    }

    console.log("\n" + (passed ? "🎉 All invariants PASSED." : "⚠️ Verification FAILED. Check errors above."));
    process.exit(passed ? 0 : 1);

  } catch (err) {
    console.error("❌ Verification script crashed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
