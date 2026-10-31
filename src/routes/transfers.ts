import { Router, Request, Response } from "express";
import { requireAuth } from "../http/auth.js";
import { wrap } from "../http/wrap.js";
import { AppError } from "../http/errors.js";
import { createTransfer } from "../services/transfers.js";
import { TRANSFER_MIN_AMOUNT, TRANSFER_MAX_AMOUNT } from "../config.js";
import { pool } from "../db.js";

const router = Router();

router.post(
  "/",
  requireAuth,
  wrap(async (req: Request, res: Response) => {
    // is not this idempontey key is sent by client ? jsut say yes or no ?
    // Yes, the Idempotency-Key is sent by the client in the request headers.
    const idempotencyKey = req.headers["idempotency-key"] as string;
    if (!idempotencyKey) {
      throw new AppError(
        400,
        "missing_idempotency_key",
        "Idempotency-Key header is required",
      );
    }

    const deviceIdHeader = req.headers["x-device-id"] as string | undefined;
    let deviceId: string | null = null;
    if (deviceIdHeader) {
      if (typeof deviceIdHeader !== "string" || deviceIdHeader.length > 64) {
        throw new AppError(
          400,
          "invalid_device_id",
          "X-Device-Id must be a string of max 64 characters",
        );
      }
      deviceId = deviceIdHeader;
    }

    const { receiver_account_id, amount } = req.body;
    if (!receiver_account_id || typeof receiver_account_id !== "string") {
      throw new AppError(
        400,
        "invalid_receiver",
        "receiver_account_id is required and must be a string",
      );
    }
    if (
      !Number.isInteger(amount) ||
      amount < TRANSFER_MIN_AMOUNT ||
      amount > TRANSFER_MAX_AMOUNT
    ) {
      throw new AppError(
        400,
        "invalid_amount",
        `amount must be an integer between ${TRANSFER_MIN_AMOUNT} and ${TRANSFER_MAX_AMOUNT}`,
      );
    }

    // FIX: Explicitly check for null to satisfy TypeScript and business logic
    const senderAccountId = req.user!.accountId;
    if (!senderAccountId) {
      throw new AppError(
        403,
        "forbidden",
        "Analysts cannot initiate transfers",
      );
    }

    if (senderAccountId === receiver_account_id) {
      throw new AppError(
        400,
        "self_transfer",
        "Cannot transfer to your own account",
      );
    }

    const result = await createTransfer(
      senderAccountId,
      receiver_account_id,
      amount,
      idempotencyKey,
      deviceId,
    );

    if (result.replayed) {
      res.status(200).json({
        transfer_id: result.transferId,
        status: result.status,
        reason: result.failedCheck,
        replayed: true,
      });
      return;
    }

    if (result.status === "held") {
      res.status(201).json({
        transfer_id: result.transferId,
        status: "held",
      });
      return;
    }

    if (result.status === "declined") {
      res.status(200).json({
        transfer_id: result.transferId,
        status: "declined",
        reason: result.failedCheck,
      });
      return;
    }
  }),
);

router.get(
  "/:id",
  requireAuth,
  wrap(async (req: Request, res: Response) => {
    const { id } = req.params;
    const user = req.user!;

    const query =
      user.role === "analyst"
        ? `SELECT id, sender_account_id, receiver_account_id, amount, status, failed_check, created_at, updated_at FROM transfers WHERE id = $1`
        : `SELECT id, sender_account_id, receiver_account_id, amount, status, failed_check, created_at, updated_at FROM transfers WHERE id = $1 AND (sender_account_id = $2 OR receiver_account_id = $2)`;

    const params = user.role === "analyst" ? [id] : [id, user.accountId];
    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      throw new AppError(404, "not_found", "Transfer not found");
    }

    res.json(result.rows[0]);
  }),
);

router.get(
  "/",
  requireAuth,
  wrap(async (req: Request, res: Response) => {
    const user = req.user!;
    const page = parseInt(req.query.page as string) || 1;
    const limit = 25;
    const offset = (page - 1) * limit;

    // Analysts can see all transfers, users only see their own
    const query =
      user.role === "analyst"
        ? `SELECT id, sender_account_id, receiver_account_id, amount, status, failed_check, created_at, updated_at
       FROM transfers
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`
        : `SELECT id, sender_account_id, receiver_account_id, amount, status, failed_check, created_at, updated_at
       FROM transfers
       WHERE sender_account_id = $1 OR receiver_account_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`;

    const params =
      user.role === "analyst"
        ? [limit + 1, offset]
        : [user.accountId, limit + 1, offset];
    const result = await pool.query(query, params);

    const items = result.rows.slice(0, limit);
    const hasMore = result.rows.length > limit;

    res.json({ items, page, has_more: hasMore });
  }),
);

export default router;
