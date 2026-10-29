import amqp from "amqplib";

const EXCHANGE = "paycore.events";
const WORK_QUEUES = ["settlement.q", "stats.q", "graph.q", "analyzer.q"];

export async function assertTopology(
  confirmChannel: amqp.ConfirmChannel,
  consumeChannel: amqp.Channel,
): Promise<void> {
  await confirmChannel.assertExchange(EXCHANGE, "topic", { durable: true });

  for (const queue of WORK_QUEUES) {
    await consumeChannel.assertQueue(queue, { durable: true });

    const retryQueue = `${queue}.retry`;
    await consumeChannel.assertQueue(retryQueue, {
      durable: true,
      arguments: {
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": queue,
      },
    });

    if (queue === "settlement.q") {
      await consumeChannel.bindQueue(queue, EXCHANGE, "transfer.held");
    } else if (queue === "stats.q") {
      await consumeChannel.bindQueue(queue, EXCHANGE, "transfer.settled");
    } else if (queue === "graph.q") {
      await consumeChannel.bindQueue(queue, EXCHANGE, "transfer.settled");
    } else if (queue === "analyzer.q") {
      await consumeChannel.bindQueue(queue, EXCHANGE, "stats.done");
      await consumeChannel.bindQueue(queue, EXCHANGE, "graph.done");
      await consumeChannel.bindQueue(queue, EXCHANGE, "transfer.declined");
    }
  }
}
