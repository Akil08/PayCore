import "dotenv/config";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const API = process.env.API_BASE_URL ?? "http://localhost:3000";
const TIMEOUT_MS = 120_000;
const POLL_MS = 500;
const FAILURE_RATE = 0.5;
const AMOUNT = 10_000; // 100 BDT, in integer paisa

type Json = Record<string, any>;

const databaseUrl = process.env.DATABASE_URL;
const adminUrl = process.env.DATABASE_ADMIN_URL;
const targetDbName = process.env.PAYCORE_TEST_DB_NAME;

if (!databaseUrl || !adminUrl || !targetDbName) {
  throw new Error(
    "DATABASE_URL, DATABASE_ADMIN_URL and PAYCORE_TEST_DB_NAME are required.",
  );
}

if (process.env.PAYCORE_DISPOSABLE_DB !== "true") {
  throw new Error(
    "Safety stop: set PAYCORE_DISPOSABLE_DB=true only for a disposable test database.",
  );
}

function dbName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ""));
}

if (dbName(databaseUrl) !== targetDbName) {
  throw new Error(
    "Safety stop: DATABASE_URL does not match PAYCORE_TEST_DB_NAME.",
  );
}

if (dbName(adminUrl) === targetDbName) {
  throw new Error(
    "DATABASE_ADMIN_URL must connect to a different maintenance database.",
  );
}

if (["postgres", "production", "prod"].includes(targetDbName.toLowerCase())) {
  throw new Error("Refusing to destroy a protected database name.");
}

const ssl =
  process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false;

