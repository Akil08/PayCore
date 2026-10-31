import type { Pool } from "pg";
import { randomUUID } from "node:crypto";

export interface TestAccount {
  id: string;
  email: string;
  accountId: string;
  token: string;
  isFraud: boolean;
  scenario: string;
}

const TEST_PASSWORD = "TestPass#12345";

export async function registerAndFundAccount(
  pool: Pool,
  runId: string,
  scenario: string,
  index: number,
  isFraud: boolean,
): Promise<TestAccount> {
  // Generate truly unique email with random UUID component
  const uniqueId = randomUUID().substring(0, 8);
  const email = isFraud
    ? `test_fraud_${scenario}_${index}_${runId}_${uniqueId}@paycore.test`
    : `test_legit_${index}_${runId}_${uniqueId}@paycore.test`;

  const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

  const registerRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });

  if (!registerRes.ok) {
    throw new Error(`Failed to register ${email}: ${await registerRes.text()}`);
  }

  const registerData = await registerRes.json();

  if (
    typeof registerData.account_id !== "string" ||
    registerData.account_id.trim() === ""
  ) {
    throw new Error(
      `Registration response missing valid account_id string for ${email}`,
    );
  }
  if (
    typeof registerData.token !== "string" ||
    registerData.token.trim() === ""
  ) {
    throw new Error(
      `Registration response missing valid token string for ${email}`,
    );
  }

  const accountId = registerData.account_id;
  const token = registerData.token;

  const balanceRes = await pool.query(
    "SELECT balance FROM accounts WHERE id = $1",
    [accountId],
  );
  const balanceRow = balanceRes.rows[0];

  if (
    !balanceRow ||
    typeof balanceRow.balance === "undefined" ||
    balanceRow.balance === null
  ) {
    throw new Error(
      `Account ${accountId} balance is missing in database after registration`,
    );
  }

  const balanceNum = Number(balanceRow.balance);
  if (!Number.isSafeInteger(balanceNum)) {
    throw new Error(
      `Account ${email} has invalid non-integer balance: ${balanceRow.balance}`,
    );
  }

  let currentBalance = balanceNum;

  if (currentBalance === 0) {
    const depositRes = await fetch(`${BASE_URL}/api/accounts/deposit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ amount: 1000000 }),
    });

    if (!depositRes.ok) {
      throw new Error(`Failed to fund ${email}: ${await depositRes.text()}`);
    }

    const finalBalanceRes = await pool.query(
      "SELECT balance FROM accounts WHERE id = $1",
      [accountId],
    );
    const finalBalanceRow = finalBalanceRes.rows[0];

    if (
      !finalBalanceRow ||
      typeof finalBalanceRow.balance === "undefined" ||
      finalBalanceRow.balance === null
    ) {
      throw new Error(
        `Account ${accountId} balance is missing in database after deposit`,
      );
    }

    const finalBalanceNum = Number(finalBalanceRow.balance);
    if (!Number.isSafeInteger(finalBalanceNum)) {
      throw new Error(
        `Account ${email} has invalid non-integer balance after deposit: ${finalBalanceRow.balance}`,
      );
    }

    currentBalance = finalBalanceNum;
  }

  if (currentBalance !== 1000000) {
    throw new Error(
      `Account ${email} has unexpected balance ${currentBalance}, expected exactly 1000000`,
    );
  }

  const userRes = await pool.query(
    "SELECT user_id FROM accounts WHERE id = $1",
    [accountId],
  );
  const userId = userRes.rows[0].user_id;

  return {
    id: userId,
    email,
    accountId,
    token,
    isFraud,
    scenario,
  };
}

export function generateIdempotencyKey(): string {
  return randomUUID();
}

export type TransferResult = {
  success: boolean;
  type:
    | "success"
    | "declined"
    | "http_error"
    | "network_error"
    | "invalid_response"
    | "unexpected_response";
  status?: string;
  failedCheck?: string;
  transferId?: string;
  data?: any;
  error?: any;
};

export async function makeTransfer(
  token: string,
  receiverAccountId: string,
  amount: number,
  deviceId: string | null,
  idempotencyKey: string,
): Promise<TransferResult> {
  const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "Idempotency-Key": idempotencyKey,
  };
  if (deviceId) {
    headers["X-Device-Id"] = deviceId;
  }

  try {
    const res = await fetch(`${BASE_URL}/api/transfers`, {
      method: "POST",
      headers,
      body: JSON.stringify({ receiver_account_id: receiverAccountId, amount }),
    });

    let data;
    try {
      data = await res.json();
    } catch {
      return {
        success: false,
        type: "invalid_response",
        error: "Invalid JSON response",
        status: res.status.toString(),
      };
    }

    if (res.status === 201) {
      if (
        data.status !== "held" ||
        typeof data.transfer_id !== "string" ||
        data.transfer_id.trim() === ""
      ) {
        return {
          success: false,
          type: "unexpected_response",
          status: data.status,
          error: "Missing or invalid transfer_id/status for 201 response",
          data,
        };
      }
      return {
        success: true,
        type: "success",
        status: "held",
        transferId: data.transfer_id,
        data,
      };
    } else if (res.status === 200) {
      if (
        data.status !== "declined" ||
        typeof data.transfer_id !== "string" ||
        data.transfer_id.trim() === "" ||
        typeof data.reason !== "string"
      ) {
        return {
          success: false,
          type: "unexpected_response",
          status: data.status,
          error:
            "Missing or invalid transfer_id/status/reason for 200 response",
          data,
        };
      }
      return {
        success: false,
        type: "declined",
        status: "declined",
        failedCheck: data.reason,
        transferId: data.transfer_id,
        data,
      };
    } else if (res.ok) {
      return {
        success: false,
        type: "unexpected_response",
        status: res.status.toString(),
        data,
      };
    } else {
      return {
        success: false,
        type: "http_error",
        status: res.status.toString(),
        data,
      };
    }
  } catch (err) {
    return {
      success: false,
      type: "network_error",
      error: err,
    };
  }
}

export async function checkTransferSettled(
  pool: Pool,
  transferId: string,
): Promise<boolean> {
  const res = await pool.query("SELECT status FROM transfers WHERE id = $1", [
    transferId,
  ]);
  return res.rows.length > 0 && res.rows[0].status === "settled";
}
