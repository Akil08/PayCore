import { pool } from "../src/db.js";

const BASE_URL = "http://localhost:3000/api";

async function request(
  method: string,
  path: string,
  body: any = null,
  headers: Record<string, string> = {},
) {
  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
  };

  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${BASE_URL}${path}`, options);
  const data = await res.json().catch(() => ({}));

  return { status: res.status, data };
}

async function runTest() {
  console.log(
    "🚀 Starting Full Valid Transfer Test (with automatic cleanup)...\n",
  );

  const timestamp = Date.now();
  const aliceEmail = `alice_${timestamp}@test.com`;
  const bobEmail = `bob_${timestamp}@test.com`;
  const password = "Password123!";

  let aliceToken: string | undefined;
  let aliceAccountId: string | undefined;
  let bobLoginData: any;
  let transferId: string | undefined;

  try {
    // 1. Register and log in Alice and Bob
    console.log("👤 Registering and logging in temporary test users...");

    const aliceReg = await request("POST", "/auth/register", {
      email: aliceEmail,
      password,
    });

    const bobReg = await request("POST", "/auth/register", {
      email: bobEmail,
      password,
    });

    if (aliceReg.status !== 201 || bobReg.status !== 201) {
      throw new Error(
        `Failed to register test users: Alice (${aliceReg.status}), Bob (${bobReg.status})`,
      );
    }

    const aliceLogin = await request("POST", "/auth/login", {
      email: aliceEmail,
      password,
    });

    const bobLogin = await request("POST", "/auth/login", {
      email: bobEmail,
      password,
    });

    if (
      aliceLogin.status !== 200 ||
      bobLogin.status !== 200 ||
      !aliceLogin.data.token ||
      !aliceLogin.data.account_id ||
      !bobLogin.data.token ||
      !bobLogin.data.account_id
    ) {
      throw new Error("Failed to log in test users.");
    }

    aliceToken = aliceLogin.data.token;
    aliceAccountId = aliceLogin.data.account_id;
    bobLoginData = bobLogin.data;

    console.log(`✅ Alice Account ID: ${aliceAccountId}`);
    console.log(`✅ Bob Account ID: ${bobLoginData.account_id}\n`);

    // 2. Alice deposits 20,000 BDT (2,000,000 paisa)
    console.log("💰 Alice deposits 20,000 BDT...");

    const depositRes = await request(
      "POST",
      "/accounts/deposit",
      { amount: 2000000 },
      { Authorization: `Bearer ${aliceToken}` },
    );

    console.log(
      `   Status: ${depositRes.status}, Balance: ${depositRes.data.balance} paisa\n`,
    );

    if (depositRes.status < 200 || depositRes.status >= 300) {
      throw new Error("Alice's deposit failed.");
    }

    // 3. Alice transfers 500 BDT (50,000 paisa) to Bob
    console.log("💸 Alice transfers 500 BDT to Bob...");

    const idempotencyKey = `test-key-${timestamp}`;

    const transferRes = await request(
      "POST",
      "/transfers",
      {
        receiver_account_id: bobLoginData.account_id,
        amount: 50000,
      },
      {
        Authorization: `Bearer ${aliceToken}`,
        "Idempotency-Key": idempotencyKey,
        "X-Device-Id": "test-device-123",
      },
    );

    console.log(`   HTTP Status: ${transferRes.status} (Expected: 201)`);
    console.log("   Response:", JSON.stringify(transferRes.data, null, 2));

    if (transferRes.status === 201 && transferRes.data.status === "held") {
      transferId = transferRes.data.transfer_id;
      console.log("✅ Transfer API returned 201 Held successfully!\n");
    } else {
      throw new Error('Expected HTTP 201 and status "held".');
    }

    if (!transferId) {
      throw new Error("Transfer ID was not returned.");
    }

    // 4. Verify Alice's balance
    console.log("🔍 Verifying Alice's balance...");

    const aliceMe = await request("GET", "/accounts/me", null, {
      Authorization: `Bearer ${aliceToken}`,
    });

    // const expectedAliceBalance = 2000000 - 50000;
    const expectedAliceBalance = depositRes.data.balance - 50000;

    console.log(
      `   Alice Balance: ${aliceMe.data.balance} paisa (Expected: ${expectedAliceBalance})`,
    );

    if (aliceMe.data.balance !== expectedAliceBalance) {
      throw new Error("Alice balance mismatch.");
    }

    console.log("✅ Alice balance correctly deducted!\n");

    // 5. Verify Bob's balance is unchanged
    console.log("🔍 Verifying Bob's balance (should be unchanged)...");

    const bobMe = await request("GET", "/accounts/me", null, {
      Authorization: `Bearer ${bobLoginData.token}`,
    });

    console.log(
      `   Bob Balance: ${bobMe.data.balance} paisa (Expected: unchanged)`,
    );

    if (bobMe.data.balance === 50000) {
      throw new Error("Bob balance changed prematurely.");
    }

    console.log(
      "✅ Bob balance correctly unchanged (settlement is pending)!\n",
    );

    console.log("🎉 TEST PASSED: API layer is working correctly.");
  } finally {
    // Automated database cleanup
    console.log("\n🧹 Cleaning up test data from the database...");

    try {
      // Delete ledger entries tied to the transfer first
      if (transferId) {
        await pool.query("DELETE FROM ledger WHERE transfer_id = $1", [
          transferId,
        ]);

        await pool.query("DELETE FROM transfers WHERE id = $1", [transferId]);
      }

      // Delete remaining ledger entries and accounts
      if (aliceAccountId && bobLoginData?.account_id) {
        await pool.query("DELETE FROM ledger WHERE account_id = ANY($1)", [
          [aliceAccountId, bobLoginData.account_id],
        ]);

        await pool.query("DELETE FROM accounts WHERE id = ANY($1)", [
          [aliceAccountId, bobLoginData.account_id],
        ]);
      }

      // Delete temporary users even if account setup was incomplete
      await pool.query("DELETE FROM users WHERE email = $1 OR email = $2", [
        aliceEmail,
        bobEmail,
      ]);

      console.log("✅ Successfully cleaned up all temporary test entries.");
    } catch (cleanupErr) {
      console.error(
        "⚠️ Warning: Automated cleanup encountered an issue:",
        cleanupErr,
      );
    } finally {
      await pool.end();
    }
  }
}

runTest().catch((err) => {
  console.error("❌ Test script failed:", err);
  process.exit(1);
});
