import amqp from "amqplib";
import dotenv from "dotenv";

dotenv.config();

async function testRabbitMQ(): Promise<void> {
  const rabbitmqUrl = process.env.RABBITMQ_URL;
  if (!rabbitmqUrl) {
    console.error("❌ RABBITMQ_URL is missing in your .env file.");
    process.exit(1);
  }

  try {
    console.log("🔄 Attempting to connect to RabbitMQ...");
    const connection = await amqp.connect(rabbitmqUrl);
    const channel = await connection.createChannel();

    console.log(
      "✅ Successfully connected to RabbitMQ (CloudAMQP) and created a channel!",
    );

    await channel.close();
    await connection.close();
    console.log("🔒 Connection closed cleanly.");
  } catch (err) {
    console.error("❌ Failed to connect to RabbitMQ:", err);
    process.exit(1);
  }
}

void testRabbitMQ();
