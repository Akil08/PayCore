import "dotenv/config";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

const API = process.env.API_BASE_URL ?? "http://localhost:3000";
const REGISTER_PATH = "/api/auth/register";
const LOGIN_PATH = "/api/auth/login";
const AMOUNT = 1_000; // Integer in the API's smallest currency unit
const TIMEOUT_MS = 30_000;
const POLL_MS = 500;

type Json = Record<string, any>;

const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function request(
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: Json;
    idempotencyKey?: string;
  } = {},
): Promise<{ status: number; data: Json }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  const response = await fetch(`${API}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let data: Json = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  return { status: response.status, data };
}

async function waitFor(
  description: string,
  check: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await check()) {
      console.log(`PASS: ${description}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  throw new Error(`Timed out waiting for: ${description}`);
}

async function main(): Promise<void> {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const password = `Test-${randomUUID()}-Aa1!`;
  const senderEmail = `s6-sender-${suffix}@example.test`;
  const receiverEmail = `s6-receiver-${suffix}@example.test`;

  let senderAccountId = "";
  let receiverAccountId = "";
  let transferId = "";

  await db.connect();

  try {
    console.log("\nPayCore Session 6 end-to-end test\n");
    console.log(`API: ${API}`);

    // Capture the existing global ledger sum. A known pre-existing
    // imbalance must be reported, not silently repaired.
    const baselineResult = await db.query(
      "SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger",
    );
    const baselineLedgerSum = BigInt(baselineResult.rows[0].total);

    if (baselineLedgerSum !== 0n) {
      console.warn(
        `WARN: Pre-existing global ledger imbalance: ${baselineLedgerSum} paisa`,
      );
    } else {
      console.log("PASS: Global ledger is balanced before the test.");
    }

    // 1. Register two isolated users.
    for (const email of [senderEmail, receiverEmail]) {
      const result = await request(REGISTER_PATH, {
        method: "POST",
        body: { email, password },
      });

      assert(
        result.status >= 200 && result.status < 300,
        `Registration failed for ${email}: HTTP ${result.status} ${JSON.stringify(result.data)}`,
      );
    }
    console.log("PASS: Both users registered through the API.");

    // 2. Log in as each user.
    async function login(email: string): Promise<string> {
      const result = await request(LOGIN_PATH, {
        method: "POST",
        body: { email, password },
      });

      assert(
        result.status >= 200 && result.status < 300,
        `Login failed for ${email}: HTTP ${result.status}`,
      );

      const token =
        result.data.token ??
        result.data.access_token ??
        result.data.accessToken;

      assert(
        typeof token === "string",
        "Login response has no recognized token field.",
      );
      return token;
    }

    const senderToken = await login(senderEmail);
    const receiverToken = await login(receiverEmail);
    console.log("PASS: Both users logged in and received tokens.");

    // Resolve the actual account IDs from the database.
    const accounts = await db.query(
      `SELECT u.email, a.id AS account_id, a.balance::text AS balance
       FROM users u
       JOIN accounts a ON a.user_id = u.id
       WHERE u.email = ANY($1::text[])`,
      [[senderEmail, receiverEmail]],
    );

    assert(accounts.rows.length === 2, "Expected exactly two test accounts.");

    for (const row of accounts.rows) {
      if (row.email === senderEmail) senderAccountId = row.account_id;
      if (row.email === receiverEmail) receiverAccountId = row.account_id;
    }

    assert(
      senderAccountId && receiverAccountId,
      "Could not resolve both account IDs.",
    );
    assert(
      senderAccountId !== receiverAccountId,
      "Test accounts unexpectedly match.",
    );

    const senderBefore = BigInt(
      accounts.rows.find((r: Json) => r.email === senderEmail).balance,
    );
    const receiverBefore = BigInt(
      accounts.rows.find((r: Json) => r.email === receiverEmail).balance,
    );

    assert(
      senderBefore >= BigInt(AMOUNT),
      "Sender does not have enough funds.",
    );

    // 3. Submit the transfer through the real authenticated API.
    const idempotencyKey = `session6-${randomUUID()}`;

    const submitted = await request("/api/transfers", {
      method: "POST",
      token: senderToken,
      idempotencyKey,
      body: {
        receiver_account_id: receiverAccountId,
        amount: AMOUNT,
      },
    });

    assert(
      submitted.status === 201,
      `Expected HTTP 201 for a newly held transfer; got ${submitted.status}: ${JSON.stringify(submitted.data)}`,
    );
    assert(submitted.data.status === "held", "Transfer was not held.");

    transferId = submitted.data.transfer_id;
    assert(
      typeof transferId === "string",
      "Transfer response has no transfer_id.",
    );

    console.log(`PASS: Transfer created and held: ${transferId}`);

    // 4. Verify that the hold has been recorded and published.
    await waitFor("transfer.held outbox event sent", async () => {
      const result = await db.query(
        `SELECT 1 FROM outbox
         WHERE event_type = 'transfer.held'
           AND payload->>'transfer_id' = $1
           AND status = 'sent'
         LIMIT 1`,
        [transferId],
      );
      return result.rowCount === 1;
    });

    // 5. Wait for the actual worker to settle the transfer.
    await waitFor("settlement worker changed transfer to settled", async () => {
      const result = await db.query(
        "SELECT status FROM transfers WHERE id = $1",
        [transferId],
      );
      return result.rows[0]?.status === "settled";
    });

    console.log("PASS: Settlement completed.");

    // Verify the receiver's settled event was created.
    await waitFor("transfer.settled event exists in outbox", async () => {
      const result = await db.query(
        `SELECT 1 FROM outbox
         WHERE event_type = 'transfer.settled'
           AND payload->>'transfer_id' = $1
         LIMIT 1`,
        [transferId],
      );
      return result.rowCount === 1;
    });

    // 6. Verify final balances and the transfer's double-entry ledger.
    const finalAccounts = await db.query(
      `SELECT a.id, a.balance::text AS balance,
              COALESCE(SUM(l.amount), 0)::text AS ledger_sum
       FROM accounts a
       LEFT JOIN ledger l ON l.account_id = a.id
       WHERE a.id = ANY($1::uuid[])
       GROUP BY a.id, a.balance`,
      [[senderAccountId, receiverAccountId]],
    );

    assert(
      finalAccounts.rows.length === 2,
      "Could not read both final accounts.",
    );

    for (const row of finalAccounts.rows) {
      assert(
        BigInt(row.balance) === BigInt(row.ledger_sum),
        `Account ${row.id}: stored balance ${row.balance} != ledger sum ${row.ledger_sum}`,
      );
    }

    const senderAfter = BigInt(
      finalAccounts.rows.find((r: Json) => r.id === senderAccountId).balance,
    );
    const receiverAfter = BigInt(
      finalAccounts.rows.find((r: Json) => r.id === receiverAccountId).balance,
    );

    assert(
      senderAfter === senderBefore - BigInt(AMOUNT),
      `Unexpected sender balance delta: before=${senderBefore}, after=${senderAfter}`,
    );
    assert(
      receiverAfter === receiverBefore + BigInt(AMOUNT),
      `Unexpected receiver balance delta: before=${receiverBefore}, after=${receiverAfter}`,
    );

    const ledger = await db.query(
      `SELECT account_id, SUM(amount)::text AS total
       FROM ledger
       WHERE transfer_id = $1
       GROUP BY account_id`,
      [transferId],
    );

    const ledgerTotals = new Map<string, bigint>(
      ledger.rows.map((row: Json) => [row.account_id, BigInt(row.total)]),
    );

    assert(
      ledgerTotals.get(senderAccountId) === -BigInt(AMOUNT),
      "Sender's transfer ledger total is not -amount.",
    );
    assert(
      ledgerTotals.get(receiverAccountId) === BigInt(AMOUNT),
      "Receiver's transfer ledger total is not +amount.",
    );

    const transitId = "00000000-0000-0000-0000-000000000002";
    assert(
      ledgerTotals.get(transitId) === 0n,
      "In-transit ledger did not net to zero after settlement.",
    );

    const transferLedgerSum = [...ledgerTotals.values()].reduce(
      (sum, amount) => sum + amount,
      0n,
    );
    assert(
      transferLedgerSum === 0n,
      "Transfer ledger entries do not sum to zero.",
    );

    console.log(
      "PASS: Sender debit and receiver credit match the requested amount.",
    );
    console.log("PASS: Both account balances match their ledger sums.");
    console.log(
      "PASS: Transfer ledger is balanced and in-transit nets to zero.",
    );

    // 7. Repeat the exact request with the same idempotency key.
    const replay = await request("/api/transfers", {
      method: "POST",
      token: senderToken,
      idempotencyKey,
      body: {
        receiver_account_id: receiverAccountId,
        amount: AMOUNT,
      },
    });

    assert(
      replay.status === 200 &&
        replay.data.replayed === true &&
        replay.data.transfer_id === transferId,
      `Same-key retry did not replay the original transfer: ${JSON.stringify(replay.data)}`,
    );

    const conflict = await request("/api/transfers", {
      method: "POST",
      token: senderToken,
      idempotencyKey,
      body: {
        receiver_account_id: receiverAccountId,
        amount: AMOUNT + 1,
      },
    });

    assert(
      conflict.status === 409,
      `Expected HTTP 409 for a reused key with a different payload; got ${conflict.status}`,
    );

    const afterReplay = await db.query(
      "SELECT balance::text AS balance FROM accounts WHERE id = $1",
      [receiverAccountId],
    );

    assert(
      BigInt(afterReplay.rows[0].balance) === receiverAfter,
      "Idempotent replay changed the receiver's balance.",
    );

    console.log("PASS: Idempotent retry did not create a second payment.");
    console.log(
      "PASS: Reusing the key with a different payload returns HTTP 409.",
    );

    // 8. Confirm the test did not make the global imbalance worse.
    const finalSumResult = await db.query(
      "SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger",
    );
    const finalLedgerSum = BigInt(finalSumResult.rows[0].total);

    assert(
      finalLedgerSum === baselineLedgerSum,
      `Global ledger sum changed: before=${baselineLedgerSum}, after=${finalLedgerSum}`,
    );

    if (finalLedgerSum === 0n) {
      console.log("PASS: Global ledger sum remains zero.");
    } else {
      console.warn(
        `WARN: Global ledger remains imbalanced at ${finalLedgerSum} paisa; pre-existing imbalance was preserved.`,
      );
    }

    console.log("\nEND-TO-END CORE FLOW PASSED.");
    console.log(`Transfer ID: ${transferId}`);
    console.log(`Sender: ${senderBefore} -> ${senderAfter}`);
    console.log(`Receiver: ${receiverBefore} -> ${receiverAfter}`);
    console.log(
      "\nNote: Failure injection, retry/dead-letter exhaustion, and duplicate broker delivery require separate tests of the consumer runner and queue topology.",
    );
  } finally {
    // Deliberately do not delete users, ledger rows, or test transfers.
    await db.end();
  }
}

main().catch((error) => {
  console.error("\nSESSION 6 E2E TEST FAILED");
  console.error(error);
  process.exitCode = 1;
});
