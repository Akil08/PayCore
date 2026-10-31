// import amqp from "amqplib";
// import { withTx } from "../db.js";
// import { getConsumeChannel, getConfirmChannel } from "./connection.js";
// import { incProcessed } from "../services/metrics.js";

// export interface ConsumerOptions {
//   name: string;
//   queue: string;
//   handler: (client: any, payload: any, envelope: any) => Promise<void>;
// }

// export async function startConsumer({
//   name,
//   queue,
//   handler,
// }: ConsumerOptions): Promise<void> {
//   const channel = await getConsumeChannel();
//   await channel.prefetch(10);

//   channel.consume(queue, async (msg) => {
//     if (!msg) return;

//     const envelope = JSON.parse(msg.content.toString());
//     const attempts = msg.properties.headers?.["x-attempts"] ?? 0;
//     const retryQueue = `${queue}.retry`;

//     let alreadyProcessed = false;

//     try {
//       await withTx(async (client) => {
//         try {
//           await client.query(
//             "INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2)",
//             [name, envelope.event_id],
//           );
//         } catch (err: any) {
//           if (err.code === "23505") {
//             alreadyProcessed = true;
//             return;
//           }
//           throw err;
//         }

//         await handler(client, envelope.payload, envelope);
//       });

//       if (!alreadyProcessed) {
//         incProcessed(queue);
//       }
//       channel.ack(msg);
//     } catch (err: any) {
//       const error = err instanceof Error ? err.message : String(err);

//       if (attempts + 1 < 5) {
//         const confirmChannel = await getConfirmChannel();
//         const nextAttempts = attempts + 1;
//         const expiration = 2000 * Math.pow(2, attempts);

//         await confirmChannel.sendToQueue(retryQueue, msg.content, {
//           ...msg.properties,
//           headers: { ...msg.properties.headers, "x-attempts": nextAttempts },
//           expiration: expiration.toString(),
//         });
//         channel.ack(msg);
//       } else {
//         await withTx(async (client) => {
//           await client.query(
//             "INSERT INTO dead_letters (queue, payload, error, attempts) VALUES ($1, $2, $3, $4)",
//             [queue, envelope, error, attempts + 1],
//           );
//         });
//         channel.ack(msg);
//       }
//     }
//   });
// }

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

    let envelope: any;
    const attempts = msg.properties.headers?.["x-attempts"] ?? 0;
    const retryQueue = `${queue}.retry`;

    // Move JSON.parse inside error handling
    try {
      envelope = JSON.parse(msg.content.toString());
    } catch (parseErr) {
      console.error(
        `[${name}] Malformed message in queue ${queue}, sending to dead letters:`,
        parseErr,
      );
      // Can't parse, can't retry meaningfully - dead-letter it
      try {
        await withTx(async (client) => {
          await client.query(
            "INSERT INTO dead_letters (queue, payload, error, attempts) VALUES ($1, $2, $3, $4)",
            [
              queue,
              { raw: msg.content.toString() },
              `JSON parse error: ${parseErr}`,
              attempts,
            ],
          );
        });
        channel.ack(msg);
      } catch (dlqErr) {
        console.error(
          `[${name}] Failed to save malformed message to dead_letters:`,
          dlqErr,
        );
        // Nack without requeue to prevent infinite loop
        channel.nack(msg, false, false);
      }
      return;
    }

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
        // Retry path - wrap in its own error handling
        try {
          const confirmChannel = await getConfirmChannel();
          const nextAttempts = attempts + 1;
          const expiration = 2000 * Math.pow(2, attempts);

          await confirmChannel.sendToQueue(retryQueue, msg.content, {
            ...msg.properties,
            headers: { ...msg.properties.headers, "x-attempts": nextAttempts },
            expiration: expiration.toString(),
          });

          // Only ack after successful publish
          channel.ack(msg);
        } catch (retryErr) {
          console.error(
            `[${name}] Failed to publish to retry queue ${retryQueue}, attempting dead-letter:`,
            retryErr,
          );
          // Retry publish failed, try to dead-letter instead
          try {
            await withTx(async (client) => {
              await client.query(
                "INSERT INTO dead_letters (queue, payload, error, attempts) VALUES ($1, $2, $3, $4)",
                [
                  queue,
                  envelope,
                  `${error}; retry publish failed: ${retryErr}`,
                  attempts + 1,
                ],
              );
            });
            channel.ack(msg);
          } catch (dlqErr) {
            console.error(
              `[${name}] Failed to save to dead_letters after retry failure:`,
              dlqErr,
            );
            // Nack without requeue to prevent infinite loop
            channel.nack(msg, false, false);
          }
        }
      } else {
        // Max retries exceeded - dead-letter it
        try {
          await withTx(async (client) => {
            await client.query(
              "INSERT INTO dead_letters (queue, payload, error, attempts) VALUES ($1, $2, $3, $4)",
              [queue, envelope, error, attempts + 1],
            );
          });
          channel.ack(msg);
        } catch (dlqErr) {
          console.error(
            `[${name}] Failed to save to dead_letters after max retries:`,
            dlqErr,
          );
          // Nack without requeue to prevent infinite loop
          channel.nack(msg, false, false);
        }
      }
    }
  });
}