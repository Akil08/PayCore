
import { pool } from "../src/db.js";

async function checkCleanup() {
  try {
    console.log("\n🔍 Checking test database cleanup...\n");

    // 1. Check for leftover temporary test users
    const users = await pool.query(`
      SELECT id, email
      FROM users
      WHERE email LIKE 'alice_%@test.com'
         OR email LIKE 'bob_%@test.com'
         OR email LIKE 'standard_%@test.com'
         OR email LIKE 'velocity_%@test.com'
         OR email LIKE 'concurrency_%@test.com'
         OR email LIKE 'receiver_%@test.com'
      ORDER BY email
    `);

    console.log("1. Temporary test users remaining:", users.rowCount);
    console.table(users.rows);

    // 2. Check for transfers created by the advanced test
    const transfers = await pool.query(`
      SELECT id, sender_account_id, idempotency_key
      FROM transfers
      WHERE idempotency_key LIKE 'replay-%'
         OR idempotency_key LIKE 'conflict-%'
         OR idempotency_key LIKE 'velocity-%'
         OR idempotency_key LIKE 'concurrent-%'
         OR idempotency_key LIKE 'insufficient-%'
         OR idempotency_key LIKE 'self-%'
    `);

    console.log("\n2. Matching test transfers remaining:", transfers.rowCount);
    console.table(transfers.rows);

    // 3. Discover separate idempotency-related tables
    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name ILIKE '%idempotency%'
      ORDER BY table_name
    `);

    console.log("\n3. Idempotency-related tables:");
    console.table(tables.rows);

    // 4. Check for ledger entries tied to remaining test transfers
    const ledger = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM ledger
      WHERE transfer_id IN (
        SELECT id
        FROM transfers
        WHERE idempotency_key LIKE 'replay-%'
           OR idempotency_key LIKE 'conflict-%'
           OR idempotency_key LIKE 'velocity-%'
           OR idempotency_key LIKE 'concurrent-%'
           OR idempotency_key LIKE 'insufficient-%'
           OR idempotency_key LIKE 'self-%'
      )
    `);

    console.log(
      "\n4. Ledger entries for matching test transfers:",
      ledger.rows[0].count,
    );

    const clean =
      users.rowCount === 0 &&
      transfers.rowCount === 0 &&
      ledger.rows[0].count === 0;

    console.log(
      clean
        ? "\n✅ BASIC CLEANUP CHECK PASSED."
        : "\n⚠️ LEFTOVER TEST DATA FOUND. Investigate before deleting anything.",
    );

    if (tables.rowCount && tables.rows.length > 0) {
      console.log(
        "\n⚠️ Inspect the idempotency-related tables above separately; this script does not check their contents.",
      );
    }
  } catch (error) {
    console.error("❌ Database check failed:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

checkCleanup();
