import { getConfirmChannel } from "../queue/connection.js";
import { pool } from "../db.js";

let isRunning = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const CONFIRMATION_TIMEOUT_MS = 10_000;

export async function startOutboxPublisher(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  await publishBatch();
}

async function publishBatch(): Promise<void> {
  if (!isRunning) return;

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const res = await client.query(
        `SELECT id, event_type, payload FROM outbox 
         WHERE status = 'pending' 
         ORDER BY id ASC 
         LIMIT 50 FOR UPDATE SKIP LOCKED`,
      );

      if (res.rows.length === 0) {
        await client.query("COMMIT");
        timer = setTimeout(publishBatch, 500);
        return;
      }

      const channel = await getConfirmChannel();
      const updateIds: number[] = [];

      for (const row of res.rows) {
        const envelope = {
          event_id: row.id.toString(),
          type: row.event_type,
          occurred_at: new Date().toISOString(),
          payload: row.payload,
        };

        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(
              new Error(
                `RabbitMQ publisher confirmation timed out after ${CONFIRMATION_TIMEOUT_MS}ms`,
              ),
            );
            void channel.close().catch((closeError: unknown) => {
              console.error(
                "Failed to close timed-out RabbitMQ confirm channel:",
                closeError,
              );
            });
          }, CONFIRMATION_TIMEOUT_MS);

          channel.publish(
            "paycore.events",
            row.event_type,
            Buffer.from(JSON.stringify(envelope)),
            { persistent: true },
            (err, ok) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              if (err) reject(err);
              else resolve();
            },
          );
        });

        updateIds.push(row.id);
      }

      if (updateIds.length > 0) {
        await client.query(
          `UPDATE outbox 
           SET status = 'sent', sent_at = now() 
           WHERE id = ANY($1)`,
          [updateIds],
        );
      }

      await client.query("COMMIT");

      if (res.rows.length === 50) {
        setImmediate(publishBatch);
      } else {
        timer = setTimeout(publishBatch, 500);
      }
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Outbox publisher transaction error:", err);
      timer = setTimeout(publishBatch, 1000);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Outbox publisher connection error:", err);
    timer = setTimeout(publishBatch, 1000);
  }
}

export function stopOutboxPublisher(): void {
  isRunning = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
