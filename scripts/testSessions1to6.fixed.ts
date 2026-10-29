import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import amqp from "amqplib";
import type { QueryResultRow } from "pg";
import { pool } from "../src/db.js";
import { EXTERNAL_BANK_ID } from "../src/config.js";

/**
 * PayCore integration test: Sessions 1–6 (API + Postgres + RabbitMQ settlement).
 *
 * Run from the project root with the API running and RUN_WORKERS=true:
 *   npx tsx scripts/testSessions1to6.ts
 *
 * Optional settlement failure/retry/dead-letter acceptance test:
 *   RUN_FAILURE_INJECTION_TESTS=true npx tsx scripts/testSessions1to6.ts
 * Start the API separately with SETTLE_FAILURE_RATE=0.5 for that mode.
 *
 * This script creates only uniquely named test users. It deletes rows related to
 * those users/transfers in finally, then verifies that the test-associated rows
 * are gone. Do not point it at a production database.
 */

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = (process.env.TEST_BASE_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const SETTLEMENT_TIMEOUT_MS = Number(process.env.TEST_SETTLEMENT_TIMEOUT_MS ?? 10_000);
const FAILURE_BATCH_TIMEOUT_MS = Number(process.env.TEST_FAILURE_BATCH_TIMEOUT_MS ?? 75_000);
const RUN_FAILURE_INJECTION_TESTS = process.env.RUN_FAILURE_INJECTION_TESTS === "true";
const RUN_ID = `it-${Date.now()}-${randomUUID().slice(0, 8)}`;
const PASSWORD = "PayCore-It#12345";
const API_EMAILS = {
  sender: `${RUN_ID}-sender@example.test`,
  receiver: `${RUN_ID}-receiver@example.test`,
  velocity: `${RUN_ID}-velocity@example.test`,
};

interface ApiResult {
  status: number;
  body: any;
}

interface UserFixture {
  email: string;
  token: string;
  userId: string;
  accountId: string;
}

const touchedTransferIds = new Set<string>();
let failureBatchTransferIds: string[] = [];
let failures = 0;
let passes = 0;
let cleanupRequired = false;

function check(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message);
  passes++;
}

function equal<T>(actual: T, expected: T, message: string): void {
  assert.equal(actual, expected, message);
  passes++;
}

async function api(
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await response.text();
  let body: any = null;
  try {
    body = text.length ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(sql, values);
  return result.rows;
}

async function registerUser(email: string): Promise<UserFixture> {
  const result = await api("/api/auth/register", {
    method: "POST",
    body: { email, password: PASSWORD },
  });
  equal(result.status, 201, `register ${email} should return 201; body=${JSON.stringify(result.body)}`);
  check(typeof result.body?.token === "string", `register ${email} should return a token`);
  check(typeof result.body?.user?.id === "string", `register ${email} should return user.id`);
  check(typeof result.body?.account_id === "string", `register ${email} should return account_id`);
  return {
    email,
    token: result.body.token,
    userId: result.body.user.id,
    accountId: result.body.account_id,
  };
}

async function waitFor<T>(
  description: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 125,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last!: T;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${description}; last value=${JSON.stringify(last)}`);
}

async function assertLedgerGlobalInvariant(): Promise<void> {
  const rows = await query<{ total: string | number }>(
    "SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger",
  );
  equal(Number(rows[0]?.total ?? 0), 0, "global double-entry ledger sum must equal zero");
}

async function assertUserBalanceMatchesLedger(accountId: string): Promise<void> {
  const rows = await query<{ balance: string | number; ledger_sum: string | number }>(
    `SELECT a.balance::text AS balance,
            COALESCE(SUM(l.amount), 0)::text AS ledger_sum
       FROM accounts a
       LEFT JOIN ledger l ON l.account_id = a.id
      WHERE a.id = $1
      GROUP BY a.id, a.balance`,
    [accountId],
  );
  equal(rows.length, 1, `account ${accountId} should still exist`);
  equal(Number(rows[0].balance), Number(rows[0].ledger_sum), `account ${accountId} balance must match its ledger`);
  check(Number(rows[0].balance) >= 0, `account ${accountId} balance must not be negative`);
}

async function transferStatus(transferId: string): Promise<string> {
  const rows = await query<{ status: string }>("SELECT status FROM transfers WHERE id = $1", [transferId]);
  assert.equal(rows.length, 1, `transfer ${transferId} exists`);
  return rows[0].status;
}

async function waitForSettled(transferId: string): Promise<void> {
  try {
    await waitFor(
      `transfer ${transferId} to settle`,
      async () => ({ status: await transferStatus(transferId) }),
      (value) => value.status === "settled",
      RUN_FAILURE_INJECTION_TESTS ? FAILURE_BATCH_TIMEOUT_MS : SETTLEMENT_TIMEOUT_MS,
    );
  } catch (error) {
    let diagnostics: unknown = "unavailable";
    try {
      const rows = await query<{
        transfer_status: string;
        outbox_status: string | null;
        held_event_id: string | null;
        settlement_processed: boolean | null;
        open_settlement_dead_letters: number | string;
      }>(
        `SELECT t.status AS transfer_status,
                o.status AS outbox_status,
                o.id::text AS held_event_id,
                CASE WHEN o.id IS NULL THEN NULL ELSE EXISTS (
                  SELECT 1 FROM processed_events p
                   WHERE p.consumer = 'settlement' AND p.event_id::text = o.id::text
                ) END AS settlement_processed,
                (SELECT COUNT(*)::int FROM dead_letters d
                  WHERE d.queue = 'settlement.q'
                    AND d.replayed_at IS NULL
                    AND (d.payload->'payload'->>'transfer_id' = t.id::text
                      OR d.payload->>'transfer_id' = t.id::text)
                ) AS open_settlement_dead_letters
           FROM transfers t
           LEFT JOIN outbox o
             ON o.event_type = 'transfer.held'
            AND o.payload->>'transfer_id' = t.id::text
          WHERE t.id = $1`,
        [transferId],
      );
      diagnostics = rows[0] ?? null;
    } catch {
      // Preserve the settlement timeout; diagnostics are best-effort only.
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}; settlement diagnostics=${JSON.stringify(diagnostics)}`);
  }
}

