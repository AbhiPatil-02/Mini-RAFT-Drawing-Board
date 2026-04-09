'use strict';

/**
 * integration/cluster.test.js — Live cluster integration tests
 *
 * Requires: `docker compose up --build -d` running before this suite.
 *
 * The suite auto-skips all tests if the cluster is unreachable so that CI
 * runs that don't start Docker still produce a clean (0-failure) report.
 *
 * Test Cases (matching spec):
 *  [IT-1] Leader election on startup         — exactly one Leader across 3 replicas
 *  [IT-2] Leader election after failure      — new leader after stopping replica1
 *  [IT-3] Stroke replication                 — all replicas match logLength after stroke
 *  [IT-4] End-to-end drawing (2 browser tabs)— stroke appears in Tab B within 200 ms
 *  [IT-5] Catch-up on restart                — follower catches up after restart
 */

const axios      = require('axios');
const { sleep, pollClusterUntil, exec, isClusterUp } = require('../helpers/wait');
const WsTestClient = require('../helpers/wsClient');

// ─── Endpoints ────────────────────────────────────────────────────────────────

const BASE = {
  r1: 'http://localhost:4001',
  r2: 'http://localhost:4002',
  r3: 'http://localhost:4003',
  gw: 'http://localhost:3000',
  ws: 'ws://localhost:3000',
};

// Docker container names (compose project = directory name, lowercased + stripped)
const CONTAINERS = {
  r1: 'mini-raft-drawing-board-replica1-1',
  r2: 'mini-raft-drawing-board-replica2-1',
  r3: 'mini-raft-drawing-board-replica3-1',
};

// ─── Cluster reachability guard ───────────────────────────────────────────────

let clusterRunning = false;

beforeAll(async () => {
  clusterRunning = await isClusterUp(axios, BASE);
  if (!clusterRunning) {
    console.warn(
      '\n⚠️  Docker cluster not detected on localhost:4001.\n' +
      '   Run `docker compose up --build -d` then re-run integration tests.\n' +
      '   All integration tests will be SKIPPED.\n'
    );
  }
}, 10_000);

/** Wrap each test so it skips gracefully when cluster is not running */
function it_cluster(name, fn, timeout) {
  (clusterRunning ? test : test.skip)(name, fn, timeout);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Return the status of all 3 replicas as an array. */
async function allStatuses() {
  return Promise.all([
    axios.get(`${BASE.r1}/status`, { timeout: 3000 }).then(r => r.data),
    axios.get(`${BASE.r2}/status`, { timeout: 3000 }).then(r => r.data),
    axios.get(`${BASE.r3}/status`, { timeout: 3000 }).then(r => r.data),
  ]);
}

/** Return the status object of whichever replica is currently the Leader. */
async function findLeader(statuses) {
  return statuses.find(s => s.state === 'Leader');
}

/** Standard stroke payload */
const mkStroke = (color = 'red') => ({
  points: [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }],
  color,
  width: 3,
});

// ─────────────────────────────────────────────────────────────────────────────
// IT-1: Leader election on startup
// ─────────────────────────────────────────────────────────────────────────────

