import * as dotenv from "dotenv";
const { pool } = await import("../src/db.js");
dotenv.config();

const BASE = "http://localhost:3000/api";
const SENDERS = 10;
const TRANSFERS_PER_SENDER = 5;
const AMOUNT = 10000; // 100 BDT in paisa
const FUND_AMOUNT = 100000; // 1000 BDT buffer per sender
const POLL_INTERVAL_MS = 400;

// Timeout must be longer than HOLD_EXPIRY_SECONDS + grace period
const HOLD_EXPIRY_SECONDS = parseInt(
  process.env.HOLD_EXPIRY_SECONDS || "300",
  10,
);
const POLL_TIMEOUT_MS = (HOLD_EXPIRY_SECONDS + 60) * 1000;

interface Sender {
  email: string;
  token: string;
  accountId: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function registerAndLogin(
  email: string,
  password: string,
): Promise<Sender> {
  // Try register; only ignore 409 Conflict (email already exists)
  const regRes = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!regRes.ok && regRes.status !== 409) {
    const data = await regRes.json();
    throw new Error(`Register failed for ${email}: ${JSON.stringify(data)}`);
  }

  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok)
    throw new Error(`Login failed for ${email}: ${JSON.stringify(data)}`);
  return { email, token: data.token, accountId: data.account_id };
}

