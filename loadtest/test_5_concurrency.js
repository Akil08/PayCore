import http from "k6/http";
import { check } from "k6";
import { Trend, Counter } from "k6/metrics";

const transferLatency = new Trend("transfer_latency", true);
const transferRequests = new Counter("transfer_requests");
const successfulTransfers = new Counter("successful_transfers");
const replayedTransfers = new Counter("replayed_transfers");
const declinedTransfers = new Counter("declined_transfers");
const failedTransfers = new Counter("failed_transfers");

const BASE_URL = "http://localhost:3000/api";
const NUM_SENDERS = 340;
const NUM_VUS = 1000;
const PASSWORD = "Password123!";

export const options = {
  setupTimeout: "3m",
  scenarios: {
    concurrent_transfers: {
      executor: "per-vu-iterations",
      vus: NUM_VUS,
      iterations: 1,
      maxDuration: "2m",
    },
  },
};

export function setup() {
  const senders = [];

  console.log(`\n=== SETTING UP ${NUM_SENDERS} SENDER ACCOUNTS ===`);

  for (let i = 0; i < NUM_SENDERS; i++) {
    const email = `sender_${i}_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 5)}@test.com`;

    const registerRes = http.post(
      `${BASE_URL}/auth/register`,
      JSON.stringify({ email, password: PASSWORD }),
      { headers: { "Content-Type": "application/json" } },
    );

    if (registerRes.status !== 201) {
      throw new Error(
        `Failed to register sender ${i}: ${registerRes.status}\n${registerRes.body}`,
      );
    }

    const loginRes = http.post(
      `${BASE_URL}/auth/login`,
      JSON.stringify({ email, password: PASSWORD }),
      { headers: { "Content-Type": "application/json" } },
    );

    if (loginRes.status !== 200) {
      throw new Error(`Failed to login sender ${i}: ${loginRes.status}`);
    }

    const senderData = loginRes.json();

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
        `Failed to fund sender ${i}: ${depositRes.status}\n${depositRes.body}`,
      );
    }

    senders.push({
      token: senderData.token,
      accountId: senderData.account_id,
    });

    console.log(`Sender ${i + 1}/${NUM_SENDERS} created`);
  }

  const receiverEmail = `receiver_${Date.now()}@test.com`;

  const receiverRegRes = http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify({
      email: receiverEmail,
      password: PASSWORD,
    }),
    { headers: { "Content-Type": "application/json" } },
  );

  if (receiverRegRes.status !== 201) {
    throw new Error(`Failed to register receiver: ${receiverRegRes.status}`);
  }

  const receiverLoginRes = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({
      email: receiverEmail,
      password: PASSWORD,
    }),
    { headers: { "Content-Type": "application/json" } },
  );

  if (receiverLoginRes.status !== 200) {
    throw new Error(`Failed to login receiver: ${receiverLoginRes.status}`);
  }

  const receiverAccountId = receiverLoginRes.json().account_id;

  console.log(`Receiver created: ${receiverAccountId}`);
  console.log("=========================================");
  console.log(`Expected: exactly ${NUM_VUS} transfer attempts`);
  console.log(
    `${NUM_VUS} VUs / ${NUM_SENDERS} senders ≈ ${(NUM_VUS / NUM_SENDERS).toFixed(2)} transfers per sender`,
  );
  console.log("Velocity limit: 10/min per sender");
  console.log("=========================================\n");

  return { senders, receiverAccountId };
}

export default function (data) {
  const { senders, receiverAccountId } = data;

  // Each VU gets one sender and performs one transfer.
  const senderIndex = (__VU - 1) % senders.length;
  const sender = senders[senderIndex];

  const idempotencyKey = `k6_vu${__VU}_${Date.now()}_${Math.random()
    .toString(36)
    .substr(2, 9)}`;

  const payload = JSON.stringify({
    receiver_account_id: receiverAccountId,
    amount: 1000,
  });

  const params = {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sender.token}`,
      "Idempotency-Key": idempotencyKey,
      "X-Device-Id": `k6-device-${__VU}`,
    },
  };

  transferRequests.add(1);

  const startTime = Date.now();
  const res = http.post(`${BASE_URL}/transfers`, payload, params);

  transferLatency.add(Date.now() - startTime);

  const validStatus = res.status === 200 || res.status === 201;

  check(res, {
    "status is 200 or 201": () => validStatus,
    "response is valid JSON": (r) => {
      try {
        r.json();
        return true;
      } catch {
        return false;
      }
    },
  });

  if (!validStatus) {
    failedTransfers.add(1);
    return;
  }

  try {
    const body = res.json();

    if (body.status === "held" && !body.replayed) {
      successfulTransfers.add(1);
    } else if (body.status === "held" && body.replayed) {
      replayedTransfers.add(1);
    } else if (body.status === "declined") {
      declinedTransfers.add(1);
    } else {
      failedTransfers.add(1);
    }
  } catch {
    failedTransfers.add(1);
  }
}

export function handleSummary(data) {
  const getCount = (name) => data.metrics[name]?.values?.count || 0;

  const total = getCount("transfer_requests");
  const successful = getCount("successful_transfers");
  const replayed = getCount("replayed_transfers");
  const declined = getCount("declined_transfers");
  const failed = getCount("failed_transfers");

  const latency = data.metrics.transfer_latency?.values || {};

  const avgLatency = latency.avg || 0;
  const p95Latency = latency["p(95)"] || 0;
  const p99Latency = latency["p(99)"] || 0;

  const durationSec = (data.state.testRunDurationMs || 0) / 1000;
  const throughput = durationSec > 0 ? total / durationSec : 0;

  const successRate =
    total > 0 ? ((successful / total) * 100).toFixed(1) : "0.0";

  console.log("\n╔════════════════════════════════════════════════╗");
  console.log("║         1000 VU LOAD TEST RESULTS              ║");
  console.log("╠════════════════════════════════════════════════╣");

  console.log(
    `║ Total Requests:      ${String(total).padStart(10)}                  ║`,
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
  console.log(
    `║ Failed:              ${String(failed).padStart(10)}                  ║`,
  );
  console.log(
    `║ Success Rate:        ${(successRate + "%").padStart(15)}               ║`,
  );
  console.log(
    `║ Avg Latency:         ${(avgLatency.toFixed(2) + "ms").padStart(15)}               ║`,
  );
  console.log(
    `║ p95 Latency:         ${(p95Latency.toFixed(2) + "ms").padStart(15)}               ║`,
  );
  console.log(
    `║ p99 Latency:         ${(p99Latency.toFixed(2) + "ms").padStart(15)}               ║`,
  );
  console.log(
    `║ Throughput:          ${(throughput.toFixed(2) + " req/s").padStart(15)}               ║`,
  );
  console.log(
    `║ Duration:            ${(durationSec.toFixed(1) + "s").padStart(15)}               ║`,
  );

  console.log("╚════════════════════════════════════════════════╝\n");

  if (total !== NUM_VUS) {
    console.log(`WARNING: Expected ${NUM_VUS} requests, got ${total}`);
  }

  console.log("Next: run database integrity verification:");
  console.log("npx tsx scripts/verify.ts\n");

  return {};
}
