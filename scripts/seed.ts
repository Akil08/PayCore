import { Client } from "pg";
import * as dotenv from "dotenv";
import bcrypt from "bcryptjs";

dotenv.config();

async function main(): Promise<void> {
  const ssl =
    process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false;
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: ssl as any,
  });

  try {
    await client.connect();
    
    const analystPassword = "Analyst#12345";
    const userPassword = "User#12345";

    const analystHash = await bcrypt.hash(analystPassword, 10);
    const userHash = await bcrypt.hash(userPassword, 10);

    // Insert analyst
    // Insert analyst (FORCED UPDATE to fix any old broken passwords)
    await client.query(
      `
      INSERT INTO users (email, password_hash, role)
      VALUES ('analyst@paycore.dev', $1, 'analyst')
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
    `,
      [analystHash],
    );

    // Insert alice
    const aliceRes = await client.query(
      `
      INSERT INTO users (email, password_hash, role)
      VALUES ('alice@paycore.dev', $1, 'user')
      ON CONFLICT (email) DO NOTHING
      RETURNING id
    `,
      [userHash],
    );

    let aliceId = aliceRes.rows[0]?.id;
    if (!aliceId) {
      const existingAlice = await client.query(
        "SELECT id FROM users WHERE email = $1",
        ["alice@paycore.dev"],
      );
      aliceId = existingAlice.rows[0].id;
    }

    await client.query(
      `
      INSERT INTO accounts (user_id, type, balance, status)
      VALUES ($1, 'user', 0, 'active')
      ON CONFLICT (user_id) DO NOTHING
    `,
      [aliceId],
    );

    // Insert bob
    const bobRes = await client.query(
      `
      INSERT INTO users (email, password_hash, role)
      VALUES ('bob@paycore.dev', $1, 'user')
      ON CONFLICT (email) DO NOTHING
      RETURNING id
    `,
      [userHash],
    );

    let bobId = bobRes.rows[0]?.id;
    if (!bobId) {
      const existingBob = await client.query(
        "SELECT id FROM users WHERE email = $1",
        ["bob@paycore.dev"],
      );
      bobId = existingBob.rows[0].id;
    }

    await client.query(
      `
      INSERT INTO accounts (user_id, type, balance, status)
      VALUES ($1, 'user', 0, 'active')
      ON CONFLICT (user_id) DO NOTHING
    `,
      [bobId],
    );

    console.log("Database seeded successfully.");
  } catch (err) {
    console.error("Failed to seed database:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
