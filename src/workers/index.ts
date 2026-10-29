import { connectQueue } from "../queue/connection.js";
import { startOutboxPublisher } from "./outboxPublisher.js";
import { startSettlementConsumer } from "./settlementConsumer.js";
import { startHoldExpiry } from "./holdExpiry.js";
import { startReconJob } from "./reconJob.js";

export async function startAllWorkers(): Promise<void> {
  if (process.env.RUN_WORKERS !== "true") {
    console.log("Background workers disabled (RUN_WORKERS=false)");
    return;
  }

  console.log("Starting background workers...");

  // Ensure RabbitMQ connection and topology are ready before starting consumers
  await connectQueue();

  await startOutboxPublisher();
  await startSettlementConsumer();
  startHoldExpiry();
  startReconJob();
}
