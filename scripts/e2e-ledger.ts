import { randomUUID } from "crypto";
import { pool, withTx } from "../src/db.js";
import { moveMoney } from "../src/services/ledger.js";
import { InsufficientFundsError } from "../src/http/errors.js";
import { EXTERNAL_BANK_ID, IN_TRANSIT_ID } from "../src/config.js";

const TEST_USER_ALICE = randomUUID();
const TEST_USER_BOB = randomUUID();

const TEST_ACCT_ALICE = randomUUID();
const TEST_ACCT_BOB = randomUUID();

const TX_DEPOSIT = randomUUID();
const TX_TRANSFER = randomUUID();
const TX_WITHDRAW = randomUUID();
const TX_FAIL = randomUUID();

const TEST_TRANSFER_IDS = [TX_DEPOSIT, TX_TRANSFER, TX_WITHDRAW, TX_FAIL];
const TEST_ACCOUNT_IDS = [TEST_ACCT_ALICE, TEST_ACCT_BOB];
const TEST_USER_IDS = [TEST_USER_ALICE, TEST_USER_BOB];

let passed = true;
let cleanupFailed = false;
let initialGlobalSum: bigint | null = null;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }
  console.log(`PASS: ${message}`);
}

function toBigInt(value: unknown): bigint {
  return BigInt(String(value ?? "0"));
}

async function getGlobalLedgerSum(): Promise<bigint> {
  const result = await pool.query(
    "SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger",
  );
  return toBigInt(result.rows[0].total);
}

async function getBalance(accountId: string): Promise<bigint> {
  const result = await pool.query(
    "SELECT balance::text AS balance FROM accounts WHERE id = $1",
    [accountId],
  );
  assert(result.rowCount === 1, `Account ${accountId} exists`);
  return toBigInt(result.rows[0].balance);
}

async function getAccountLedgerSum(accountId: string): Promise<bigint> {
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger WHERE account_id = $1`,
    [accountId],
  );
  return toBigInt(result.rows[0].total);
}

async function createTransfer(
  id: string,
  senderId: string,
  receiverId: string,
  amount: number,
  status: "held" | "settled" | "declined",
): Promise<void> {
  await pool.query(
    `INSERT INTO transfers (id, sender_account_id, receiver_account_id, amount, status, idempotency_key, payload_hash) 
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      senderId,
      receiverId,
      amount,
      status,
      `e2e-key-${id}`,
      `e2e-hash-${id}`,
    ],
  );
}

async function cleanup(): Promise<void> {
  console.log("\nCleaning up test data...");

  const steps = [
    {
      label: "test ledger entries",
      query: "DELETE FROM ledger WHERE transfer_id = ANY($1::uuid[])",
      params: [TEST_TRANSFER_IDS],
    },
    {
      label: "test transfers",
      query: "DELETE FROM transfers WHERE id = ANY($1::uuid[])",
      params: [TEST_TRANSFER_IDS],
    },
    {
      label: "test accounts",
      query: "DELETE FROM accounts WHERE id = ANY($1::uuid[])",
      params: [TEST_ACCOUNT_IDS],
    },
    {
      label: "test users",
      query: "DELETE FROM users WHERE id = ANY($1::uuid[])",
      params: [TEST_USER_IDS],
    },
  ];

  for (const step of steps) {
    try {
      await pool.query(step.query, step.params);
      console.log(`PASS: Deleted ${step.label}`);
    } catch (error) {
      cleanupFailed = true;
      console.error(`FAIL: Could not delete ${step.label}:`, error);
    }
  }

  if (initialGlobalSum !== null) {
    try {
      const finalGlobalSum = await getGlobalLedgerSum();
      assert(
        finalGlobalSum === initialGlobalSum,
        `Global ledger sum after cleanup is ${finalGlobalSum}; expected ${initialGlobalSum}`,
      );
    } catch (error) {
      cleanupFailed = true;
      console.error(
        "FAIL: Post-cleanup global sum verification failed:",
        error,
      );
    }
  } else {
    console.error(
      "WARNING: Initial global sum was unavailable; cannot verify restoration.",
    );
    cleanupFailed = true;
  }
}