const db = new Client({
  connectionString: databaseUrl,
  ssl,
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function apiCall(
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: Json;
    key?: string;
    device?: string;
  } = {},
): Promise<{ status: number; data: Json }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (options.key) {
    headers["Idempotency-Key"] = options.key;
  }
  if (options.device) {
    headers["X-Device-Id"] = options.device;
  }

  const response = await fetch(`${API}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(15_000),
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
  timeout = TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await check()) {
      console.log(`PASS: ${description}`);
      return;
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  throw new Error(`Timed out: ${description}`);
}

async function registerUser(email: string, password: string) {
  const result = await apiCall("/api/auth/register", {
    method: "POST",
    body: { email, password },
  });

  assert(
    result.status === 201,
    `Registration failed for ${email}: HTTP ${result.status} ${JSON.stringify(result.data)}`,
  );

  assert(
    typeof result.data.user?.id === "string" &&
      typeof result.data.token === "string" &&
      typeof result.data.account_id === "string",
    `Invalid registration response for ${email}`,
  );

  return {
    id: result.data.user.id as string,
    token: result.data.token as string,
    accountId: result.data.account_id as string,
  };
}

async function resetDisposableDatabase(): Promise<void> {
  // The test DB connection must be closed before PostgreSQL can drop it.
  await db.end();

  const admin = new Client({
    connectionString: adminUrl,
    ssl,
  });

  await admin.connect();

  try {
    const quotedName = `"${targetDbName!.replace(/"/g, '""')}"`;

    await admin.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1
         AND pid <> pg_backend_pid()`,
      [targetDbName],
    );

    await admin.query(`DROP DATABASE ${quotedName}`);
    await admin.query(`CREATE DATABASE ${quotedName}`);
  } finally {
    await admin.end();
  }

  // Recreate the canonical schema and the two system accounts.
  const freshDb = new Client({
    connectionString: databaseUrl,
    ssl,
  });

  await freshDb.connect();

  try {
    const schema = await readFile(
      resolve(process.cwd(), "sql/schema.sql"),
      "utf8",
    );

    await freshDb.query(schema);

    const verification = await freshDb.query(
      `SELECT
         (SELECT COUNT(*)::int FROM users) AS users,
         (SELECT COUNT(*)::int FROM transfers) AS transfers,
         (SELECT COUNT(*)::int FROM ledger) AS ledger,
         (SELECT COUNT(*)::int FROM outbox) AS outbox,
         (SELECT COUNT(*)::int FROM dead_letters) AS dead_letters,
         (SELECT COUNT(*)::int FROM processed_events) AS processed_events,
         (SELECT COALESCE(SUM(amount), 0)::text FROM ledger) AS ledger_sum`,
    );

    const row = verification.rows[0];

    assert(Number(row.users) === 0, "Users remain after database recreation.");
    assert(
      Number(row.transfers) === 0,
      "Transfers remain after database recreation.",
    );
    assert(
      Number(row.ledger) === 0,
      "Ledger rows remain after database recreation.",
    );
    assert(
      Number(row.outbox) === 0,
      "Outbox rows remain after database recreation.",
    );
    assert(
      Number(row.dead_letters) === 0,
      "Dead letters remain after database recreation.",
    );
    assert(
      Number(row.processed_events) === 0,
      "Processed events remain after database recreation.",
    );
    assert(BigInt(row.ledger_sum) === 0n, "Fresh ledger is not balanced.");

    const systemAccounts = await freshDb.query(
      `SELECT id FROM accounts
       WHERE id = ANY($1::uuid[])`,
      [
        [
          "00000000-0000-0000-0000-000000000001",
          "00000000-0000-0000-0000-000000000002",
        ],
      ],
    );

    assert(
      systemAccounts.rows.length === 2,
      "Fresh schema is missing one or both system accounts.",
    );
  } finally {
    await freshDb.end();
  }

  console.log("PASS: disposable database recreated and verified clean.");
}

async function main(): Promise<void> {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const password = `PayCore-${randomUUID()}-Aa1!`;

  let testError: unknown;
  let resetError: unknown;

  assert(
    process.env.SETTLE_FAILURE_RATE === String(FAILURE_RATE),
    "Set SETTLE_FAILURE_RATE=0.5 and restart the API before running this test.",
  );

  await db.connect();

  try {
    // 1. Baseline and API health
    console.log("\n--- Phase 1: baseline ---");

    const health = await apiCall("/health");

    assert(
      health.status === 200 &&
        health.data.ok === true &&
        health.data.db === true,
      `API health check failed: ${JSON.stringify(health)}`,
    );

    const baseline = await db.query(
      "SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger",
    );

    assert(
      BigInt(baseline.rows[0].total) === 0n,
      "Test DB has a nonzero global ledger sum before testing.",
    );

    console.log("PASS: API healthy; baseline ledger sum is zero.");

    // 2. Happy path
    console.log("\n--- Phase 2: happy path and idempotency ---");

    const sender = await registerUser(
      `s6-sender-${suffix}@test.invalid`,
      password,
    );

    const receiver = await registerUser(
      `s6-receiver-${suffix}@test.invalid`,
      password,
    );

    const key = `s6-happy-${randomUUID()}`;

    const transfer = await apiCall("/api/transfers", {
      method: "POST",
      token: sender.token,
      key,
      device: `s6-device-${suffix}`,
      body: {
        receiver_account_id: receiver.accountId,
        amount: AMOUNT,
      },
    });

    assert(
      transfer.status === 201 && transfer.data.status === "held",
      `Expected held transfer: ${JSON.stringify(transfer)}`,
    );

    const transferId = transfer.data.transfer_id as string;

    assert(typeof transferId === "string", "Missing transfer_id.");

    await waitFor("happy-path transfer settles", async () => {
      const result = await db.query(
        "SELECT status FROM transfers WHERE id = $1",
        [transferId],
      );

      return result.rows[0]?.status === "settled";
    });

    const replay = await apiCall("/api/transfers", {
      method: "POST",
      token: sender.token,
      key,
      device: `s6-device-${suffix}`,
      body: {
        receiver_account_id: receiver.accountId,
        amount: AMOUNT,
      },
    });

    assert(
      replay.status === 200 &&
        replay.data.transfer_id === transferId &&
        replay.data.replayed === true,
      `Idempotency replay failed: ${JSON.stringify(replay)}`,
    );

    const settlementRows = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM ledger
       WHERE transfer_id = $1 AND reason = 'settle'`,
      [transferId],
    );

    assert(
      settlementRows.rows[0].count === 2,
      "Expected exactly two settlement ledger rows.",
    );

    console.log(
      "PASS: transfer settled, replayed safely, and has one settlement pair.",
    );

    // 3. Failure injection and dead-letter queue.
    console.log("\n--- Phase 3: failure injection and DLQ ---");

    // With 50% independent failure probability and five total attempts,
    // a delivery reaches the DLQ with probability approximately 1/32.
    // 120 samples make observing at least one DLQ entry likely, not guaranteed.
    const sampleSize = 120;
    const failureTransferIds: string[] = [];

    for (let i = 0; i < sampleSize; i++) {
      // Fresh sender accounts prevent velocity rules from declining
      // later transfers before they reach the settlement consumer.
      const failureSender = await registerUser(
        `s6-fs-${suffix}-${i}@test.invalid`,
        password,
      );

      const failureReceiver = await registerUser(
        `s6-fr-${suffix}-${i}@test.invalid`,
        password,
      );

      const response = await apiCall("/api/transfers", {
        method: "POST",
        token: failureSender.token,
        key: `s6-failure-${suffix}-${i}-${randomUUID()}`,
        device: `s6-failure-device-${suffix}-${i}`,
        body: {
          receiver_account_id: failureReceiver.accountId,
          amount: AMOUNT,
        },
      });

      assert(
        response.status === 201 && response.data.status === "held",
        `Failure transfer ${i} was not held: ${JSON.stringify(response)}`,
      );

      assert(
        typeof response.data.transfer_id === "string",
        `Failure transfer ${i} has no ID.`,
      );

      failureTransferIds.push(response.data.transfer_id);
    }

    await waitFor(
      "all failure transfers settle or reach settlement DLQ",
      async () => {
        const result = await db.query(
          `SELECT t.id, t.status,
             EXISTS (
               SELECT 1 FROM dead_letters dl
               WHERE dl.queue = 'settlement.q'
                 AND dl.replayed_at IS NULL
                 AND (
                   dl.payload->>'transfer_id' = t.id::text
                   OR dl.payload->'payload'->>'transfer_id' = t.id::text
                 )
             ) AS in_dlq
           FROM transfers t
           WHERE t.id = ANY($1::uuid[])`,
          [failureTransferIds],
        );

        return (
          result.rows.length === sampleSize &&
          result.rows.every(
            (r: any) => r.status === "settled" || r.in_dlq === true,
          )
        );
      },
    );

    const outcomes = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'settled')::int AS settled
       FROM transfers
       WHERE id = ANY($1::uuid[])`,
      [failureTransferIds],
    );

    const dlq = await db.query(
      `SELECT COUNT(DISTINCT t.id)::int AS count
       FROM transfers t
       JOIN dead_letters dl
         ON dl.queue = 'settlement.q'
        AND dl.replayed_at IS NULL
        AND (
          dl.payload->>'transfer_id' = t.id::text
          OR dl.payload->'payload'->>'transfer_id' = t.id::text
        )
       WHERE t.id = ANY($1::uuid[])`,
      [failureTransferIds],
    );

    assert(
      outcomes.rows[0].total === sampleSize,
      "Not all failure-injection transfers were found.",
    );

    assert(
      outcomes.rows[0].settled > 0,
      "No failure-injection transfers settled.",
    );

    assert(
      dlq.rows[0].count > 0,
      "No transfer reached the DLQ. The failure-injection test did not prove DLQ behavior.",
    );

    const duplicateSettlements = await db.query(
      `SELECT transfer_id
       FROM ledger
       WHERE transfer_id = ANY($1::uuid[])
         AND reason = 'settle'
       GROUP BY transfer_id
       HAVING COUNT(*) > 2`,
      [failureTransferIds],
    );

    assert(
      duplicateSettlements.rows.length === 0,
      "A failure-injection transfer has duplicate settlement entries.",
    );

    console.log(
      `PASS: ${sampleSize} transfers tested; ${outcomes.rows[0].settled} settled and ${dlq.rows[0].count} reached DLQ.`,
    );

    // 4. Redelivery safety
    console.log("\n--- Phase 4: redelivery safety ---");

    await db.query(
      `INSERT INTO outbox (event_type, payload, status)
       VALUES ('transfer.held', $1::jsonb, 'pending')`,
      [
        JSON.stringify({
          transfer_id: transferId,
          sender_account_id: sender.accountId,
          receiver_account_id: receiver.accountId,
          amount: AMOUNT,
          device_id: `s6-device-${suffix}`,
        }),
      ],
    );

    await waitFor(
      "duplicate held event published and consumed",
      async () => {
        const result = await db.query(
          `SELECT o.id, o.status,
             EXISTS (
               SELECT 1 FROM processed_events pe
               WHERE pe.event_id = o.id::text
             ) AS consumed
           FROM outbox o
           WHERE o.event_type = 'transfer.held'
             AND o.payload->>'transfer_id' = $1
           ORDER BY o.id DESC
           LIMIT 1`,
          [transferId],
        );

        return (
          result.rows[0]?.status === "sent" && result.rows[0]?.consumed === true
        );
      },
      30_000,
    );

    const afterRedelivery = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM ledger
       WHERE transfer_id = $1 AND reason = 'settle'`,
      [transferId],
    );

    assert(
      afterRedelivery.rows[0].count === 2,
      "Redelivery created a duplicate settlement pair.",
    );

    console.log("PASS: duplicate held event did not move money twice.");

    // 5. Financial invariants
    console.log("\n--- Phase 5: financial invariants ---");

    const globalSum = await db.query(
      "SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger",
    );

    assert(
      BigInt(globalSum.rows[0].total) === 0n,
      `Global ledger sum is ${globalSum.rows[0].total}, not zero.`,
    );

    const balanceMismatches = await db.query(
      `SELECT a.id
       FROM accounts a
       LEFT JOIN ledger l ON l.account_id = a.id
       WHERE a.type = 'user'
       GROUP BY a.id, a.balance
       HAVING a.balance <> COALESCE(SUM(l.amount), 0)::bigint`,
    );

    assert(
      balanceMismatches.rows.length === 0,
      "One or more wallet balances do not match the ledger.",
    );

    const transit = await db.query(
      `SELECT
         (SELECT COALESCE(SUM(amount), 0)
          FROM ledger
          WHERE account_id = '00000000-0000-0000-0000-000000000002')::text AS ledger_total,
         (SELECT COALESCE(SUM(amount), 0)
          FROM transfers WHERE status = 'held')::text AS held_total`,
    );

    assert(
      BigInt(transit.rows[0].ledger_total) ===
        BigInt(transit.rows[0].held_total),
      "In-Transit ledger does not match held transfers.",
    );

    console.log(
      "PASS: global ledger, wallet balances, and in-transit invariants.",
    );
  } catch (error) {
    testError = error;
    console.error("\nTEST FAILED:", error);
  } finally {
    // Never delete individual ledger entries. Destroy and rebuild only
    // the explicitly configured disposable test database.
    console.log("\n--- Phase 6: recreate disposable test database ---");

    try {
      await resetDisposableDatabase();
    } catch (error) {
      resetError = error;
      console.error("DATABASE RESET FAILED:", error);
    }
  }

  if (testError || resetError) {
    console.error(
      "\nSESSION 6 FAILED. Review the test error and database reset result.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    "\nSESSION 6 PASSED. Disposable database is clean and schema restored.",
  );
}

main().catch((error) => {
  console.error("FATAL:", error);
  process.exitCode = 1;
});
