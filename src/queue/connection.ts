
import {
  connect,
  type ChannelModel,
  type Channel,
  type ConfirmChannel,
} from 'amqplib';

import { assertTopology } from './topology.js';

let connection: ChannelModel | null = null;
let confirmChannel: ConfirmChannel | null = null;
let consumeChannel: Channel | null = null;

let isConnecting = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const INITIAL_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export async function getConfirmChannel(): Promise<ConfirmChannel> {
  if (!confirmChannel) {
    throw new Error('RabbitMQ confirm channel is not available');
  }

  return confirmChannel;
}

export async function getConsumeChannel(): Promise<Channel> {
  if (!consumeChannel) {
    throw new Error('RabbitMQ consumer channel is not available');
  }

  return consumeChannel;
}

export async function connectQueue(): Promise<void> {
  if (isConnecting || connection) {
    return;
  }

  const rabbitmqUrl = process.env.RABBITMQ_URL;

  if (!rabbitmqUrl) {
    throw new Error('RABBITMQ_URL is required in environment variables');
  }

  isConnecting = true;

  try {
    let lastError: unknown;

    for (let attempt = 0; attempt < 10; attempt++) {
      let newConnection: ChannelModel | null = null;
      let newConfirmChannel: ConfirmChannel | null = null;
      let newConsumeChannel: Channel | null = null;

      try {
        newConnection = await connect(rabbitmqUrl);

        newConnection.on('error', (error: Error) => {
          console.error('RabbitMQ connection error:', error);
        });

        newConnection.on('close', () => {
          if (connection !== newConnection) {
            return;
          }

          connection = null;
          confirmChannel = null;
          consumeChannel = null;

          console.warn('RabbitMQ connection closed');

          scheduleReconnect();
        });

        newConfirmChannel =
          await newConnection.createConfirmChannel();

        newConsumeChannel =
          await newConnection.createChannel();

        await assertTopology(
          newConfirmChannel,
          newConsumeChannel,
        );

        connection = newConnection;
        confirmChannel = newConfirmChannel;
        consumeChannel = newConsumeChannel;

        console.log('RabbitMQ connected and topology asserted');

        return;
      } catch (error) {
        lastError = error;

        console.error(
          `RabbitMQ connection attempt ${attempt + 1} failed:`,
          error,
        );

        if (newConnection) {
          try {
            await newConnection.close();
          } catch {
            // Connection may already be closed.
          }
        }

        if (attempt < 9) {
          const delay = Math.min(
            INITIAL_RECONNECT_DELAY_MS * 2 ** attempt,
            MAX_RECONNECT_DELAY_MS,
          );

          await new Promise<void>((resolve) => {
            setTimeout(resolve, delay);
          });
        }
      }
    }

    throw new Error(
      'Failed to connect to RabbitMQ after 10 attempts',
      { cause: lastError },
    );
  } finally {
    isConnecting = false;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer || isConnecting) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    void connectQueue().catch((error: unknown) => {
      console.error('RabbitMQ reconnection failed:', error);
    });
  }, INITIAL_RECONNECT_DELAY_MS);
}
