import { pool } from "../src/db.js";
import bcrypt from "bcryptjs";

async function run() {
  try {
    const res = await pool.query(
      "SELECT email, password_hash, role FROM users",
    );
    console.log("Users in database:", res.rows);

    const analyst = res.rows.find((u) => u.email === "analyst@paycore.dev");
    if (!analyst) {
      console.log("❌ analyst@paycore.dev NOT FOUND IN DATABASE!");
    } else {
      console.log("✅ Analyst found:", analyst.email, analyst.role);
      const match = await bcrypt.compare(
        "Analyst#12345",
        analyst.password_hash,
      );
      console.log("Password 'Analyst#12345' match result:", match);
    }
  } catch (err) {
    console.error("Debug error:", err);
  } finally {
    await pool.end();
  }
}

run();