async function publishDuplicateHeldEvent(transferId: string): Promise<void> {
  const rows = await query<{ id: string | number; event_type: string; payload: unknown }>(
    `SELECT id, event_type, payload
       FROM outbox
      WHERE event_type = 'transfer.held'
        AND payload->>'transfer_id' = $1
      ORDER BY id ASC`,
    [transferId],
  );
  equal(rows.length, 1, "exactly one transfer.held outbox event should exist for the transfer");
  const heldEvent = rows[0];
  const rabbitUrl = process.env.RABBITMQ_URL;
  assert.ok(rabbitUrl, "RABBITMQ_URL is required to test duplicate event delivery");

  const connection = await amqp.connect(rabbitUrl);
  try {
    const channel = await connection.createConfirmChannel();
    try {
      await channel.assertExchange("paycore.events", "topic", { durable: true });
      const envelope = {
        event_id: String(heldEvent.id),
        type: heldEvent.event_type,
        occurred_at: new Date().toISOString(),
        payload: heldEvent.payload,
      };
      await new Promise<void>((resolve, reject) => {
        channel.publish(
          "paycore.events",
          "transfer.held",
          Buffer.from(JSON.stringify(envelope)),
          { persistent: true, contentType: "application/json" },
          (error) => (error ? reject(error) : resolve()),
        );
      });
      await channel.waitForConfirms();
    } finally {
      await channel.close();
    }
  } finally {
    await connection.close();
  }
}

