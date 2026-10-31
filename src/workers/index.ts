import { connectQueue } from "../queue/connection.js";
import { startOutboxPublisher } from "./outboxPublisher.js";
import { startSettlementConsumer } from "./settlementConsumer.js";
import { startHoldExpiry } from "./holdExpiry.js";
import { startReconJob } from "./reconJob.js";
import { startGraphConsumer } from "./graphConsumer.js";
import { channel } from "process";

export async function startAllWorkers(): Promise<void> {
  if (process.env.RUN_WORKERS !== "true") {
    return;
  }

  // Ensure RabbitMQ connection and topology are ready before starting consumers
  await connectQueue();

  await startOutboxPublisher();
  await startSettlementConsumer();
  await startGraphConsumer();
  await startHoldExpiry();
  await startReconJob();
}
