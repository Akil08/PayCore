import { runReconciliation } from "../services/recon.js";

const RECON_INTERVAL_MS = parseInt(
  process.env.RECON_INTERVAL_MS || "300000",
  10,
);

export function startReconJob(): void {
  const schedule = async (): Promise<void> => {
    try {
      const result = await runReconciliation();
      if (!result.passed) {
        console.error("Reconciliation FAILED:", result);
      } else {
        console.log("Reconciliation PASSED");
      }
    } catch (err) {
      console.error("Reconciliation job error:", err);
    }

    setTimeout(schedule, RECON_INTERVAL_MS);
  };

  setTimeout(schedule, RECON_INTERVAL_MS);
}
