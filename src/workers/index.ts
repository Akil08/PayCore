import { connectQueue, onReconnect } from "../queue/connection.js";
import { startOutboxPublisher } from "./outboxPublisher.js";
import { startSettlementConsumer } from "./settlementConsumer.js";
import { startHoldExpiry } from "./holdExpiry.js";
import { startReconJob } from "./reconJob.js";
import { startGraphConsumer } from "./graphConsumer.js";
import { startAnalyzerConsumer } from "./analyzerConsumer.js";
import { startStatsConsumer } from "./statsConsumer.js";

export async function startAllWorkers(): Promise<void> {
  if (process.env.RUN_WORKERS !== "true") {
    return;
  }

  // Ensure RabbitMQ connection and topology are ready before starting consumers
  await connectQueue();

  // Register reconnect handler AFTER initial connection to avoid duplicate startup
  onReconnect(async () => {
    console.log("RabbitMQ reconnected. Restarting consumers...");
    await startSettlementConsumer();
    await startStatsConsumer();
    await startGraphConsumer();
    await startAnalyzerConsumer();

    // Note: startOutboxPublisher is intentionally omitted here to prevent
    // duplicate publisher loops. It will naturally resume when its internal
    // logic successfully calls getConfirmChannel() again.
  });

  await startOutboxPublisher();
  await startSettlementConsumer();
  await startStatsConsumer();
  await startGraphConsumer();
  await startAnalyzerConsumer();
  await startHoldExpiry();
  await startReconJob();
}
