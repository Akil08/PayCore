import amqp from "amqplib";
import { withTx } from "../db.js";
import { getConsumeChannel, getConfirmChannel } from "./connection.js";
import { incProcessed } from "../services/metrics.js";

export interface ConsumerOptions {
  name: string;
  queue: string;
  handler: (client: any, payload: any, envelope: any) => Promise<void>;
}

export async function startConsumer({
  name,
  queue,
  handler,
}: ConsumerOptions): Promise<void> {
  const channel = await getConsumeChannel();
  await channel.prefetch(10);

  channel.consume(queue, async (msg) => {
    if (!msg) return;

    const envelope = JSON.parse(msg.content.toString());
    const attempts = msg.properties.headers?.["x-attempts"] ?? 0;
    const retryQueue = `${queue}.retry`;

    let alreadyProcessed = false;

    try {
      await withTx(async (client) => {
        try {
          await client.query(
            "INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2)",
            [name, envelope.event_id],
          );
        } catch (err: any) {
          if (err.code === "23505") {
            alreadyProcessed = true;
            return;
          }
          throw err;
        }

        await handler(client, envelope.payload, envelope);
      });

      if (!alreadyProcessed) {
        incProcessed(queue);
      }
      channel.ack(msg);
    } catch (err: any) {
      const error = err instanceof Error ? err.message : String(err);

      if (attempts + 1 < 5) {
        const confirmChannel = await getConfirmChannel();
        const nextAttempts = attempts + 1;
        const expiration = 2000 * Math.pow(2, attempts);

        await confirmChannel.sendToQueue(retryQueue, msg.content, {
          ...msg.properties,
          headers: { ...msg.properties.headers, "x-attempts": nextAttempts },
          expiration: expiration.toString(),
        });
        channel.ack(msg);
      } else {
        await withTx(async (client) => {
          await client.query(
            "INSERT INTO dead_letters (queue, payload, error, attempts) VALUES ($1, $2, $3, $4)",
            [queue, envelope, error, attempts + 1],
          );
        });
        channel.ack(msg);
      }
    }
  });
}
