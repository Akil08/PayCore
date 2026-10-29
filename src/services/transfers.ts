import crypto from "crypto";
import { PoolClient } from "pg";
import { withTx } from "../db.js";
import { runChecks } from "./fraudChecks.js";
import { moveMoney } from "./ledger.js";
import { enqueueEvent } from "./outbox.js";
import { InsufficientFundsError, AppError } from "../http/errors.js";
import { IN_TRANSIT_ID } from "../config.js";
import { recordLatency } from "./metrics.js";

class ConcurrentDebitError extends Error {}

// FIX: Widened 'status' to 'string' to safely accommodate replays of 'settled' or 'expired' transfers
export async function createTransfer(
  senderAccountId: string,
  receiverAccountId: string,
  amount: number,
  idempotencyKey: string,
  deviceId: string | null,
): Promise<{
  status: string;
  transferId: string;
  replayed?: boolean;
  failedCheck?: string;
}> {
  const startTime = Date.now();
  const payloadHash = crypto
    .createHash("sha256")
    .update(`${receiverAccountId}:${amount}`)
    .digest("hex");

  try {
    const result = await withTx(async (client) => {
      // 1. Idempotency lookup
      const idempotencyRes = await client.query(
        `SELECT id, status, failed_check, payload_hash FROM transfers WHERE sender_account_id = $1 AND idempotency_key = $2`,
        [senderAccountId, idempotencyKey],
      );

      if (idempotencyRes.rows.length > 0) {
        const existing = idempotencyRes.rows[0];
        if (existing.payload_hash === payloadHash) {
          return {
            status: String(existing.status),
            transferId: String(existing.id),
            replayed: true,
            failedCheck: existing.failed_check || undefined,
          };
        } else {
          throw new AppError(
            409,
            "idempotency_conflict",
            "Idempotency key used with different payload",
          );
        }
      }

      // 2. Checks
      const checks = await runChecks(client, {
        senderAccountId,
        receiverAccountId,
        amount,
      });
      if (!checks.ok) {
        const insertRes = await client.query(
          `INSERT INTO transfers (sender_account_id, receiver_account_id, amount, status, failed_check, idempotency_key, payload_hash, device_id)
           VALUES ($1, $2, $3, 'declined', $4, $5, $6, $7)
           ON CONFLICT (sender_account_id, idempotency_key) DO NOTHING RETURNING id`,
          [
            senderAccountId,
            receiverAccountId,
            amount,
            checks.failedCheck,
            idempotencyKey,
            payloadHash,
            deviceId,
          ],
        );

        if (insertRes.rows.length === 0) {
          const replayRes = await client.query(
            `SELECT id, status, failed_check FROM transfers WHERE sender_account_id = $1 AND idempotency_key = $2`,
            [senderAccountId, idempotencyKey],
          );
          const replayed = replayRes.rows[0];
          return {
            status: String(replayed.status),
            transferId: String(replayed.id),
            replayed: true,
            failedCheck: replayed.failed_check || undefined,
          };
        }

        const transferId = String(insertRes.rows[0].id);
        await enqueueEvent(client, "transfer.declined", {
          transfer_id: transferId,
          sender_account_id: senderAccountId,
          failed_check: checks.failedCheck,
        });

        return {
          status: "declined",
          transferId,
          failedCheck: checks.failedCheck,
        };
      }

      // 3. Approve path
      const insertRes = await client.query(
        `INSERT INTO transfers (sender_account_id, receiver_account_id, amount, status, idempotency_key, payload_hash, device_id)
         VALUES ($1, $2, $3, 'held', $4, $5, $6)
         ON CONFLICT (sender_account_id, idempotency_key) DO NOTHING RETURNING id`,
        [
          senderAccountId,
          receiverAccountId,
          amount,
          idempotencyKey,
          payloadHash,
          deviceId,
        ],
      );

      if (insertRes.rows.length === 0) {
        const replayRes = await client.query(
          `SELECT id, status, failed_check FROM transfers WHERE sender_account_id = $1 AND idempotency_key = $2`,
          [senderAccountId, idempotencyKey],
        );
        const replayed = replayRes.rows[0];
        return {
          status: String(replayed.status),
          transferId: String(replayed.id),
          replayed: true,
          failedCheck: replayed.failed_check || undefined,
        };
      }

      const transferId = String(insertRes.rows[0].id);

      try {
        await moveMoney(client, {
          fromAccountId: senderAccountId,
          toAccountId: IN_TRANSIT_ID,
          amount,
          transferId,
          reason: "hold",
        });
      } catch (err) {
        if (err instanceof InsufficientFundsError) {
          throw new ConcurrentDebitError();
        }
        throw err;
      }

      await enqueueEvent(client, "transfer.held", {
        transfer_id: transferId,
        sender_account_id: senderAccountId,
        receiver_account_id: receiverAccountId,
        amount,
        device_id: deviceId,
      });

      return { status: "held", transferId };
    });

    return result;
  } catch (err) {
    if (err instanceof ConcurrentDebitError) {
      return await withTx(async (client) => {
        const insertRes = await client.query(
          `INSERT INTO transfers (sender_account_id, receiver_account_id, amount, status, failed_check, idempotency_key, payload_hash, device_id)
           VALUES ($1, $2, $3, 'declined', 'insufficient_balance', $4, $5, $6)
           ON CONFLICT (sender_account_id, idempotency_key) DO NOTHING RETURNING id`,
          [
            senderAccountId,
            receiverAccountId,
            amount,
            idempotencyKey,
            payloadHash,
            deviceId,
          ],
        );

        if (insertRes.rows.length === 0) {
          const replayRes = await client.query(
            `SELECT id, status, failed_check FROM transfers WHERE sender_account_id = $1 AND idempotency_key = $2`,
            [senderAccountId, idempotencyKey],
          );
          const replayed = replayRes.rows[0];
          return {
            status: String(replayed.status),
            transferId: String(replayed.id),
            replayed: true,
            failedCheck: replayed.failed_check || undefined,
          };
        }

        const transferId = String(insertRes.rows[0].id);
        await enqueueEvent(client, "transfer.declined", {
          transfer_id: transferId,
          sender_account_id: senderAccountId,
          failed_check: "insufficient_balance",
        });

        return {
          status: "declined",
          transferId,
          failedCheck: "insufficient_balance",
        };
      });
    }
    throw err;
  } finally {
    recordLatency("transfer_post", Date.now() - startTime);
  }
}
