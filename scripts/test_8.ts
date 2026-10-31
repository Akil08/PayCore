import { Pool } from "pg";
import amqp from "amqplib";
import * as dotenv from "dotenv";
import { randomUUID } from "crypto";

dotenv.config();

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log("🚀 Starting Session 8 Integration Tests...\n");

  const ssl =
    process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: ssl as any,
  });

  const client = await pool.connect();
  let amqpConn: any = null;
  let amqpChannel: any = null;

  try {
    // 1. Get Alice and Bob account IDs
    const aliceRes = await client.query(
      "SELECT a.id as account_id FROM accounts a JOIN users u ON a.user_id = u.id WHERE u.email = $1",
      ["alice@paycore.dev"],
    );
    const bobRes = await client.query(
      "SELECT a.id as account_id FROM accounts a JOIN users u ON a.user_id = u.id WHERE u.email = $1",
      ["bob@paycore.dev"],
    );

    if (!aliceRes.rows[0] || !bobRes.rows[0]) {
      throw new Error(
        "Alice or Bob not found. Please run the seed script first.",
      );
    }

    const aliceAccountId = aliceRes.rows[0].account_id;
    const bobAccountId = bobRes.rows[0].account_id;
    console.log(`✅ Found Alice: ${aliceAccountId}, Bob: ${bobAccountId}`);

    // 1.5 CLEANUP: Wipe previous test data safely (respecting Foreign Key constraints)
    // Delete ledger entries tied to Alice/Bob transfers FIRST
    await client.query(
      `
      DELETE FROM ledger 
      WHERE transfer_id IN (
        SELECT id FROM transfers 
        WHERE sender_account_id = $1 OR receiver_account_id = $1
      )
    `,
      [aliceAccountId],
    );

    // NOW delete the transfers
    await client.query(
      `
      DELETE FROM transfers 
      WHERE sender_account_id = $1 OR receiver_account_id = $1
    `,
      [aliceAccountId],
    );

    // Delete stats and outbox
    await client.query("DELETE FROM user_stats WHERE account_id = $1", [
      aliceAccountId,
    ]);
    await client.query(
      "DELETE FROM outbox WHERE payload->>'account_id' = $1 OR payload->>'sender_account_id' = $1",
      [aliceAccountId],
    );

    console.log("✅ Cleaned up previous test data safely");

    // 2. Ensure Alice has enough balance for the test
    await client.query("UPDATE accounts SET balance = 100000 WHERE id = $1", [
      aliceAccountId,
    ]);
    console.log("✅ Funded Alice's account with 100,000 paisa");

    // 3. Insert 6 'held' transfers
    const transferIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const tId = randomUUID();
      transferIds.push(tId);
      await client.query(
        `INSERT INTO transfers (id, sender_account_id, receiver_account_id, amount, status, idempotency_key, payload_hash, device_id)
         VALUES ($1, $2, $3, 1000, 'held', $4, $5, 'test-device-123')`,
        [tId, aliceAccountId, bobAccountId, `idem-key-${i}`, `hash-${i}`],
      );
    }
    console.log("✅ Inserted 6 'held' transfers into the database");

    // 4. Connect to RabbitMQ and publish 6 'transfer.settled' events
    if (!process.env.RABBITMQ_URL)
      throw new Error("RABBITMQ_URL is missing in .env");
    amqpConn = await amqp.connect(process.env.RABBITMQ_URL);
    amqpChannel = await amqpConn.createConfirmChannel();
    console.log("✅ Connected to RabbitMQ");

    const eventIds: string[] = [];

    for (let i = 0; i < 6; i++) {
      const eventId = randomUUID();
      eventIds.push(eventId);

      const envelope = {
        event_id: eventId,
        type: "transfer.settled",
        occurred_at: new Date().toISOString(),
        payload: {
          transfer_id: transferIds[i],
          sender_account_id: aliceAccountId,
          receiver_account_id: bobAccountId,
          amount: 1000,
          device_id: "test-device-123",
        },
      };

      amqpChannel.publish(
        "paycore.events",
        "transfer.settled",
        Buffer.from(JSON.stringify(envelope)),
        { persistent: true },
      );
    }

    await amqpChannel.waitForConfirms();
    console.log("✅ Published 6 'transfer.settled' events to RabbitMQ");

    // 5. Wait for consumer to process and verify stats
    await sleep(2000);

    const statsRes = await client.query(
      "SELECT txn_count, total_amount, avg_amount FROM user_stats WHERE account_id = $1",
      [aliceAccountId],
    );

    if (!statsRes.rows[0]) {
      throw new Error("❌ FAIL: user_stats row not found for Alice");
    }

    const stats = statsRes.rows[0];
    if (
      Number(stats.txn_count) !== 6 ||
      Number(stats.total_amount) !== 6000 ||
      Number(stats.avg_amount) !== 1000
    ) {
      throw new Error(
        `❌ FAIL: Stats mismatch. Expected 6, 6000, 1000. Got: ${JSON.stringify(stats)}`,
      );
    }
    console.log(
      "✅ PASS: user_stats correctly shows txn_count=6, total_amount=6000, avg_amount=1000",
    );

    // 6. Test Idempotency: Re-deliver the EXACT SAME message using the original event_id
    const replayEnvelope = {
      event_id: eventIds[0],
      type: "transfer.settled",
      occurred_at: new Date().toISOString(),
      payload: {
        transfer_id: transferIds[0],
        sender_account_id: aliceAccountId,
        receiver_account_id: bobAccountId,
        amount: 1000,
        device_id: "test-device-123",
      },
    };

    amqpChannel.publish(
      "paycore.events",
      "transfer.settled",
      Buffer.from(JSON.stringify(replayEnvelope)),
      { persistent: true },
    );
    await amqpChannel.waitForConfirms();

    await sleep(2000);

    const statsResAfterReplay = await client.query(
      "SELECT txn_count, total_amount, avg_amount FROM user_stats WHERE account_id = $1",
      [aliceAccountId],
    );

    if (Number(statsResAfterReplay.rows[0].txn_count) !== 6) {
      throw new Error(
        "❌ FAIL: Idempotency failed. Stats changed after replay.",
      );
    }
    console.log(
      "✅ PASS: Re-delivering the same event_id did not change stats (Idempotency works)",
    );

    // 7. Verify outbox rows
    const outboxRes = await client.query(
      "SELECT COUNT(*) as count FROM outbox WHERE event_type = 'stats.done' AND payload->>'account_id' = $1",
      [aliceAccountId],
    );

    if (parseInt(outboxRes.rows[0].count, 10) < 6) {
      throw new Error(
        `❌ FAIL: Expected at least 6 'stats.done' outbox rows. Got: ${outboxRes.rows[0].count}`,
      );
    }
    console.log(
      `✅ PASS: Found ${outboxRes.rows[0].count} 'stats.done' outbox rows`,
    );

    // 8. Test Downstream Integration: Attempt a transfer > 5x average (e.g., 6000 paisa)
    const port = process.env.PORT || "3000";

    const loginRes = await fetch(`http://localhost:${port}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "alice@paycore.dev",
        password: "User#12345",
      }),
    });

    if (!loginRes.ok) {
      throw new Error("❌ FAIL: Could not login as Alice. Is the API running?");
    }
    const { token } = await loginRes.json();

    const transferRes = await fetch(`http://localhost:${port}/api/transfers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": randomUUID(),
        "X-Device-Id": "test-device-123",
      },
      body: JSON.stringify({
        receiver_account_id: bobAccountId,
        amount: 6000, // > 5 * 1000 (avg)
      }),
    });

    const transferData = await transferRes.json();

    if (
      transferData.status !== "declined" ||
      transferData.reason !== "amount_anomaly"
    ) {
      throw new Error(
        `❌ FAIL: Expected decline with 'amount_anomaly'. Got: ${JSON.stringify(transferData)}`,
      );
    }
    console.log(
      "✅ PASS: Transfer > 5x average was correctly declined with 'amount_anomaly'",
    );

    console.log("\n🎉 ALL SESSION 8 ACCEPTANCE CHECKS PASSED! 🎉\n");
  } catch (err) {
    console.error("\n❌ TEST FAILED:", err);
    process.exit(1);
  } finally {
    if (amqpChannel) await amqpChannel.close();
    if (amqpConn) await amqpConn.close();
    client.release();
    await pool.end();
  }
}

main();