async function testVelocityDecline(receiver: UserFixture): Promise<void> {
  console.log("\n[Sessions 3–5] Velocity threshold should decline the 11th rapid transfer");
  const sender = await registerUser(API_EMAILS.velocity);
  const approvedIds: string[] = [];

  for (let index = 0; index < 10; index++) {
    const result = await api("/api/transfers", {
      method: "POST",
      token: sender.token,
      headers: { "Idempotency-Key": `${RUN_ID}-velocity-${index + 1}` },
      body: { receiver_account_id: receiver.accountId, amount: 1_000 },
    });
    check(
      result.status === 201 && result.body?.status === "held",
      `velocity transfer ${index + 1} should be held; got ${result.status} ${JSON.stringify(result.body)}`,
    );
    const transferId = String(result.body?.transfer_id ?? "");
    check(transferId.length > 0, `velocity transfer ${index + 1} should have transfer_id`);
    approvedIds.push(transferId);
    touchedTransferIds.add(transferId);
  }

  const declined = await api("/api/transfers", {
    method: "POST",
    token: sender.token,
    headers: { "Idempotency-Key": `${RUN_ID}-velocity-11` },
    body: { receiver_account_id: receiver.accountId, amount: 1_000 },
  });
  equal(declined.status, 200, "velocity-triggered decline should return 200");
  equal(declined.body?.status, "declined", "11th rapid transfer should be declined");
  check(typeof declined.body?.transfer_id === "string", "declined transfer should have transfer_id");
  touchedTransferIds.add(declined.body.transfer_id);

  const declineRows = await query<{ count: string | number }>(
    `SELECT COUNT(*)::int AS count FROM outbox
      WHERE event_type = 'transfer.declined'
        AND payload->>'transfer_id' = $1`,
    [declined.body.transfer_id],
  );
  equal(Number(declineRows[0].count), 1, "velocity decline should enqueue one transfer.declined outbox event");

  if (RUN_FAILURE_INJECTION_TESTS) {
    await waitFor(
      "velocity transfers to settle or reach settlement dead-letter",
      () => query<{ id: string; status: string; open_dead_letter: boolean }>(
        `SELECT t.id::text AS id,
                t.status,
                EXISTS (
                  SELECT 1 FROM dead_letters d
                   WHERE d.queue = 'settlement.q'
                     AND d.replayed_at IS NULL
                     AND (d.payload->'payload'->>'transfer_id' = t.id::text
                       OR d.payload->>'transfer_id' = t.id::text)
                ) AS open_dead_letter
           FROM transfers t
          WHERE t.id::text = ANY($1::text[])`,
        [approvedIds],
      ),
      (rows) => rows.length === approvedIds.length && rows.every((row) => row.status === "settled" || row.open_dead_letter),
      FAILURE_BATCH_TIMEOUT_MS,
      250,
    );
  } else {
    for (const transferId of approvedIds) await waitForSettled(transferId);
  }
  await waitFor(
    "velocity decline event to be published",
    () => query<{ status: string }>(
      `SELECT status FROM outbox
        WHERE event_type = 'transfer.declined'
          AND payload->>'transfer_id' = $1`,
      [declined.body.transfer_id],
    ),
    (rows) => rows.length === 1 && rows[0].status === "sent",
    8_000,
  );
}

async function testFailureInjection(receiver: UserFixture): Promise<void> {
  console.log("\n[Session 6] Failure injection/retries/dead-letter batch");
  console.log("Create four senders so no sender reaches the 10-transfers/60-second velocity threshold.");

  const senders: UserFixture[] = [];
  for (let index = 0; index < 4; index++) {
    senders.push(await registerUser(`${RUN_ID}-retry-sender-${index + 1}@example.test`));
  }

  const created: string[] = [];
  for (let index = 0; index < 30; index++) {
    const sender = senders[Math.floor(index / 8)];
    const idempotencyKey = `${RUN_ID}-retry-${index + 1}`;
    const result = await api("/api/transfers", {
      method: "POST",
      token: sender.token,
      headers: { "Idempotency-Key": idempotencyKey, "X-Device-Id": `${RUN_ID}-device-${index + 1}` },
      body: { receiver_account_id: receiver.accountId, amount: 1_000 },
    });
    check(
      (result.status === 201 || result.status === 200) && result.body?.status === "held",
      `failure-batch transfer ${index + 1} should be held; got ${result.status} ${JSON.stringify(result.body)}`,
    );
    check(typeof result.body?.transfer_id === "string", `failure-batch transfer ${index + 1} has transfer_id`);
    created.push(result.body.transfer_id);
    touchedTransferIds.add(result.body.transfer_id);
  }
  failureBatchTransferIds = created;

  const finalRows = await waitFor(
    "all 30 failure-batch transfers to settle or reach settlement dead-letter",
    async () => query<{
      id: string;
      status: string;
      open_dead_letter: boolean;
    }>(
      `SELECT t.id::text AS id,
              t.status,
              EXISTS (
                SELECT 1 FROM dead_letters d
                 WHERE d.queue = 'settlement.q'
                   AND d.replayed_at IS NULL
                   AND (d.payload->'payload'->>'transfer_id' = t.id::text
                     OR d.payload->>'transfer_id' = t.id::text)
              ) AS open_dead_letter
         FROM transfers t
        WHERE t.id::text = ANY($1::text[])`,
      [created],
    ),
    (rows) => rows.length === created.length && rows.every((row) => row.status === "settled" || row.open_dead_letter),
    FAILURE_BATCH_TIMEOUT_MS,
    250,
  );

  equal(finalRows.length, 30, "all 30 failure-batch transfers should remain queryable before cleanup");
  for (const row of finalRows) {
    check(row.status === "settled" || row.open_dead_letter, `transfer ${row.id} must be settled or have an open dead letter`);
    const ledgerRows = await query<{ count: string | number }>(
      "SELECT COUNT(*)::int AS count FROM ledger WHERE transfer_id = $1 AND reason = 'settle'",
      [row.id],
    );
    const count = Number(ledgerRows[0].count);
    check(count === 0 || count === 2, `transfer ${row.id} must have zero or one complete settle ledger pair, found ${count} rows`);
    if (row.status === "settled") equal(count, 2, `settled transfer ${row.id} must have exactly one settle ledger pair`);
    if (row.status !== "settled") equal(count, 0, `non-settled transfer ${row.id} must not have settle ledger entries`);
  }
  await assertLedgerGlobalInvariant();
}

