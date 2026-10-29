import { startConsumer } from "../queue/consumerRunner.js";
import { moveMoney } from "../services/ledger.js";
import { enqueueEvent } from "../services/outbox.js";
import { IN_TRANSIT_ID } from "../config.js";

export async function startSettlementConsumer(): Promise<void> {
  await startConsumer({
    name: "settlement",
    queue: "settlement.q",
    handler: async (client, payload) => {
      const { transfer_id } = payload;

      const failureRate = parseFloat(process.env.SETTLE_FAILURE_RATE || "0");
      if (failureRate > 0 && Math.random() < failureRate) {
        throw new Error("Injected settlement failure");
      }

      const res = await client.query(
        `SELECT id, sender_account_id, receiver_account_id, amount, status, device_id 
         FROM transfers 
         WHERE id = $1 FOR UPDATE`,
        [transfer_id],
      );

      if (res.rows.length === 0) {
        return;
      }

      const transfer = res.rows[0];

      if (transfer.status !== "held") {
        return;
      }

      await moveMoney(client, {
        fromAccountId: IN_TRANSIT_ID,
        toAccountId: transfer.receiver_account_id,
        amount: transfer.amount,
        transferId: transfer.id,
        reason: "settle",
      });

      await client.query(
        `UPDATE transfers SET status = 'settled', updated_at = now() WHERE id = $1`,
        [transfer.id],
      );

      await enqueueEvent(client, "transfer.settled", {
        transfer_id: transfer.id,
        sender_account_id: transfer.sender_account_id,
        receiver_account_id: transfer.receiver_account_id,
        amount: transfer.amount,
        device_id: transfer.device_id,
      });
    },
  });
}
