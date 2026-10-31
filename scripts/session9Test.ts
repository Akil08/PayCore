import { pool, withTx } from "../src/db.js";
import { recordDeviceAndRecluster } from "../src/services/graph.js";
import { randomUUID } from "crypto";

type TestResult = { name: string; passed: boolean; detail?: string };
const results: TestResult[] = [];

function pass(name: string, detail?: string) {
  results.push({ name, passed: true, detail });
  console.log(`✅ PASS: ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name: string, detail: string) {
  results.push({ name, passed: false, detail });
  console.error(`❌ FAIL: ${name} — ${detail}`);
}

async function createTempAccounts(count: number): Promise<string[]> {
  const accounts: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO accounts (id, user_id, type, balance, status) 
       VALUES ($1, NULL, 'user', 0, 'active')`,
      [id],
    );
    accounts.push(id);
  }
  return accounts;
}

async function queryClusters(accountIds: string[]) {
  const res = await pool.query(
    `SELECT account_id, cluster_id, cluster_size, flagged 
     FROM account_clusters 
     WHERE account_id = ANY($1::uuid[])`,
    [accountIds],
  );
  return res.rows;
}

async function cleanup(accountIds: string[]) {
  await pool.query(
    `DELETE FROM account_clusters WHERE account_id = ANY($1::uuid[])`,
    [accountIds],
  );
  await pool.query(
    `DELETE FROM account_devices WHERE account_id = ANY($1::uuid[])`,
    [accountIds],
  );
  await pool.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [
    accountIds,
  ]);
}

async function test1_fourAccountsSameDevice() {
  const testName =
    "Test 1: 4 accounts with same device → cluster_size 4, flagged false";
  const device = `test-device-${randomUUID()}`;
  const accounts = await createTempAccounts(4);

  try {
    for (const acc of accounts) {
      await withTx(async (client) => {
        await recordDeviceAndRecluster(client, acc, device);
      });
    }

    const clusters = await queryClusters(accounts);
    if (clusters.length !== 4) {
      fail(testName, `Expected 4 cluster rows, got ${clusters.length}`);
      return;
    }

    const allSize4 = clusters.every((c: any) => c.cluster_size === 4);
    const allNotFlagged = clusters.every((c: any) => c.flagged === false);
    const sameClusterId =
      new Set(clusters.map((c: any) => c.cluster_id)).size === 1;

    if (!allSize4 || !allNotFlagged || !sameClusterId) {
      fail(
        testName,
        `cluster_size=${clusters[0].cluster_size}, flagged=${clusters[0].flagged}, unique cluster_ids=${new Set(clusters.map((c: any) => c.cluster_id)).size}`,
      );
      return;
    }

    pass(
      testName,
      `cluster_id=${clusters[0].cluster_id}, size=4, flagged=false`,
    );
  } catch (err: any) {
    fail(testName, err.message);
  } finally {
    await cleanup(accounts);
  }
}

async function test2_fifthAccountTriggersFlag() {
  const testName = "Test 2: 5th account with same device → all flagged";
  const device = `test-device-${randomUUID()}`;
  const accounts = await createTempAccounts(5);

  try {
    for (const acc of accounts) {
      await withTx(async (client) => {
        await recordDeviceAndRecluster(client, acc, device);
      });
    }

    const clusters = await queryClusters(accounts);
    const allSize5 = clusters.every((c: any) => c.cluster_size === 5);
    const allFlagged = clusters.every((c: any) => c.flagged === true);

    if (!allSize5 || !allFlagged) {
      fail(
        testName,
        `cluster_size=${clusters[0].cluster_size}, flagged=${clusters[0].flagged}`,
      );
      return;
    }

    pass(testName, `cluster_size=5, flagged=true for all 5 accounts`);
  } catch (err: any) {
    fail(testName, err.message);
  } finally {
    await cleanup(accounts);
  }
}

async function test3_noDeviceIdNoCluster() {
  const testName = "Test 3: Transfer without device_id creates no cluster rows";
  const accounts = await createTempAccounts(1);
  const accountId = accounts[0];

  try {
    const before = await pool.query(
      `SELECT COUNT(*) FROM account_clusters WHERE account_id = $1`,
      [accountId],
    );
    if (Number(before.rows[0].count) !== 0) {
      fail(testName, "Pre-existing cluster row found");
      return;
    }

    const after = await pool.query(
      `SELECT COUNT(*) FROM account_clusters WHERE account_id = $1`,
      [accountId],
    );
    if (Number(after.rows[0].count) !== 0) {
      fail(testName, "Cluster row was created despite no device_id");
      return;
    }

    pass(testName, "No cluster rows created when device_id is null");
  } catch (err: any) {
    fail(testName, err.message);
  } finally {
    await cleanup(accounts);
  }
}