async function cleanupAndVerify(): Promise<void> {
  console.log("\n[Cleanup] Removing only data associated with this run...");
  const emails = [
    API_EMAILS.sender,
    API_EMAILS.receiver,
    API_EMAILS.velocity,
    `${RUN_ID}-retry-sender-1@example.test`,
    `${RUN_ID}-retry-sender-2@example.test`,
    `${RUN_ID}-retry-sender-3@example.test`,
    `${RUN_ID}-retry-sender-4@example.test`,
  ];

  const client = await pool.connect();
  let userIds: string[] = [];
  let accountIds: string[] = [];
  let transferIds: string[] = [];
  let outboxIds: string[] = [];
  let pairedSystemLedgerIds: string[] = [];
  try {
    await client.query("BEGIN");
    const usersResult = await client.query(
      "SELECT id::text AS id FROM users WHERE email = ANY($1::text[]) FOR UPDATE",
      [emails],
    );
    userIds = usersResult.rows.map((row: { id: string }) => row.id);

    if (userIds.length) {
      const accountsResult = await client.query(
        "SELECT id::text AS id FROM accounts WHERE user_id::text = ANY($1::text[]) FOR UPDATE",
        [userIds],
      );
      accountIds = accountsResult.rows.map((row: { id: string }) => row.id);
    }

    if (accountIds.length) {
      const transfersResult = await client.query(
        `SELECT id::text AS id FROM transfers
          WHERE sender_account_id::text = ANY($1::text[])
             OR receiver_account_id::text = ANY($1::text[])
          FOR UPDATE`,
        [accountIds],
      );
      transferIds = transfersResult.rows.map((row: { id: string }) => row.id);
    }
    transferIds = [...new Set([...transferIds, ...touchedTransferIds])];

    // Deposits/withdrawals use transfer_id = NULL. Their user-account ledger rows
    // are scoped by accountIds, but the matching external-bank rows are not. Find
    // those exact double-entry counterparts before deleting the user-account rows.
    // moveMoney runs inside one PostgreSQL transaction, so DEFAULT now() timestamps
    // on the two ledger rows are identical.
    if (accountIds.length) {
      const pairedSystemRows = await client.query(
        `SELECT DISTINCT system_entry.id::text AS id
           FROM ledger system_entry
           JOIN ledger account_entry
             ON system_entry.amount = -account_entry.amount
            AND system_entry.reason = account_entry.reason
            AND system_entry.created_at = account_entry.created_at
            AND system_entry.transfer_id IS NULL
            AND account_entry.transfer_id IS NULL
          WHERE account_entry.account_id::text = ANY($1::text[])
            AND account_entry.reason IN ('deposit', 'withdrawal')
            AND system_entry.account_id::text = $2
            AND system_entry.reason IN ('deposit', 'withdrawal')`,
        [accountIds, EXTERNAL_BANK_ID],
      );
      pairedSystemLedgerIds = pairedSystemRows.rows.map((row: { id: string }) => row.id);
      if (pairedSystemLedgerIds.length) {
        await client.query(
          "DELETE FROM ledger WHERE id::text = ANY($1::text[])",
          [pairedSystemLedgerIds],
        );
      }
    }

    if (transferIds.length) {
      const outboxResult = await client.query(
        "SELECT id::text AS id FROM outbox WHERE payload->>'transfer_id' = ANY($1::text[]) FOR UPDATE",
        [transferIds],
      );
      outboxIds = outboxResult.rows.map((row: { id: string }) => row.id);

      await client.query(
        `DELETE FROM dead_letters
          WHERE payload->'payload'->>'transfer_id' = ANY($1::text[])
             OR payload->>'transfer_id' = ANY($1::text[])`,
        [transferIds],
      );
    }

    if (outboxIds.length) {
      await client.query(
        "DELETE FROM processed_events WHERE event_id::text = ANY($1::text[])",
        [outboxIds],
      );
    }
    if (transferIds.length) {
      await client.query(
        "DELETE FROM outbox WHERE payload->>'transfer_id' = ANY($1::text[])",
        [transferIds],
      );
    }
    if (accountIds.length || transferIds.length) {
      await client.query(
        `DELETE FROM ledger
          WHERE account_id::text = ANY($1::text[])
             OR transfer_id::text = ANY($2::text[])`,
        [accountIds, transferIds],
      );
      for (const table of ["account_flag_log", "signals", "account_clusters", "account_devices", "user_stats"]) {
        await client.query(`DELETE FROM ${table} WHERE account_id::text = ANY($1::text[])`, [accountIds]);
      }
      if (transferIds.length) {
        await client.query("DELETE FROM transfers WHERE id::text = ANY($1::text[])", [transferIds]);
      }
    }
    if (accountIds.length) {
      await client.query("DELETE FROM accounts WHERE id::text = ANY($1::text[])", [accountIds]);
    }
    if (userIds.length) {
      await client.query("DELETE FROM users WHERE id::text = ANY($1::text[])", [userIds]);
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original cleanup error.
    }
    throw error;
  } finally {
    client.release();
  }

  // Explicit residue checks after commit. These queries use this run's unique IDs only.
  const residueChecks: Array<{ label: string; sql: string; values: unknown[] }> = [
    { label: "test users", sql: "SELECT COUNT(*)::int AS count FROM users WHERE email = ANY($1::text[])", values: [emails] },
    { label: "test accounts", sql: "SELECT COUNT(*)::int AS count FROM accounts WHERE id::text = ANY($1::text[])", values: [accountIds] },
    { label: "test transfers", sql: "SELECT COUNT(*)::int AS count FROM transfers WHERE id::text = ANY($1::text[])", values: [transferIds] },
    { label: "test ledger rows", sql: "SELECT COUNT(*)::int AS count FROM ledger WHERE account_id::text = ANY($1::text[]) OR transfer_id::text = ANY($2::text[])", values: [accountIds, transferIds] },
    { label: "paired external-bank ledger rows", sql: "SELECT COUNT(*)::int AS count FROM ledger WHERE id::text = ANY($1::text[])", values: [pairedSystemLedgerIds] },
    { label: "test outbox rows", sql: "SELECT COUNT(*)::int AS count FROM outbox WHERE payload->>'transfer_id' = ANY($1::text[])", values: [transferIds] },
    { label: "test processed event rows", sql: "SELECT COUNT(*)::int AS count FROM processed_events WHERE event_id::text = ANY($1::text[])", values: [outboxIds] },
    { label: "test dead-letter rows", sql: "SELECT COUNT(*)::int AS count FROM dead_letters WHERE payload->'payload'->>'transfer_id' = ANY($1::text[]) OR payload->>'transfer_id' = ANY($1::text[])", values: [transferIds] },
  ];

  for (const table of ["account_flag_log", "signals", "account_clusters", "account_devices", "user_stats"]) {
    residueChecks.push({
      label: `test rows in ${table}`,
      sql: `SELECT COUNT(*)::int AS count FROM ${table} WHERE account_id::text = ANY($1::text[])`,
      values: [accountIds],
    });
  }

  const residue: string[] = [];
  for (const item of residueChecks) {
    const rows = await query<{ count: number | string }>(item.sql, item.values);
    const count = Number(rows[0]?.count ?? 0);
    if (count !== 0) residue.push(`${item.label}: ${count}`);
  }
  if (residue.length) throw new Error(`Cleanup residue detected: ${residue.join(", ")}`);
  console.log("Cleanup verified: no run-associated rows remain in users, accounts, transfers, ledger, outbox, processed_events, dead_letters, or account-analysis tables.");
}

