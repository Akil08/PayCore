import { startConsumer } from "../queue/consumerRunner.js";
import { recordDeviceAndRecluster } from "../services/graph.js";
import { enqueueEvent } from "../services/outbox.js";

export async function startGraphConsumer(): Promise<void> {
  await startConsumer({
    name: "graph",
    queue: "graph.q",
    handler: async (client, payload) => {
      const { transfer_id, sender_account_id, device_id } = payload;

      // Skip graph work if no device ID is present
      if (device_id) {
        await recordDeviceAndRecluster(client, sender_account_id, device_id);
      }

      // Always enqueue graph.done to advance the fraud pipeline
      await enqueueEvent(client, "graph.done", {
        account_id: sender_account_id,
        transfer_id,
      });
    },
  });
}