async function fundAccount(token: string, amount: number): Promise<void> {
  const res = await fetch(`${BASE}/accounts/deposit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ amount }),
  });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(`Deposit failed: ${JSON.stringify(body)}`);
  }
}

interface PostResult {
  transferId: string | null;
  outcome: "held" | "declined" | "http_error";
  postResponseTime: number;
  reason?: string;
  senderIdx: number;
}

async function postTransfer(
  sender: Sender,
  receiverId: string,
  idx: number,
  senderIdx: number,
): Promise<PostResult> {
  const res = await fetch(`${BASE}/transfers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sender.token}`,
      "Idempotency-Key": `rel-${sender.accountId}-${idx}-${Date.now()}`,
    },
    body: JSON.stringify({ receiver_account_id: receiverId, amount: AMOUNT }),
  });
  const postResponseTime = Date.now();
  const data = await res.json();

  // Fix 4: Validate transfer_id exists
  if (res.status === 201 && data.status === "held" && data.transfer_id) {
    return {
      transferId: data.transfer_id,
      outcome: "held",
      postResponseTime,
      senderIdx,
    };
  }
  if (res.status === 200 && data.status === "declined") {
    return {
      transferId: data.transfer_id ?? null,
      outcome: "declined",
      postResponseTime,
      reason: data.reason,
      senderIdx,
    };
  }
  return {
    transferId: null,
    outcome: "http_error",
    postResponseTime,
    reason: `status=${res.status}`,
    senderIdx,
  };
}

async function pollUntilTerminal(
  token: string,
  transferId: string,
  postResponseTime: number,
): Promise<{ status: string; latencyMs: number; timedOut: boolean }> {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const res = await fetch(`${BASE}/transfers/${transferId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (["settled", "expired", "declined"].includes(data.status)) {
      return {
        status: data.status,
        latencyMs: Date.now() - postResponseTime,
        timedOut: false,
      };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return {
    status: "unknown",
    latencyMs: Date.now() - postResponseTime,
    timedOut: true,
  };
}

interface LedgerRow {
  reason: string;
  amount: number;
}

async function verifyLedgerIntegrity(transferIds: string[]): Promise<{
  valid: number;
  invalid: number;
  invalidDetails: string[];
}> {
  let valid = 0;
  let invalid = 0;
  const invalidDetails: string[] = [];

  for (const id of transferIds) {
    const res = await pool.query<LedgerRow>(
      `SELECT reason, amount FROM ledger WHERE transfer_id = $1`,
      [id],
    );
    const rows = res.rows;

    const holds = rows.filter((r) => r.reason === "hold");
    const settles = rows.filter((r) => r.reason === "settle");
    const refunds = rows.filter((r) => r.reason === "refund");

    const holdSum = holds.reduce((s, r) => s + Number(r.amount), 0);
    const settleSum = settles.reduce((s, r) => s + Number(r.amount), 0);
    const refundSum = refunds.reduce((s, r) => s + Number(r.amount), 0);

    const holdOk = holds.length === 2 && holdSum === 0;
    const settleOk = settles.length === 2 && settleSum === 0;
    const refundOk = refunds.length === 2 && refundSum === 0;
    const bothSettleAndRefund = settles.length > 0 && refunds.length > 0;

    if (holdOk && !bothSettleAndRefund && (settleOk || refundOk)) {
      valid++;
    } else {
      invalid++;
      invalidDetails.push(
        `${id}: holds=${holds.length}(sum=${holdSum}) settles=${settles.length}(sum=${settleSum}) refunds=${refunds.length}(sum=${refundSum})`,
      );
    }
  }

  return { valid, invalid, invalidDetails };
}

async function main(): Promise<void> {
  // Fix 1: Import pool once and wrap in try/finally
  const { pool } = await import("../src/db.js");

  try {
    console.log("=== Settlement Reliability Test ===");
    console.log(
      `Senders: ${SENDERS}, Transfers/sender: ${TRANSFERS_PER_SENDER}, Total: ${SENDERS * TRANSFERS_PER_SENDER}`,
    );
    console.log(
      `SETTLE_FAILURE_RATE=${process.env.SETTLE_FAILURE_RATE ?? "unset"}`,
    );
    console.log(`HOLD_EXPIRY_SECONDS=${HOLD_EXPIRY_SECONDS}`);
    console.log(`POLL_TIMEOUT_MS=${POLL_TIMEOUT_MS}`);
    console.log("");

    // 1. Set up receiver
    const bob = await registerAndLogin("bob@paycore.dev", "User#12345");
    console.log(`Receiver: ${bob.accountId}`);

    // 2. Set up senders
    const senders: Sender[] = [];
    for (let i = 1; i <= SENDERS; i++) {
      const s = await registerAndLogin(`sender${i}@paycore.dev`, "User#12345");
      await fundAccount(s.token, FUND_AMOUNT);
      senders.push(s);
    }
    console.log(
      `Funded ${senders.length} senders with ${FUND_AMOUNT / 100} BDT each`,
    );
    console.log("");

    // 3. Fire all transfers concurrently
    console.log(
      `Firing ${SENDERS * TRANSFERS_PER_SENDER} transfers concurrently...`,
    );
    const fireStart = Date.now();

    const postResults = await Promise.all(
      senders.flatMap((sender, sIdx) =>
        Array.from({ length: TRANSFERS_PER_SENDER }, (_, tIdx) =>
          postTransfer(sender, bob.accountId, tIdx, sIdx),
        ),
      ),
    );

    console.log(`All POSTs completed in ${Date.now() - fireStart} ms`);

    const held = postResults.filter((r) => r.outcome === "held");
    const declined = postResults.filter((r) => r.outcome === "declined");
    const httpErrors = postResults.filter((r) => r.outcome === "http_error");

    console.log(
      `POST outcomes: held=${held.length}, declined=${declined.length}, http_errors=${httpErrors.length}`,
    );
    if (declined.length > 0) {
      const reasons = declined
        .map((d) => d.reason)
        .reduce(
          (acc, r) => {
            acc[r ?? "unknown"] = (acc[r ?? "unknown"] ?? 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        );
      console.log(`  Decline reasons:`, reasons);
    }
    console.log("");

    // 4. Poll held transfers concurrently
    console.log(
      `Polling ${held.length} held transfers until terminal (timeout: ${POLL_TIMEOUT_MS}ms)...`,
    );
    const pollStart = Date.now();

    const pollResults = await Promise.all(
      held.map(async (h) => {
        const result = await pollUntilTerminal(
          senders[h.senderIdx].token,
          h.transferId!,
          h.postResponseTime,
        );
        return { transferId: h.transferId!, ...result };
      }),
    );

    console.log(`Polling completed in ${Date.now() - pollStart} ms`);
    console.log("");

    // 5. Aggregate outcomes
    const settled = pollResults.filter((r) => r.status === "settled");
    const expired = pollResults.filter((r) => r.status === "expired");
    const timedOut = pollResults.filter((r) => r.timedOut);

    // Fix 3: Measure latency ONLY for successfully settled transfers
    const settlementLatencies = settled
      .map((r) => r.latencyMs)
      .sort((a, b) => a - b);

    const totalHeld = held.length;
    const successRate =
      totalHeld === 0 ? 0 : (settled.length / totalHeld) * 100;

    console.log("=== OUTCOMES ===");
    console.log(`Total POSTed:        ${postResults.length}`);
    console.log(`  Held (accepted):   ${held.length}`);
    console.log(`  Declined at POST:  ${declined.length}`);
    console.log(`  HTTP errors:       ${httpErrors.length}`);
    console.log(`Of ${held.length} held transfers:`);
    console.log(`  Settled:           ${settled.length}`);
    console.log(`  Expired:           ${expired.length}`);
    console.log(`  Timed out:         ${timedOut.length}`);
    console.log(`Settlement rate (of held): ${successRate.toFixed(1)}%`);
    console.log("");

    if (settlementLatencies.length > 0) {
      console.log("=== SETTLEMENT LATENCY (POST response → settled state) ===");
      console.log(`  p50: ${percentile(settlementLatencies, 50)} ms`);
      console.log(`  p95: ${percentile(settlementLatencies, 95)} ms`);
      console.log(`  p99: ${percentile(settlementLatencies, 99)} ms`);
      console.log(
        `  max: ${settlementLatencies[settlementLatencies.length - 1]} ms`,
      );
      console.log("");
    }

    // 6. Per-transfer ledger verification
    const allTransferIds = pollResults.map((r) => r.transferId);
    console.log(
      `Verifying ledger integrity for ${allTransferIds.length} transfers...`,
    );
    const ledgerCheck = await verifyLedgerIntegrity(allTransferIds);
    console.log(`  Valid:   ${ledgerCheck.valid}`);
    console.log(`  Invalid: ${ledgerCheck.invalid}`);
    if (ledgerCheck.invalidDetails.length > 0) {
      console.log("  Invalid details:");
      ledgerCheck.invalidDetails
        .slice(0, 10)
        .forEach((d) => console.log(`    ${d}`));
    }
    console.log("");

    // 7. Global reconciliation
    console.log("Running global reconciliation...");
    const { runReconciliation } = await import("../src/services/recon.js");
    const recon = await runReconciliation();
    console.log(`  passed: ${recon.passed}`);
    console.log(`  ledger_sum: ${recon.ledger_sum}`);
    console.log(`  mismatched_accounts: ${recon.mismatched_accounts.length}`);
    console.log(`  in_transit_ok: ${recon.in_transit_ok}`);
    console.log(`  stuck_holds: ${recon.stuck_holds}`);
    console.log("");

    // 8. Final verdict
    // Fix 2: Expired transfers are a failure for this specific reliability test
    const allOk =
      ledgerCheck.invalid === 0 &&
      recon.passed &&
      timedOut.length === 0 &&
      httpErrors.length === 0 &&
      expired.length === 0;

    if (allOk) {
      console.log(
        "✅ ALL CHECKS PASSED — retries recovered from failures, no duplicate or lost money",
      );
    } else {
      console.log("❌ ISSUES DETECTED");
      if (ledgerCheck.invalid > 0)
        console.log("   - Ledger integrity violations");
      if (!recon.passed) console.log("   - Reconciliation failed");
      if (timedOut.length > 0)
        console.log(`   - ${timedOut.length} transfers timed out`);
      if (httpErrors.length > 0)
        console.log(`   - ${httpErrors.length} HTTP errors`);
      if (expired.length > 0)
        console.log(
          `   - ${expired.length} transfers expired (retries failed to settle in time)`,
        );
    }
  } finally {
    // Fix 1: Ensure pool is always closed
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