async function test4_clusterMerge() {
  const testName =
    "Test 4: Two separate device groups merge when account uses both devices";
  const deviceA = `test-deviceA-${randomUUID()}`;
  const deviceB = `test-deviceB-${randomUUID()}`;

  const groupA = await createTempAccounts(3);
  const groupB = await createTempAccounts(3);
  const bridgeAccounts = await createTempAccounts(1);
  const bridgeAccount = bridgeAccounts[0];

  const allAccounts = [...groupA, ...groupB, ...bridgeAccounts];

  try {
    for (const acc of groupA) {
      await withTx(async (client) => {
        await recordDeviceAndRecluster(client, acc, deviceA);
      });
    }

    for (const acc of groupB) {
      await withTx(async (client) => {
        await recordDeviceAndRecluster(client, acc, deviceB);
      });
    }

    const clustersBefore = await queryClusters([...groupA, ...groupB]);
    const uniqueClusterIdsBefore = new Set(
      clustersBefore.map((c: any) => c.cluster_id),
    );
    if (uniqueClusterIdsBefore.size !== 2) {
      fail(
        testName,
        `Expected 2 separate clusters before merge, got ${uniqueClusterIdsBefore.size}`,
      );
      return;
    }

    await withTx(async (client) => {
      await recordDeviceAndRecluster(client, bridgeAccount, deviceA);
    });
    await withTx(async (client) => {
      await recordDeviceAndRecluster(client, bridgeAccount, deviceB);
    });

    const clustersAfter = await queryClusters(allAccounts);
    if (clustersAfter.length !== 7) {
      fail(
        testName,
        `Expected 7 cluster rows after merge, got ${clustersAfter.length}`,
      );
      return;
    }

    const uniqueClusterIdsAfter = new Set(
      clustersAfter.map((c: any) => c.cluster_id),
    );
    const allSize7 = clustersAfter.every((c: any) => c.cluster_size === 7);

    if (uniqueClusterIdsAfter.size !== 1 || !allSize7) {
      fail(
        testName,
        `After merge: unique cluster_ids=${uniqueClusterIdsAfter.size}, cluster_size=${clustersAfter[0].cluster_size}`,
      );
      return;
    }

    pass(
      testName,
      `Merged into single cluster of size 7, cluster_id=${clustersAfter[0].cluster_id}`,
    );
  } catch (err: any) {
    fail(testName, err.message);
  } finally {
    await cleanup(allAccounts);
  }
}

async function test5_idempotency() {
  const testName =
    "Test 5: Re-delivery of same event does not create duplicates";
  const device = `test-device-${randomUUID()}`;
  const accounts = await createTempAccounts(1);
  const accountId = accounts[0];

  try {
    await withTx(async (client) => {
      await recordDeviceAndRecluster(client, accountId, device);
    });

    const clustersFirst = await queryClusters([accountId]);
    if (clustersFirst.length !== 1) {
      fail(
        testName,
        `Expected 1 cluster row after first call, got ${clustersFirst.length}`,
      );
      return;
    }

    await withTx(async (client) => {
      await recordDeviceAndRecluster(client, accountId, device);
    });

    const clustersSecond = await queryClusters([accountId]);
    if (clustersSecond.length !== 1) {
      fail(
        testName,
        `Expected 1 cluster row after second call, got ${clustersSecond.length}`,
      );
      return;
    }

    const devices = await pool.query(
      `SELECT COUNT(*) FROM account_devices WHERE account_id = $1 AND device_id = $2`,
      [accountId, device],
    );
    if (Number(devices.rows[0].count) !== 1) {
      fail(testName, `Expected 1 device row, got ${devices.rows[0].count}`);
      return;
    }

    pass(testName, "No duplicates in account_clusters or account_devices");
  } catch (err: any) {
    fail(testName, err.message);
  } finally {
    await cleanup(accounts);
  }
}

async function test6_inlineDeclinePath() {
  const testName =
    "Test 6: Flagged account transfer declined with cluster (inline check)";
  const device = `test-device-${randomUUID()}`;
  const accounts = await createTempAccounts(5);

  try {
    for (const acc of accounts) {
      await withTx(async (client) => {
        await recordDeviceAndRecluster(client, acc, device);
      });
    }

    const clusters = await queryClusters(accounts);
    const allFlagged = clusters.every((c: any) => c.flagged === true);

    if (!allFlagged) {
      fail(testName, "Cluster not properly flagged");
      return;
    }

    const inlineCheck = await pool.query(
      `SELECT flagged FROM account_clusters WHERE account_id = $1`,
      [accounts[0]],
    );

    if (inlineCheck.rows.length === 0 || !inlineCheck.rows[0].flagged) {
      fail(testName, "Inline check would not find flagged cluster");
      return;
    }

    pass(testName, "Flagged cluster exists and inline check can read it");
  } catch (err: any) {
    fail(testName, err.message);
  } finally {
    await cleanup(accounts);
  }
}

async function main() {
  console.log("🧪 Session 9: Graph Consumer Test Suite\n");

  await test1_fourAccountsSameDevice();
  await test2_fifthAccountTriggersFlag();
  await test3_noDeviceIdNoCluster();
  await test4_clusterMerge();
  await test5_idempotency();
  await test6_inlineDeclinePath();

  console.log("\n" + "=".repeat(60));
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log(`Results: ${passed}/${total} tests passed`);

  if (passed === total) {
    console.log("✅ ALL TESTS PASSED");
    await pool.end();
    process.exit(0);
  } else {
    console.error("❌ SOME TESTS FAILED");
    await pool.end();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  pool.end();
  process.exit(1);
});
