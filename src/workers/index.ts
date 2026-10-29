import { connectQueue } from "../queue/connection.js";
import { startOutboxPublisher } from "./outboxPublisher.js";
import { startSettlementConsumer } from "./settlementConsumer.js";

export async function startAllWorkers(): Promise<void> {
  await connectQueue();
  await startOutboxPublisher();
  await startSettlementConsumer();

  // Future sessions will add their consumer starts here
}
