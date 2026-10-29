import { pool } from "../src/db.js";

const BASE_URL = "http://localhost:3000/api";
const PASSWORD = "Password123!";

type ApiResponse = {
  status: number;
  data: any;
};

type TestUser = {
  email: string;
  token: string;
  accountId: string;
};

async function request(
  method: string,
  path: string,
  body: any = null,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  const options: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  };

  if (body !== null) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${BASE_URL}${path}`, options);
  const data = await response.json().catch(() => ({}));

  return { status: response.status, data };
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function createUser(email: string): Promise<TestUser> {
  const registration = await request("POST", "/auth/register", {
    email,
    password: PASSWORD,
  });

  assert(
    registration.status === 201,
    `Registration failed for ${email}: ${JSON.stringify(registration.data)}`,
  );

  const login = await request("POST", "/auth/login", {
    email,
    password: PASSWORD,
  });

  assert(
    Boolean(login.data.token && login.data.account_id),
    `Login failed for ${email}: ${JSON.stringify(login.data)}`,
  );

  return {
    email,
    token: login.data.token,
    accountId: login.data.account_id,
  };
}

async function deposit(user: TestUser, amount: number): Promise<void> {
  const result = await request(
    "POST",
    "/accounts/deposit",
    { amount },
    { Authorization: `Bearer ${user.token}` },
  );

  assert(
    result.status >= 200 && result.status < 300,
    `Deposit failed: ${JSON.stringify(result.data)}`,
  );
}

async function getBalance(user: TestUser): Promise<number> {
  const result = await request("GET", "/accounts/me", null, {
    Authorization: `Bearer ${user.token}`,
  });

  assert(
    result.status === 200 && Number.isSafeInteger(result.data.balance),
    `Could not read account balance: ${JSON.stringify(result.data)}`,
  );

  return result.data.balance;
}

async function runAdvancedTests(): Promise<void> {
  const timestamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const standardEmail = `standard_${timestamp}@test.com`;
  const velocityEmail = `velocity_${timestamp}@test.com`;
  const concurrencyEmail = `concurrency_${timestamp}@test.com`;
  const receiverEmail = `receiver_${timestamp}@test.com`;

  const testEmails = [
    standardEmail,
    velocityEmail,
    concurrencyEmail,
    receiverEmail,
  ];

  const users: TestUser[] = [];
  let passedCount = 0;
  const totalTests = 6;

  let defaultReceiverId = "";

  async function transfer(
    user: TestUser,
    amount: number,
    key?: string,
    receiverId = defaultReceiverId,
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${user.token}`,
    };

    if (key !== undefined) {
      headers["Idempotency-Key"] = key;
    }

    return request(
      "POST",
      "/transfers",
      {
        receiver_account_id: receiverId,
        amount,
      },
      headers,
    );
  }

  console.log("🚀 Starting Advanced Transfer Tests...\n");

  try {
    console.log("👤 Creating isolated test users including receiver...");

    const standardUser = await createUser(standardEmail);
    users.push(standardUser);

    const velocityUser = await createUser(velocityEmail);
    users.push(velocityUser);

    const concurrencyUser = await createUser(concurrencyEmail);
    users.push(concurrencyUser);

    // Create a valid user account to act as the transfer receiver
    const receiverUser = await createUser(receiverEmail);
    users.push(receiverUser);
    defaultReceiverId = receiverUser.accountId;

    console.log(`✅ Receiver Account ID set to: ${defaultReceiverId}\n`);

    await deposit(standardUser, 100_000);
    await deposit(velocityUser, 100_000);
    await deposit(concurrencyUser, 500_000);

    console.log("✅ Test users created and funded.\n");

    // TEST A: Idempotency replay
    console.log("🧪 Test A: Idempotency Replay");

    const keyA = `replay-${timestamp}`;
    const bodyA = 10_000;

    const resA1 = await transfer(standardUser, bodyA, keyA);
    const resA2 = await transfer(standardUser, bodyA, keyA);

    assert(
      resA1.status === 201 &&
        resA1.data.status === "held" &&
        Boolean(resA1.data.transfer_id),
      `First request failed: ${JSON.stringify(resA1)}`,
    );

    assert(
      resA2.status === 200 &&
        resA2.data.replayed === true &&
        resA2.data.transfer_id === resA1.data.transfer_id,
      `Replay failed: ${JSON.stringify(resA2)}`,
    );

    console.log("✅ PASS: Same key and body replay the original transfer.\n");
    passedCount++;

    // TEST B: Idempotency conflict
    console.log("🧪 Test B: Idempotency Conflict");

    const keyB = `conflict-${timestamp}`;

    const resB1 = await transfer(standardUser, 10_000, keyB);
    const resB2 = await transfer(standardUser, 20_000, keyB);

    assert(
      resB1.status === 201 && resB1.data.status === "held",
      `Initial conflict-test request failed: ${JSON.stringify(resB1)}`,
    );

    assert(
      resB2.status === 409 && resB2.data.error?.code === "idempotency_conflict",
      `Expected 409 idempotency conflict: ${JSON.stringify(resB2)}`,
    );

    console.log(
      "✅ PASS: Reusing a key with a different amount returns 409.\n",
    );
    passedCount++;

    // TEST C: Validation
    console.log("🧪 Test C: Validation Errors");

    const resC1 = await transfer(standardUser, 10_000); // missing key
    const resC2 = await transfer(
      standardUser,
      10_000,
      `self-${timestamp}`,
      standardUser.accountId,
    ); // self-transfer

    assert(
      resC1.status === 400,
      `Missing idempotency key should return 400: ${JSON.stringify(resC1)}`,
    );

    assert(
      resC2.status === 400 && resC2.data.error?.code === "self_transfer",
      `Self-transfer should return 400: ${JSON.stringify(resC2)}`,
    );

    console.log("✅ PASS: Missing key and self-transfer are rejected.\n");
    passedCount++;

    // TEST D: Insufficient balance
    console.log("🧪 Test D: Insufficient Balance");

    const currentBalance = await getBalance(standardUser);
    const excessiveAmount = currentBalance + 1_000;

    assert(
      excessiveAmount <= 10_000_000,
      "Test balance exceeds the configured transfer maximum; adjust test funding.",
    );

    const resD = await transfer(
      standardUser,
      excessiveAmount,
      `insufficient-${timestamp}`,
    );

    assert(
      resD.status === 200 &&
        resD.data.status === "declined" &&
        resD.data.reason === "insufficient_balance",
      `Expected insufficient-balance decline: ${JSON.stringify(resD)}`,
    );

    console.log("✅ PASS: Insufficient balance returns declined.\n");
    passedCount++;

    // TEST E: Velocity limit
    console.log("🧪 Test E: Velocity Limit (11 requests)");

    const velocityResults: ApiResponse[] = [];

    for (let i = 1; i <= 11; i++) {
      const result = await transfer(
        velocityUser,
        1_000,
        `velocity-${timestamp}-${i}`,
      );

      velocityResults.push(result);

      console.log(
        `   Request ${i}: HTTP ${result.status}, status=${result.data.status}, reason=${result.data.reason ?? "n/a"}`,
      );
    }

    const eleventh = velocityResults[10];

    assert(
      eleventh.status === 200 &&
        eleventh.data.status === "declined" &&
        eleventh.data.reason === "velocity",
      `11th request was not declined for velocity: ${JSON.stringify(eleventh)}`,
    );

    assert(
      velocityResults
        .slice(0, 10)
        .every(
          (result) => result.status === 201 && result.data.status === "held",
        ),
      "One or more of the first 10 requests did not return held.",
    );

    console.log("✅ PASS: First 10 held; 11th declined for velocity.\n");
    passedCount++;

    // TEST F: Concurrency
    console.log("🧪 Test F: 30 Concurrent Requests With the Same Key");

    const concurrentKey = `concurrent-${timestamp}`;
    const concurrentAmount = 10_000;

    const beforeBalance = await getBalance(concurrencyUser);

    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        transfer(concurrencyUser, concurrentAmount, concurrentKey),
      ),
    );

    const heldResults = results.filter(
      (result) => result.status === 201 && result.data.status === "held",
    );

    const replayResults = results.filter(
      (result) => result.status === 200 && result.data.replayed === true,
    );

    const transferIds = new Set(
      results.map((result) => result.data.transfer_id).filter(Boolean),
    );

    const failedResults = results.filter(
      (result) =>
        !(
          (result.status === 201 && result.data.status === "held") ||
          (result.status === 200 && result.data.replayed === true)
        ),
    );

    assert(
      heldResults.length === 1 &&
        replayResults.length === 29 &&
        transferIds.size === 1 &&
        failedResults.length === 0,
      `Concurrency failure: held=${heldResults.length}, replayed=${replayResults.length}, unique IDs=${transferIds.size}, unexpected responses=${failedResults.length}`,
    );

    const afterBalance = await getBalance(concurrencyUser);

    assert(
      beforeBalance - afterBalance === concurrentAmount,
      `Expected exactly one debit of ${concurrentAmount}; before=${beforeBalance}, after=${afterBalance}`,
    );

    // Verify that the database has exactly one transfer for this key.
    const dbResult = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM transfers
       WHERE sender_account_id = $1
         AND idempotency_key = $2`,
      [concurrencyUser.accountId, concurrentKey],
    );

    assert(
      dbResult.rows[0].count === 1,
      `Expected one transfer row in the database; found ${dbResult.rows[0].count}`,
    );

    console.log("✅ PASS: 1 held, 29 replays, one transfer row, one debit.\n");
    passedCount++;
  } catch (error) {
    console.error("\n❌ TEST FAILURE:", error);
  } finally {
    console.log("\n🧹 Cleaning up test data...");

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const accountIds = users.map((user) => user.accountId);

      if (accountIds.length > 0) {
        await client.query(
          `DELETE FROM ledger
           WHERE transfer_id IN (
             SELECT id
             FROM transfers
             WHERE sender_account_id = ANY($1::uuid[])
                OR receiver_account_id = ANY($1::uuid[])
           )`,
          [accountIds],
        );

        await client.query(
          `DELETE FROM transfers
           WHERE sender_account_id = ANY($1::uuid[])
              OR receiver_account_id = ANY($1::uuid[])`,
          [accountIds],
        );

        await client.query(
          "DELETE FROM ledger WHERE account_id = ANY($1::uuid[])",
          [accountIds],
        );

        await client.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [
          accountIds,
        ]);
      }

      await client.query("DELETE FROM users WHERE email = ANY($1::text[])", [
        testEmails,
      ]);

      await client.query("COMMIT");

      console.log("✅ Test data cleanup committed.");
    } catch (cleanupError) {
      await client.query("ROLLBACK").catch(() => undefined);

      console.error("❌ Cleanup failed and was rolled back:", cleanupError);
    } finally {
      client.release();
      await pool.end();
    }

    console.log(
      `\n🏆 RESULTS: ${passedCount}/${totalTests} test categories passed.`,
    );
  }
}

runAdvancedTests().catch((error) => {
  console.error("❌ Fatal test error:", error);
  process.exitCode = 1;
});