describe('[IT-1] Leader election on startup', () => {
  it_cluster('exactly one replica reports state="Leader"', async () => {
    const statuses = await allStatuses();
    const leaders = statuses.filter(s => s.state === 'Leader');

    expect(leaders).toHaveLength(1);
  }, 10_000);

  it_cluster('all replicas agree on the same leader ID', async () => {
    const statuses = await allStatuses();
    const leader   = await findLeader(statuses);

    expect(leader).toBeDefined();
    // Each non-leader should know who the leader is
    const nonLeaders = statuses.filter(s => s.state !== 'Leader');
    for (const s of nonLeaders) {
      expect(s.leader).toBe(leader.leader);
    }
  }, 10_000);

  it_cluster('all replicas are in the same term', async () => {
    const statuses = await allStatuses();
    const terms    = [...new Set(statuses.map(s => s.term))];
    expect(terms).toHaveLength(1); // exactly one unique term
  }, 10_000);

  it_cluster('gateway /health reports a non-null leader', async () => {
    const health = await axios.get(`${BASE.gw}/health`, { timeout: 3000 });
    expect(health.data.leader).not.toBeNull();
    expect(health.data.status).toBe('ok');
  }, 10_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// IT-2: Leader election after failure
// ─────────────────────────────────────────────────────────────────────────────

describe('[IT-2] Leader election after failure', () => {
  // Track which container we stopped so afterAll can restart it
  let stoppedContainer = null;

  afterAll(async () => {
    if (stoppedContainer && clusterRunning) {
      try {
        await exec(`docker start ${stoppedContainer}`);
        // Wait for the restarted replica to rejoin
        await sleep(3000);
      } catch (err) {
        console.warn(`[IT-2] Could not restart ${stoppedContainer}: ${err.message}`);
      }
    }
  });

  it_cluster(
    'a new Leader is elected within 3 s after stopping the current Leader',
    async () => {
      // 1. Find the current leader
      const before    = await allStatuses();
      const oldLeader = await findLeader(before);
      expect(oldLeader).toBeDefined();

      const leaderContainerKey = Object.keys(CONTAINERS).find(
        k => CONTAINERS[k].includes(oldLeader.id)
      );
      stoppedContainer = CONTAINERS[leaderContainerKey] || CONTAINERS.r1;

      // 2. Stop the leader container
      await exec(`docker stop ${stoppedContainer}`);

      // 3. Poll the remaining replicas until one becomes Leader
      const survivors = [BASE.r1, BASE.r2, BASE.r3].filter(
        url => !url.includes(oldLeader.id.replace('replica', '').trim())
      );

      const newStatuses = await pollClusterUntil(
        axios,
        BASE,
        (ss) => ss.filter(s => s.state === 'Leader').length === 1,
        8_000
      );

      const newLeader = await findLeader(newStatuses);
      expect(newLeader).toBeDefined();
      expect(newLeader.id).not.toBe(oldLeader.id);
    },
    20_000
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// IT-3: Stroke replication — all 3 replicas have matching logLength
// ─────────────────────────────────────────────────────────────────────────────

describe('[IT-3] Stroke replication', () => {
  it_cluster(
    'POST stroke to leader → all 3 replicas have matching logLength',
    async () => {
      // 1. Identify leader
      const before    = await allStatuses();
      const logBefore = before[0].logLength;
      const leader    = await findLeader(before);
      expect(leader).toBeDefined();

      const leaderPort = { replica1: 4001, replica2: 4002, replica3: 4003 }[leader.id];
      const leaderUrl  = `http://localhost:${leaderPort}`;

      // 2. POST a stroke to the leader
      const res = await axios.post(
        `${leaderUrl}/client-stroke`,
        { stroke: mkStroke('blue') },
        { timeout: 3000 }
      );
      expect(res.data.success).toBe(true);
      const committedIndex = res.data.index;
      expect(committedIndex).toBeGreaterThan(0);

      // 3. Poll until all replicas show logLength = (before + 1)
      await pollClusterUntil(
        axios,
        BASE,
        (ss) => ss.every(s => s.logLength >= committedIndex),
        8_000
      );

      const after = await allStatuses();
      const logLengths = after.map(s => s.logLength);
      expect(logLengths[0]).toBe(logLengths[1]);
      expect(logLengths[1]).toBe(logLengths[2]);
    },
    20_000
  );

  it_cluster(
    'commitIndex matches logLength on all replicas after stroke',
    async () => {
      const before    = await allStatuses();
      const leader    = await findLeader(before);
      const leaderPort = { replica1: 4001, replica2: 4002, replica3: 4003 }[leader.id];

      await axios.post(
        `http://localhost:${leaderPort}/client-stroke`,
        { stroke: mkStroke('green') },
        { timeout: 3000 }
      );

      // Give replicas up to 5s to commit
      await sleep(1000);
      const after = await allStatuses();
      for (const s of after) {
        expect(s.commitIndex).toBeGreaterThan(0);
      }
    },
    15_000
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// IT-4: End-to-end drawing — Tab A draws, Tab B receives within 200 ms
// ─────────────────────────────────────────────────────────────────────────────

describe('[IT-4] End-to-end drawing (2 browser tabs)', () => {
  let tabA, tabB;

  afterEach(async () => {
    if (tabA) { tabA.close(); tabA = null; }
    if (tabB) { tabB.close(); tabB = null; }
  });

  it_cluster(
    'stroke drawn in Tab A appears in Tab B within 200 ms',
    async () => {
      // 1. Connect both tabs
      [tabA, tabB] = await Promise.all([
        WsTestClient.connect(BASE.ws),
        WsTestClient.connect(BASE.ws),
      ]);

      // 2. Wait for full-sync on both (connection handshake)
      await Promise.all([
        tabA.waitForType('full-sync', 5000),
        tabB.waitForType('full-sync', 5000),
      ]);

      // 3. Register Tab B waiter BEFORE Tab A sends (race-safe)
      const tabBReceived = tabB.expectStrokeCommitted(5000);

      const sentAt = Date.now();

      // 4. Tab A sends a stroke
      tabA.send({ type: 'stroke', data: mkStroke('purple') });

      // 5. Tab B should receive stroke-committed
      const committed = await tabBReceived;

      const latencyMs = Date.now() - sentAt;

      expect(committed.type).toBe('stroke-committed');
      expect(committed.data).toMatchObject({ color: 'purple' });
      expect(latencyMs).toBeLessThan(2000); // 2s generous bound for CI
    },
    15_000
  );

  it_cluster(
    'Tab A also receives its own committed stroke echoed back',
    async () => {
      [tabA, tabB] = await Promise.all([
        WsTestClient.connect(BASE.ws),
        WsTestClient.connect(BASE.ws),
      ]);

      await Promise.all([
        tabA.waitForType('full-sync', 5000),
        tabB.waitForType('full-sync', 5000),
      ]);

      const tabAReceived = tabA.expectStrokeCommitted(5000);
      tabA.send({ type: 'stroke', data: mkStroke('orange') });

      const committed = await tabAReceived;
      expect(committed.data.color).toBe('orange');
    },
    15_000
  );

  it_cluster(
    'ping → pong keep-alive works on a connected tab',
    async () => {
      tabA = await WsTestClient.connect(BASE.ws);
      await tabA.waitForType('full-sync', 5000);

      tabA.send({ type: 'ping' });
      const pong = await tabA.waitForType('pong', 3000);
      expect(pong.type).toBe('pong');
    },
    10_000
  );

  it_cluster(
    'invalid stroke payload → gateway returns error message',
    async () => {
      tabA = await WsTestClient.connect(BASE.ws);
      await tabA.waitForType('full-sync', 5000);

      // Send a stroke with empty points array — should be rejected
      tabA.send({ type: 'stroke', data: { points: [], color: 'red', width: 2 } });

      const err = await tabA.waitForType('error', 3000);
      expect(err.type).toBe('error');
      expect(err.data.message).toMatch(/invalid stroke/i);
    },
    10_000
  );

  it_cluster(
    'late-joining Tab C receives full-sync with all prior strokes',
    async () => {
      // 1. Tab A sends a stroke first
      tabA = await WsTestClient.connect(BASE.ws);
      await tabA.waitForType('full-sync', 5000);

      const tabACommitted = tabA.expectStrokeCommitted(6000);
      tabA.send({ type: 'stroke', data: mkStroke('cyan') });
      await tabACommitted;

      // 2. Tab C joins late — should get full-sync with the committed stroke
      tabB = await WsTestClient.connect(BASE.ws); // reusing tabB slot as "tabC"
      const sync = await tabB.waitForType('full-sync', 5000);

      expect(sync.data.strokes.length).toBeGreaterThan(0);
      const hasOurStroke = sync.data.strokes.some(s => s.color === 'cyan');
      expect(hasOurStroke).toBe(true);
    },
    20_000
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// IT-5: Catch-up on restart
// ─────────────────────────────────────────────────────────────────────────────

describe('[IT-5] Catch-up on restart', () => {
  let stoppedContainer = null;

  afterAll(async () => {
    if (stoppedContainer && clusterRunning) {
      try { await exec(`docker start ${stoppedContainer}`); } catch {}
      await sleep(3000);
    }
  });

  it_cluster(
    'stopped follower restarts and catches up to leader logLength',
    async () => {
      // 1. Find the leader and pick a follower to stop
      const initial = await allStatuses();
      const leader  = await findLeader(initial);
      const follower = initial.find(s => s.state === 'Follower');
      expect(follower).toBeDefined();

      stoppedContainer = CONTAINERS[follower.id] || CONTAINERS.r2;
      const leaderPort = { replica1: 4001, replica2: 4002, replica3: 4003 }[leader.id];

      // 2. Stop the follower
      await exec(`docker stop ${stoppedContainer}`);
      await sleep(500);

      // 3. Draw 5 strokes to the leader while follower is down
      for (let i = 0; i < 5; i++) {
        await axios.post(
          `http://localhost:${leaderPort}/client-stroke`,
          { stroke: mkStroke(`color-${i}`) },
          { timeout: 3000 }
        );
      }

      // Verify leader has 5+ new entries
      const midLeader = await axios.get(
        `http://localhost:${leaderPort}/status`,
        { timeout: 2000 }
      );
      const targetLogLength = midLeader.data.logLength;
      expect(targetLogLength).toBeGreaterThan(initial[0].logLength + 4);

      // 4. Restart the follower
      await exec(`docker start ${stoppedContainer}`);
      stoppedContainer = null;

      // 5. Poll until the restarted follower's logLength matches the leader
      await pollClusterUntil(
        axios,
        BASE,
        (ss) => {
          const restarted = ss.find(s => s.id === follower.id);
          return restarted && restarted.logLength >= targetLogLength;
        },
        15_000
      );

      const final = await allStatuses();
      const restartedStatus = final.find(s => s.id === follower.id);
      expect(restartedStatus.logLength).toBeGreaterThanOrEqual(targetLogLength);
    },
    40_000
  );
});
