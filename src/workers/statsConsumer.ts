import { startConsumer } from "../queue/consumerRunner.js";
import { updateStats } from "../services/stats.js";
import { enqueueEvent } from "../services/outbox.js";

export async function startStatsConsumer(): Promise<void> {
  await startConsumer({
    name: "stats",
    queue: "stats.q",
    handler: async (client, payload) => {
      const { sender_account_id, amount, transfer_id } = payload;

      await updateStats(client, sender_account_id, amount);
      await enqueueEvent(client, "stats.done", {
        account_id: sender_account_id,
        transfer_id,
      });
    },
  });
}
