import { runReconciliation } from "../src/services/recon.js";

async function main(): Promise<void> {
  try {
    console.log("Running reconciliation...");
    const result = await runReconciliation();
    console.log(JSON.stringify(result, null, 2));

    if (result.passed) {
      console.log("Reconciliation PASSED");
      process.exit(0);
    } else {
      console.error("Reconciliation FAILED");
      process.exit(1);
    }
  } catch (err) {
    console.error("Reconciliation execution error:", err);
    process.exit(1);
  }
}

main();
