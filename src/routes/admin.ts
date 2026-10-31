import { Router } from "express";
import { requireAuth, requireRole } from "../http/auth.js";
import { wrap } from "../http/wrap.js";
import { AppError } from "../http/errors.js";
import {
  freezeAccount,
  unfreezeAccount,
  blacklistAccount,
  unblacklistAccount,
} from "../services/accountActions.js";
import { withTx } from "../db.js";
import { EXTERNAL_BANK_ID, IN_TRANSIT_ID } from "../config.js";

const router = Router();

function handleAccountAction(
  action: "freeze" | "unfreeze" | "blacklist" | "unblacklist",
) {
  return wrap(async (req, res) => {
    const { id } = req.params;

    if (id === EXTERNAL_BANK_ID || id === IN_TRANSIT_ID) {
      throw new AppError(
        400,
        "invalid_request",
        "Cannot act on system accounts",
      );
    }

    const reason = req.body?.reason || "No reason provided";

    await withTx(async (client) => {
      if (action === "freeze") {
        await freezeAccount(client, id, reason, "analyst");
      } else if (action === "unfreeze") {
        await unfreezeAccount(client, id, reason, "analyst");
      } else if (action === "blacklist") {
        await blacklistAccount(client, id, reason, "analyst");
      } else if (action === "unblacklist") {
        await unblacklistAccount(client, id, reason, "analyst");
      }
    });

    res.json({ ok: true });
  });
}

router.post(
  "/accounts/:id/freeze",
  requireAuth,
  requireRole("analyst"),
  handleAccountAction("freeze"),
);
router.post(
  "/accounts/:id/unfreeze",
  requireAuth,
  requireRole("analyst"),
  handleAccountAction("unfreeze"),
);
router.post(
  "/accounts/:id/blacklist",
  requireAuth,
  requireRole("analyst"),
  handleAccountAction("blacklist"),
);
router.post(
  "/accounts/:id/unblacklist",
  requireAuth,
  requireRole("analyst"),
  handleAccountAction("unblacklist"),
);

export { router as adminRouter };
