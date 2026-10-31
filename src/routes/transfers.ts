import { Router, Request, Response } from "express";
import { requireAuth } from "../http/auth.js";
import { wrap } from "../http/wrap.js";
import { AppError } from "../http/errors.js";
import { createTransfer } from "../services/transfers.js";
import { TRANSFER_MIN_AMOUNT, TRANSFER_MAX_AMOUNT } from "../config.js";
import { pool } from "../db.js";

const router = Router();

/**
 * @openapi
 * /transfers:
 *   post:
 *     tags:
 *       - Transfers
 *     summary: Initiate a money transfer
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema:
 *           type: string
 *         description: Unique key to ensure idempotency
 *       - in: header
 *         name: X-Device-Id
 *         required: false
 *         schema:
 *           type: string
 *           maxLength: 64
 *         description: Optional device identifier for fraud graph
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - receiver_account_id
 *               - amount
 *             properties:
 *               receiver_account_id:
 *                 type: string
 *                 format: uuid
 *               amount:
 *                 type: integer
 *                 description: Amount in paisa (min 1000, max 10000000)
 *                 example: 50000
 *     responses:
 *       201:
 *         description: Transfer approved and held
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 transfer_id:
 *                   type: string
 *                   format: uuid
 *                 status:
 *                   type: string
 *                   example: held
 *       200:
 *         description: Transfer declined or replayed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 transfer_id:
 *                   type: string
 *                   format: uuid
 *                 status:
 *                   type: string
 *                   example: declined
 *                 reason:
 *                   type: string
 *                   nullable: true
 *                 replayed:
 *                   type: boolean
 *       400:
 *         description: Validation error (missing key, invalid amount, self-transfer)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Analysts cannot initiate transfers
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Idempotency conflict (same key, different body)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

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

/**
 * @openapi
 * /transfers/{id}:
 *   get:
 *     tags:
 *       - Transfers
 *     summary: Get details of a specific transfer
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Transfer ID
 *     responses:
 *       200:
 *         description: Transfer details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   format: uuid
 *                 sender_account_id:
 *                   type: string
 *                   format: uuid
 *                 receiver_account_id:
 *                   type: string
 *                   format: uuid
 *                 amount:
 *                   type: integer
 *                 status:
 *                   type: string
 *                   enum: [held, settled, expired, declined]
 *                 failed_check:
 *                   type: string
 *                   nullable: true
 *                 created_at:
 *                   type: string
 *                   format: date-time
 *                 updated_at:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: Transfer not found or access denied
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

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

/**
 * @openapi
 * /transfers:
 *   get:
 *     tags:
 *       - Transfers
 *     summary: List transfers (sent and received)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number (1-based)
 *     responses:
 *       200:
 *         description: List of transfers retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       sender_account_id:
 *                         type: string
 *                         format: uuid
 *                       receiver_account_id:
 *                         type: string
 *                         format: uuid
 *                       amount:
 *                         type: integer
 *                       status:
 *                         type: string
 *                       failed_check:
 *                         type: string
 *                         nullable: true
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                       updated_at:
 *                         type: string
 *                         format: date-time
 *                 page:
 *                   type: integer
 *                 has_more:
 *                   type: boolean
 */

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
