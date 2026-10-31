// loadtest/test_5_concurrency.js
import http from "k6/http";
import { check } from "k6";
import { Trend, Counter } from "k6/metrics";

const transferLatency = new Trend("transfer_latency", true);
const transferRequests = new Counter("transfer_requests");
const successfulTransfers = new Counter("successful_transfers");
const replayedTransfers = new Counter("replayed_transfers");
const declinedTransfers = new Counter("declined_transfers");

export const options = {
  // Use iterations executor: each VU does EXACTLY 1 transfer
  // This guarantees no VU exceeds the velocity limit
  scenarios: {
    concurrent_transfers: {
      executor: "per-vu-iterations",
      vus: 150, // 150 concurrent users
      iterations: 1, // each VU does exactly 1 transfer
      startTime: "0s",
      maxDuration: "2m",
    },
  },
};

const BASE_URL = "http://localhost:3000/api";
const NUM_SENDERS = 20; // 150 transfers / 20 senders = ~7-8 per sender (under 10/min limit)

export function setup() {
  const password = "Password123!";
  const senders = [];

  console.log(`\n=== SETTING UP ${NUM_SENDERS} SENDER ACCOUNTS ===`);

  for (let i = 0; i < NUM_SENDERS; i++) {
    const email = `sender_${i}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}@test.com`;

    const registerRes = http.post(
      `${BASE_URL}/auth/register`,
      JSON.stringify({ email, password }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );

    if (registerRes.status !== 201) {
      throw new Error(
        `Failed to register sender ${i}: ${registerRes.status} - ${registerRes.body}`,
      );
    }

    const loginRes = http.post(
      `${BASE_URL}/auth/login`,
      JSON.stringify({ email, password }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );

    if (loginRes.status !== 200) {
      throw new Error(`Failed to login sender ${i}: ${loginRes.status}`);
    }

    const senderData = loginRes.json();

    // Fund with max allowed deposit (10,000,000 paisa = 100,000 BDT)
    const depositRes = http.post(
      `${BASE_URL}/accounts/deposit`,
      JSON.stringify({ amount: 10000000 }),
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${senderData.token}`,
        },
      },
    );

    if (depositRes.status !== 200) {
      throw new Error(
        `Failed to fund sender ${i}: ${depositRes.status} - ${depositRes.body}`,
      );
    }

    senders.push({
      token: senderData.token,
      accountId: senderData.account_id,
    });

    console.log(`✅ Sender ${i}: ${senderData.account_id}`);
  }

  // Create single receiver account
  const receiverEmail = `receiver_${Date.now()}@test.com`;
  const receiverRegRes = http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify({ email: receiverEmail, password }),
    {
      headers: { "Content-Type": "application/json" },
    },
  );

  if (receiverRegRes.status !== 201) {
    throw new Error(`Failed to register receiver: ${receiverRegRes.status}`);
  }

  const receiverLoginRes = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: receiverEmail, password }),
    {
      headers: { "Content-Type": "application/json" },
    },
  );

  if (receiverLoginRes.status !== 200) {
    throw new Error(`Failed to login receiver: ${receiverLoginRes.status}`);
  }

  const receiverAccountId = receiverLoginRes.json().account_id;

  console.log(`✅ Receiver: ${receiverAccountId}`);
  console.log(`=========================================\n`);
  console.log(`Expected: 150 transfers across 20 senders (~7-8 per sender)`);
  console.log(`Velocity limit: 10/min per sender → SAFE\n`);

  return { senders, receiverAccountId };
}

export default function (data) {
  const { senders, receiverAccountId } = data;

  // Each VU deterministically picks ONE sender (round-robin)
  // With 150 VUs and 20 senders: each sender gets exactly 7 or 8 VUs
  const senderIndex = __VU % senders.length;
  const sender = senders[senderIndex];

  // Unique idempotency key per VU (no collisions, no replays expected)
  const idempotencyKey = `k6_vu${__VU}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const payload = JSON.stringify({
    receiver_account_id: receiverAccountId,
    amount: 1000, // 10 BDT
  });

  const params = {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sender.token}`,
      "Idempotency-Key": idempotencyKey,
      "X-Device-Id": `k6-device-${__VU}`, // unique device per VU
    },
  };

  // Count this as a transfer request BEFORE sending
  transferRequests.add(1);

  const startTime = Date.now();
  const res = http.post(`${BASE_URL}/transfers`, payload, params);
  const duration = Date.now() - startTime;

  transferLatency.add(duration);

  check(res, {
    "status is 201 or 200": (r) => r.status === 201 || r.status === 200,
    "response is valid JSON": (r) => {
      try {
        r.json();
        return true;
      } catch {
        return false;
      }
    },
  });

  // Categorize response (exclude replays from "successful")
  try {
    const body = res.json();
    if (body.status === "held" && !body.replayed) {
      successfulTransfers.add(1);
    } else if (body.status === "held" && body.replayed) {
      replayedTransfers.add(1);
    } else if (body.status === "declined") {
      declinedTransfers.add(1);
    }
  } catch {
    // Invalid JSON - already caught by check above
  }

  // NO sleep - each VU does exactly 1 iteration then exits
}

export function handleSummary(data) {
  const successful = data.metrics.successful_transfers?.values?.count || 0;
  const replayed = data.metrics.replayed_transfers?.values?.count || 0;
  const declined = data.metrics.declined_transfers?.values?.count || 0;
  const totalTransfers = data.metrics.transfer_requests?.values?.count || 0;

  const avgLatency = data.metrics.transfer_latency?.values?.avg || 0;
  const p95Latency = data.metrics.transfer_latency?.values["p(95)"] || 0;
  const p99Latency = data.metrics.transfer_latency?.values["p(99)"] || 0;

  // Calculate throughput from transfer_requests only (excludes setup)
  const testDurationSec = (data.state.testRunDurationMs || 0) / 1000;
  const throughput = testDurationSec > 0 ? totalTransfers / testDurationSec : 0;

  console.log("\n╔════════════════════════════════════════════════╗");
  console.log("║         SESSION 5 LOAD TEST RESULTS            ║");
  console.log("╠════════════════════════════════════════════════╣");
  console.log(
    `║ Transfer Requests:   ${String(totalTransfers).padStart(10)}                  ║`,
  );
  console.log(
    `║ Successful (held):   ${String(successful).padStart(10)}                  ║`,
  );
  console.log(
    `║ Replayed:            ${String(replayed).padStart(10)}                  ║`,
  );
  console.log(
    `║ Declined:            ${String(declined).padStart(10)}                  ║`,
  );
  const successRate =
    totalTransfers > 0
      ? ((successful / totalTransfers) * 100).toFixed(1) + "%"
      : "N/A";
  console.log(
    `║ Success Rate:        ${successRate.padStart(15)}              ║`,
  );
  console.log(
    `║ Avg Latency:         ${(avgLatency.toFixed(2) + "ms").padStart(15)}              ║`,
  );
  console.log(
    `║ p95 Latency:         ${(p95Latency.toFixed(2) + "ms").padStart(15)}              ║`,
  );
  console.log(
    `║ p99 Latency:         ${(p99Latency.toFixed(2) + "ms").padStart(15)}              ║`,
  );
  console.log(
    `║ Throughput:          ${(throughput.toFixed(2) + " req/s").padStart(15)}              ║`,
  );
  console.log(
    `║ Test Duration:       ${(testDurationSec.toFixed(1) + "s").padStart(15)}              ║`,
  );
  console.log("╚════════════════════════════════════════════════╝\n");

  // Correctness checks for CV bullet
  if (replayed > 0) {
    console.log(
      `⚠️  ${replayed} replays detected. Each VU should have a unique key.`,
    );
  }
  if (declined > 0) {
    console.log(
      `⚠️  ${declined} transfers declined. Check velocity or balance.`,
    );
  }

  console.log("\n🔒 NEXT: Run `npx tsx scripts/verify.ts` to prove:");
  console.log("   • SUM(ledger) = 0");
  console.log("   • No negative balances");
  console.log("   • In-Transit matches held transfers");
  console.log("   • No duplicate money movements\n");

  return {};
}
