import { pool, withTx } from "../src/db.js";
import { moveMoney } from "../src/services/ledger.js";
import { InsufficientFundsError } from "../src/http/errors.js";
import { EXTERNAL_BANK_ID } from "../src/config.js";

// Dedicated ID to isolate this test's ledger entries
const SMOKE_TEST_TRANSFER_ID = "00000000-0000-0000-0000-smoketest00001";

async function main(): Promise<void> {
  try {
    // 1. Capture global ledger sum BEFORE test
    const initialSumRes = await pool.query(
      "SELECT SUM(amount) AS total FROM ledger",
    );
    const initialSum = parseInt(initialSumRes.rows[0].total || "0", 10);
    console.log(`Initial global ledger sum: ${initialSum}`);

    // 2. Setup a temporary test account
    const testUserId = "11111111-1111-1111-1111-111111111111";
    const testAccountId = "22222222-2222-2222-2222-222222222222";

    await pool.query(
      `INSERT INTO users (id, email, password_hash, role) VALUES ($1, 'alice_smoke@test.com', 'hash', 'user') ON CONFLICT (id) DO NOTHING`,
      [testUserId],
    );
    await pool.query(
      `INSERT INTO accounts (id, user_id, type, balance) VALUES ($1, $2, 'user', 0) ON CONFLICT (id) DO NOTHING`,
      [testAccountId, testUserId],
    );

    console.log("\n--- Smoke Test 1: Deposit 5000 paisa ---");
    await withTx(async (client) => {
      await moveMoney(client, {
        fromAccountId: EXTERNAL_BANK_ID,
        toAccountId: testAccountId,
        amount: 5000,
        transferId: SMOKE_TEST_TRANSFER_ID, // Isolated
        reason: "deposit",
      });
    });

    const res1 = await pool.query(
      `SELECT balance FROM accounts WHERE id = $1`,
      [testAccountId],
    );
    const balance1 = res1.rows[0].balance;
    const sum1Res = await pool.query(
      `SELECT SUM(amount) as sum FROM ledger WHERE account_id = $1`,
      [testAccountId],
    );
    const sum1 = parseInt(sum1Res.rows[0].sum, 10);

    console.log(`Alice's balance: ${balance1}`);
    console.log(`Alice's ledger sum: ${sum1}`);
    if (balance1 !== 5000 || sum1 !== 5000) {
      throw new Error("Smoke test 1 failed: balance or sum mismatch");
    }

    console.log("\n--- Smoke Test 2: Debit 10000 paisa (should fail) ---");
    let failedAsExpected = false;
    try {
      await withTx(async (client) => {
        await moveMoney(client, {
          fromAccountId: testAccountId,
          toAccountId: EXTERNAL_BANK_ID,
          amount: 10000,
          transferId: SMOKE_TEST_TRANSFER_ID, // Isolated
          reason: "withdrawal",
        });
      });
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        failedAsExpected = true;
        console.log("Caught InsufficientFundsError as expected.");
      } else {
        throw err;
      }
    }

    if (!failedAsExpected) {
      throw new Error("Smoke test 2 failed: Expected InsufficientFundsError");
    }

    const res2 = await pool.query(
      `SELECT balance FROM accounts WHERE id = $1`,
      [testAccountId],
    );
    const balance2 = res2.rows[0].balance;
    const sum2Res = await pool.query(
      `SELECT SUM(amount) as sum FROM ledger WHERE account_id = $1`,
      [testAccountId],
    );
    const sum2 = parseInt(sum2Res.rows[0].sum, 10);

    console.log(`Alice's balance after failed debit: ${balance2}`);
    console.log(`Alice's ledger sum after failed debit: ${sum2}`);
    if (balance2 !== 5000 || sum2 !== 5000) {
      throw new Error(
        "Smoke test 2 failed: balance or sum changed after rollback",
      );
    }

    // 3. SAFE Cleanup: Delete ONLY rows with our dedicated transfer_id
    console.log("\n--- Cleaning up test data safely ---");
    await pool.query(`DELETE FROM ledger WHERE transfer_id = $1`, [
      SMOKE_TEST_TRANSFER_ID,
    ]);
    await pool.query(`DELETE FROM accounts WHERE id = $1`, [testAccountId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [testUserId]);

    // 4. Verify global ledger sum is unchanged
    const finalSumRes = await pool.query(
      "SELECT SUM(amount) AS total FROM ledger",
    );
    const finalSum = parseInt(finalSumRes.rows[0].total || "0", 10);
    console.log(`Final global ledger sum: ${finalSum}`);

    if (initialSum !== finalSum) {
      throw new Error(
        `Regression failed: Global ledger sum changed from ${initialSum} to ${finalSum}`,
      );
    }

    console.log("\n✅ All smoke tests passed and cleaned up safely!");
  } catch (err) {
    console.error("❌ Smoke test failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