async function main(): Promise<void> {
  console.log(`PayCore integration test run: ${RUN_ID}`);
  console.log(`API base URL: ${BASE_URL}`);
  console.log(`Failure injection mode: ${RUN_FAILURE_INJECTION_TESTS ? "enabled" : "disabled"}`);

  try {
    const health = await api("/health");
    equal(health.status, 200, `/health should return 200; body=${JSON.stringify(health.body)}`);
    equal(health.body?.ok, true, "/health should report ok=true");
    equal(health.body?.db, true, "/health should report db=true");

    // Refuse to mutate a database that already violates the ledger invariant.
    // This catches residues from older test-script versions before another run.
    const baselineRows = await query<{ total: string | number }>(
      "SELECT COALESCE(SUM(amount), 0)::text AS total FROM ledger",
    );
    const baselineLedgerTotal = Number(baselineRows[0]?.total ?? 0);
    if (baselineLedgerTotal !== 0) {
      throw new Error(
        `Preflight refused to run: the ledger global sum is already ${baselineLedgerTotal}, not 0, before this run created data. The database may contain residue from an earlier cleanup. Restore/reset a disposable test database or repair it from a trustworthy record before rerunning.`,
      );
    }

    cleanupRequired = true;
    console.log("\n[Sessions 1–2] Registration, authentication, account balances and ledger-backed operations");
    const sender = await registerUser(API_EMAILS.sender);
    const receiver = await registerUser(API_EMAILS.receiver);

    const senderMe = await api("/api/accounts/me", { token: sender.token });
    equal(senderMe.status, 200, "GET /api/accounts/me should return 200");
    equal(senderMe.body?.account_id, sender.accountId, "account/me account id should match registration");
    equal(Number(senderMe.body?.balance), 1_000_000, "new user should start with 1,000,000 paisa");

    const login = await api("/api/auth/login", {
      method: "POST",
      body: { email: sender.email.toUpperCase(), password: PASSWORD },
    });
    equal(login.status, 200, "valid login should return 200");
    check(typeof login.body?.token === "string", "valid login should return a token");
    equal(login.body?.account_id, sender.accountId, "login should resolve the user's account");

    const invalidLogin = await api("/api/auth/login", {
      method: "POST",
      body: { email: sender.email, password: "wrong-password" },
    });
    equal(invalidLogin.status, 401, "invalid credentials should return 401");

    const lookup = await api(`/api/accounts/lookup?email=${encodeURIComponent(receiver.email)}`, { token: sender.token });
    equal(lookup.status, 200, "account lookup should return 200");
    equal(lookup.body?.account_id, receiver.accountId, "lookup should return receiver account id");

    const deposit = await api("/api/accounts/deposit", {
      method: "POST",
      token: sender.token,
      body: { amount: 5_000 },
    });
    equal(deposit.status, 200, "valid deposit should return 200");
    equal(Number(deposit.body?.balance), 1_005_000, "deposit should increase balance by 5,000 paisa");

    const withdrawal = await api("/api/accounts/withdraw", {
      method: "POST",
      token: sender.token,
      body: { amount: 2_000 },
    });
    equal(withdrawal.status, 200, "valid withdrawal should return 200");
    equal(Number(withdrawal.body?.balance), 1_003_000, "withdrawal should decrease balance by 2,000 paisa");

    const invalidDeposit = await api("/api/accounts/deposit", {
      method: "POST",
      token: sender.token,
      body: { amount: 999 },
    });
    equal(invalidDeposit.status, 400, "deposit below the minimum should return 400");

    const insufficientWithdrawal = await api("/api/accounts/withdraw", {
      method: "POST",
      token: sender.token,
      body: { amount: 10_000_000 },
    });
    equal(insufficientWithdrawal.status, 400, "withdrawal beyond available balance should return 400");

    const history = await api("/api/accounts/me/history?page=1", { token: sender.token });
    equal(history.status, 200, "account history should return 200");
    check(Array.isArray(history.body?.items), "account history should return items array");
    check(history.body.items.some((row: any) => row.reason === "deposit"), "account history should include deposit ledger entries");
    check(history.body.items.some((row: any) => row.reason === "withdrawal"), "account history should include withdrawal ledger entries");

    console.log("\n[Sessions 3–5] Transfer validation, idempotency, ledger movement and API reads");
    const missingKey = await api("/api/transfers", {
      method: "POST",
      token: sender.token,
      body: { receiver_account_id: receiver.accountId, amount: 25_000 },
    });
    equal(missingKey.status, 400, "transfer without Idempotency-Key should return 400");
    equal(missingKey.body?.error?.code, "missing_idempotency_key", "missing key should have documented error code");

    const invalidTransferAmount = await api("/api/transfers", {
      method: "POST",
      token: sender.token,
      headers: { "Idempotency-Key": `${RUN_ID}-bad-amount` },
      body: { receiver_account_id: receiver.accountId, amount: 999 },
    });
    equal(invalidTransferAmount.status, 400, "transfer amount below minimum should return 400");

    const selfTransfer = await api("/api/transfers", {
      method: "POST",
      token: sender.token,
      headers: { "Idempotency-Key": `${RUN_ID}-self` },
      body: { receiver_account_id: sender.accountId, amount: 25_000 },
    });
    equal(selfTransfer.status, 400, "self-transfer should return 400");

    const receiverBeforeRows = await query<{ balance: string | number }>("SELECT balance FROM accounts WHERE id = $1", [receiver.accountId]);
    const receiverBalanceBefore = Number(receiverBeforeRows[0].balance);
    const idempotencyKey = `${RUN_ID}-standard-transfer`;
    const transferResponse = await api("/api/transfers", {
      method: "POST",
      token: sender.token,
      headers: { "Idempotency-Key": idempotencyKey, "X-Device-Id": `${RUN_ID}-primary-device` },
      body: { receiver_account_id: receiver.accountId, amount: 25_000 },
    });
    check(transferResponse.status === 201 || transferResponse.status === 200, `transfer should be accepted; got ${transferResponse.status} ${JSON.stringify(transferResponse.body)}`);
    equal(transferResponse.body?.status, "held", "a newly approved transfer should initially be held");
    const transferId = String(transferResponse.body?.transfer_id ?? "");
    check(transferId.length > 0, "accepted transfer should have transfer_id");
    touchedTransferIds.add(transferId);

    const replayResponse = await api("/api/transfers", {
      method: "POST",
      token: sender.token,
      headers: { "Idempotency-Key": idempotencyKey, "X-Device-Id": `${RUN_ID}-primary-device` },
      body: { receiver_account_id: receiver.accountId, amount: 25_000 },
    });
    equal(replayResponse.status, 200, "same-payload idempotent replay should return 200");
    equal(replayResponse.body?.transfer_id, transferId, "idempotent replay should return the original transfer id");
    equal(replayResponse.body?.replayed, true, "idempotent replay should set replayed=true");

    const conflictResponse = await api("/api/transfers", {
      method: "POST",
      token: sender.token,
      headers: { "Idempotency-Key": idempotencyKey },
      body: { receiver_account_id: receiver.accountId, amount: 26_000 },
    });
    equal(conflictResponse.status, 409, "same idempotency key with a different payload should return 409");
    equal(conflictResponse.body?.error?.code, "idempotency_conflict", "idempotency conflict should have documented error code");

    await waitForSettled(transferId);
    const transferRows = await query<{
      id: string;
      status: string;
      amount: string | number;
      sender_account_id: string;
      receiver_account_id: string;
    }>(
      "SELECT id::text AS id, status, amount, sender_account_id::text, receiver_account_id::text FROM transfers WHERE id = $1",
      [transferId],
    );
    equal(transferRows[0].status, "settled", "transfer should reach settled status");
    equal(Number(transferRows[0].amount), 25_000, "stored transfer amount should be integer paisa");

    const transferGet = await api(`/api/transfers/${encodeURIComponent(transferId)}`, { token: sender.token });
    equal(transferGet.status, 200, "sender should be able to read transfer details");
    equal(transferGet.body?.id, transferId, "transfer detail id should match");
    equal(transferGet.body?.status, "settled", "transfer detail should expose settled status");

    const transferList = await api("/api/transfers?page=1", { token: sender.token });
    equal(transferList.status, 200, "transfer list should return 200");
    check(Array.isArray(transferList.body?.items), "transfer list should return items array");
    check(transferList.body.items.some((item: any) => item.id === transferId), "transfer list should contain the test transfer");

    const senderAfterRows = await query<{ balance: string | number }>("SELECT balance FROM accounts WHERE id = $1", [sender.accountId]);
    const receiverAfterRows = await query<{ balance: string | number }>("SELECT balance FROM accounts WHERE id = $1", [receiver.accountId]);
    equal(Number(senderAfterRows[0].balance), 978_000, "sender balance should decrease by exactly the transfer amount");
    equal(Number(receiverAfterRows[0].balance), receiverBalanceBefore + 25_000, "receiver balance should increase by exactly the transfer amount");

    const heldLedgerRows = await query<{ count: string | number; sum: string | number }>(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::text AS sum
         FROM ledger WHERE transfer_id = $1 AND reason = 'hold'`,
      [transferId],
    );
    equal(Number(heldLedgerRows[0].count), 2, "transfer hold must create one double-entry ledger pair");
    equal(Number(heldLedgerRows[0].sum), 0, "transfer hold ledger pair must net to zero");

    const settleLedgerRows = await query<{ count: string | number; sum: string | number }>(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::text AS sum
         FROM ledger WHERE transfer_id = $1 AND reason = 'settle'`,
      [transferId],
    );
    equal(Number(settleLedgerRows[0].count), 2, "settlement must create exactly one double-entry ledger pair");
    equal(Number(settleLedgerRows[0].sum), 0, "settlement ledger pair must net to zero");

    const transitRows = await query<{ sum: string | number }>(
      "SELECT COALESCE(SUM(amount), 0)::text AS sum FROM ledger WHERE transfer_id = $1 AND account_id = $2",
      [transferId, "00000000-0000-0000-0000-000000000002"],
    );
    equal(Number(transitRows[0].sum), 0, "this settled transfer should leave no in-transit ledger balance");

    await waitFor(
      "transfer.settled outbox event to be published",
      () => query<{ status: string; sent_at: Date | string | null }>(
        `SELECT status, sent_at FROM outbox
          WHERE event_type = 'transfer.settled'
            AND payload->>'transfer_id' = $1`,
        [transferId],
      ),
      (rows) => rows.length === 1 && rows[0].status === "sent" && rows[0].sent_at !== null,
      8_000,
    );

    const heldOutboxRows = await query<{ id: string | number }>(
      `SELECT id FROM outbox WHERE event_type = 'transfer.held' AND payload->>'transfer_id' = $1`,
      [transferId],
    );
    equal(heldOutboxRows.length, 1, "one held outbox event should exist");
    const processedRows = await query<{ count: string | number }>(
      "SELECT COUNT(*)::int AS count FROM processed_events WHERE consumer = 'settlement' AND event_id::text = $1",
      [String(heldOutboxRows[0].id)],
    );
    equal(Number(processedRows[0].count), 1, "settlement consumer should record the held event as processed");

    console.log("\n[Session 6] Duplicate delivery must not settle twice");
    const beforeDuplicate = await query<{ balance: string | number; count: string | number }>(
      `SELECT a.balance::text AS balance,
              (SELECT COUNT(*)::int FROM ledger l WHERE l.transfer_id = $2 AND l.reason = 'settle') AS count
         FROM accounts a WHERE a.id = $1`,
      [receiver.accountId, transferId],
    );
    await publishDuplicateHeldEvent(transferId);
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    equal(await transferStatus(transferId), "settled", "duplicate held event must leave transfer settled");
    const afterDuplicate = await query<{ balance: string | number; count: string | number }>(
      `SELECT a.balance::text AS balance,
              (SELECT COUNT(*)::int FROM ledger l WHERE l.transfer_id = $2 AND l.reason = 'settle') AS count
         FROM accounts a WHERE a.id = $1`,
      [receiver.accountId, transferId],
    );
    equal(Number(afterDuplicate[0].balance), Number(beforeDuplicate[0].balance), "duplicate held event must not change receiver balance");
    equal(Number(afterDuplicate[0].count), Number(beforeDuplicate[0].count), "duplicate held event must not add settlement ledger entries");
    equal(Number(afterDuplicate[0].count), 2, "duplicate delivery must leave exactly one settlement ledger pair");

    await testVelocityDecline(receiver);
    const velocityAccountRows = await query<{ id: string }>("SELECT id::text AS id FROM accounts WHERE user_id = (SELECT id FROM users WHERE email = $1)", [API_EMAILS.velocity]);
    if (velocityAccountRows.length) await assertUserBalanceMatchesLedger(velocityAccountRows[0].id);
    await assertUserBalanceMatchesLedger(sender.accountId);
    await assertUserBalanceMatchesLedger(receiver.accountId);
    await assertLedgerGlobalInvariant();

    if (RUN_FAILURE_INJECTION_TESTS) {
      await testFailureInjection(receiver);
    } else {
      console.log("\n[Session 6] Failure injection batch skipped (set RUN_FAILURE_INJECTION_TESTS=true to enable).");
    }

    console.log(`\nPASS: ${passes} assertions completed.`);
  } catch (error) {
    failures++;
    console.error("\nTEST FAILURE:", error);
    process.exitCode = 1;
  } finally {
    if (cleanupRequired) {
      try {
        await cleanupAndVerify();
      } catch (cleanupError) {
        failures++;
        process.exitCode = 1;
        console.error("CLEANUP FAILURE:", cleanupError);
      }
      try {
        await assertLedgerGlobalInvariant();
        console.log("Post-cleanup global ledger invariant verified.");
      } catch (invariantError) {
        failures++;
        process.exitCode = 1;
        console.error("POST-CLEANUP LEDGER INVARIANT FAILURE:", invariantError);
      }
    } else {
      console.log("\n[Cleanup] Skipped because this run created no test data.");
    }
    await pool.end();
    if (failures === 0) console.log("\nALL ENABLED TESTS PASSED AND CLEANUP VERIFIED.");
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