async function main(): Promise<void> {
  console.log("Starting PayCore E2E ledger test...\n");

  try {
    initialGlobalSum = await getGlobalLedgerSum();
    console.log(
      `Initial global ledger sum: ${initialGlobalSum}` +
        (initialGlobalSum === 0n ? " (zero)" : " (non-zero)"),
    );

    // 2. Create isolated test users and accounts (with ON CONFLICT for idempotency)
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [
        TEST_USER_ALICE,
        `alice-${TEST_USER_ALICE}@e2e.test`,
        "e2e_dummy_hash",
        "user",
      ],
    );
    await pool.query(
      `INSERT INTO accounts (id, user_id, type, balance, status) VALUES ($1, $2, 'user', 0, 'active') ON CONFLICT (id) DO NOTHING`,
      [TEST_ACCT_ALICE, TEST_USER_ALICE],
    );

    await pool.query(
      `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [
        TEST_USER_BOB,
        `bob-${TEST_USER_BOB}@e2e.test`,
        "e2e_dummy_hash",
        "user",
      ],
    );
    await pool.query(
      `INSERT INTO accounts (id, user_id, type, balance, status) VALUES ($1, $2, 'user', 0, 'active') ON CONFLICT (id) DO NOTHING`,
      [TEST_ACCT_BOB, TEST_USER_BOB],
    );

    // 3. Deposit 10,000 paisa into Alice's account
    await createTransfer(
      TX_DEPOSIT,
      EXTERNAL_BANK_ID,
      TEST_ACCT_ALICE,
      10000,
      "settled",
    );
    await withTx(async (client) => {
      await moveMoney(client, {
        fromAccountId: EXTERNAL_BANK_ID,
        toAccountId: TEST_ACCT_ALICE,
        amount: 10000,
        transferId: TX_DEPOSIT,
        reason: "deposit",
      });
    });

    // 4. Hold 3,000 paisa from Alice for a transfer to Bob
    await createTransfer(
      TX_TRANSFER,
      TEST_ACCT_ALICE,
      TEST_ACCT_BOB,
      3000,
      "held",
    );
    await withTx(async (client) => {
      await moveMoney(client, {
        fromAccountId: TEST_ACCT_ALICE,
        toAccountId: IN_TRANSIT_ID,
        amount: 3000,
        transferId: TX_TRANSFER,
        reason: "hold",
      });
    });

    // Settle the same transfer from in-transit to Bob (Aligned with real app: moveMoney first, then update status)
    await withTx(async (client) => {
      await moveMoney(client, {
        fromAccountId: IN_TRANSIT_ID,
        toAccountId: TEST_ACCT_BOB,
        amount: 3000,
        transferId: TX_TRANSFER,
        reason: "settle",
      });
    });
    await pool.query(
      `UPDATE transfers SET status = 'settled', updated_at = now() WHERE id = $1`,
      [TX_TRANSFER],
    );

    // 5. Withdraw 2,000 paisa from Bob
    await createTransfer(
      TX_WITHDRAW,
      TEST_ACCT_BOB,
      EXTERNAL_BANK_ID,
      2000,
      "settled",
    );
    await withTx(async (client) => {
      await moveMoney(client, {
        fromAccountId: TEST_ACCT_BOB,
        toAccountId: EXTERNAL_BANK_ID,
        amount: 2000,
        transferId: TX_WITHDRAW,
        reason: "withdrawal",
      });
    });

    // 6. Attempt a withdrawal that exceeds Bob's available balance
    let insufficientFundsThrown = false;
    try {
      await withTx(async (client) => {
        await client.query(
          `INSERT INTO transfers (id, sender_account_id, receiver_account_id, amount, status, idempotency_key, payload_hash) 
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            TX_FAIL,
            TEST_ACCT_BOB,
            EXTERNAL_BANK_ID,
            5000,
            "declined",
            `e2e-key-${TX_FAIL}`,
            `e2e-hash-${TX_FAIL}`,
          ],
        );
        await moveMoney(client, {
          fromAccountId: TEST_ACCT_BOB,
          toAccountId: EXTERNAL_BANK_ID,
          amount: 5000,
          transferId: TX_FAIL,
          reason: "withdrawal",
        });
      });
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        insufficientFundsThrown = true;
      } else {
        throw error;
      }
    }
    assert(
      insufficientFundsThrown,
      "Insufficient-funds withdrawal throws InsufficientFundsError",
    );

    // 7. Verify the resulting balances
    const aliceBalance = await getBalance(TEST_ACCT_ALICE);
    const bobBalance = await getBalance(TEST_ACCT_BOB);
    assert(
      aliceBalance === 7000n,
      `Alice balance is 7000; got ${aliceBalance}`,
    );
    assert(bobBalance === 1000n, `Bob balance is 1000; got ${bobBalance}`);

    // 8. Verify each user account's balance matches its ledger entries
    const aliceLedgerSum = await getAccountLedgerSum(TEST_ACCT_ALICE);
    const bobLedgerSum = await getAccountLedgerSum(TEST_ACCT_BOB);
    assert(
      aliceBalance === aliceLedgerSum,
      "Alice balance matches her ledger sum",
    );
    assert(bobBalance === bobLedgerSum, "Bob balance matches his ledger sum");

    // 9. Every movement must preserve the global double-entry sum
    const currentGlobalSum = await getGlobalLedgerSum();
    assert(
      currentGlobalSum === initialGlobalSum,
      `Global ledger sum remains ${initialGlobalSum} during the test`,
    );

    // 10. Check that each successful transfer's entries balance
    for (const transferId of [TX_DEPOSIT, TX_TRANSFER, TX_WITHDRAW]) {
      const result = await pool.query(
        `SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger WHERE transfer_id = $1`,
        [transferId],
      );
      const transferSum = toBigInt(result.rows[0].total);
      assert(
        transferSum === 0n,
        `Ledger entries for transfer ${transferId} sum to zero`,
      );
    }

    // 11. The failed withdrawal must leave no transfer or ledger entries
    const failedTransferResult = await pool.query(
      "SELECT COUNT(*)::text AS count FROM transfers WHERE id = $1",
      [TX_FAIL],
    );
    const failedLedgerResult = await pool.query(
      "SELECT COUNT(*)::text AS count FROM ledger WHERE transfer_id = $1",
      [TX_FAIL],
    );
    assert(
      toBigInt(failedTransferResult.rows[0].count) === 0n,
      "Failed withdrawal left no transfer row",
    );
    assert(
      toBigInt(failedLedgerResult.rows[0].count) === 0n,
      "Failed withdrawal left no ledger entries",
    );
    assert(
      (await getBalance(TEST_ACCT_BOB)) === 1000n,
      "Bob balance remains unchanged after failed withdrawal",
    );

    console.log("\nAll E2E ledger assertions passed.");
  } catch (error) {
    passed = false;
    console.error("\nE2E ledger test failed:", error);
  } finally {
    try {
      await cleanup();
    } catch (error) {
      cleanupFailed = true;
      console.error("Unexpected cleanup failure:", error);
    }

    try {
      await pool.end();
    } catch (error) {
      cleanupFailed = true;
      console.error("Failed to close database pool:", error);
    }

    if (!passed || cleanupFailed) {
      console.error("\nE2E test failed or cleanup was incomplete.");
      process.exit(1);
    } else {
      console.log("\nE2E test and cleanup completed successfully.");
      process.exit(0);
    }
  }
}

main().catch((error) => {
  console.error("Unexpected fatal error:", error);
  process.exit(1);
});
