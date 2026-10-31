import { startConsumer } from "../queue/consumerRunner.js";
import { analyzeAccount } from "../services/analyzer.js";

export async function startAnalyzerConsumer(): Promise<void> {
  await startConsumer({
    name: "analyzer",
    queue: "analyzer.q",
    handler: async (client, payload, envelope) => {
      const accountId =
        envelope.payload.account_id || envelope.payload.sender_account_id;
      await analyzeAccount(client, accountId, {
        type: envelope.type,
        payload: envelope.payload,
      });
    },
  });
}
