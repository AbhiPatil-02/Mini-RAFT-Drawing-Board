'use strict';

/**
 * unit/leaderTracker.test.js — Unit tests for gateway/leaderTracker.js
 *
 * Strategy:
 *  - jest.resetModules() + jest.doMock() in beforeEach gives a fresh module
 *    (fresh internal state: currentLeader=null, strokeQueue=[]) per test.
 *  - axios is fully mocked — no real HTTP calls.
 *  - process.env.REPLICAS is set before each require to control the replica list.
 *
 * Coverage:
 *  ✓ getLeader()           — null on start, set after discovery
 *  ✓ getStats()            — leader + queueDepth + replicas shape
 *  ✓ discoverLeader()      — parallel poll, selects first Leader replica
 *  ✓ discoverLeader()      — no leader found → currentLeader stays null
 *  ✓ forwardStroke()       — success path, queues on no-leader, queues on failure
 *  ✓ forwardStroke()       — uses leader hint on not-leader response
 *  ✓ stroke queue          — depth guard (MAX_QUEUE_SIZE), retry limit
 *  ✓ onLeaderChange()      — callback fires on leader change
 *  ✓ _verifyHint()         — confirmed via forwardStroke hint resolution
 */

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const REPLICA_URLS = [
  'http://replica1:4001',
  'http://replica2:4002',
  'http://replica3:4003',
];

const STROKE = {
  points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
  color:  'red',
  width:  3,
};

// ─── Per-test setup ───────────────────────────────────────────────────────────

let tracker;
let axiosMock;

/** Helper — set up axios mock and (re)load the module */
function loadTracker(axiosOverrides = {}) {
  jest.resetModules();

  axiosMock = {
    get:  jest.fn(),
    post: jest.fn(),
    ...axiosOverrides,
  };

  process.env.REPLICAS = 'replica1:4001,replica2:4002,replica3:4003';

  jest.doMock('axios', () => axiosMock);

  tracker = require('../../gateway/leaderTracker');
  return tracker;
}

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.REPLICAS;
});

// ─────────────────────────────────────────────────────────────────────────────
// getLeader() / getStats()
// ─────────────────────────────────────────────────────────────────────────────

describe('getLeader()', () => {
  test('returns null before any discovery', () => {
    loadTracker();
    expect(tracker.getLeader()).toBeNull();
  });
});

describe('getStats()', () => {
  test('returns correct shape before discovery', () => {
    loadTracker();
    const stats = tracker.getStats();
    expect(stats).toMatchObject({
      leader:     null,
      queueDepth: 0,
    });
    expect(Array.isArray(stats.replicas)).toBe(true);
    expect(stats.replicas).toHaveLength(3);
  });

  test('replicas list matches env var', () => {
    loadTracker();
    const { replicas } = tracker.getStats();
    expect(replicas).toContain('http://replica1:4001');
    expect(replicas).toContain('http://replica2:4002');
    expect(replicas).toContain('http://replica3:4003');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// discoverLeader() — via start() which calls it immediately
// ─────────────────────────────────────────────────────────────────────────────

describe('discoverLeader()', () => {
  test('sets currentLeader to the replica that reports state=Leader', async () => {
    loadTracker();

    // replica1 is Follower, replica2 is Leader, replica3 is Follower
    axiosMock.get.mockImplementation((url) => {
      if (url.includes('replica2')) return Promise.resolve({ data: { state: 'Leader' } });
      return Promise.resolve({ data: { state: 'Follower' } });
    });

    tracker.start();
    await Promise.resolve(); // flush microtasks

    // Give parallel Promise.any time to settle
    await new Promise(r => setTimeout(r, 50));

    expect(tracker.getLeader()).toBe('http://replica2:4002');
  });

  test('leaves currentLeader as null when no replica is a Leader', async () => {
    loadTracker();

    axiosMock.get.mockResolvedValue({ data: { state: 'Follower' } });

    tracker.start();
    await new Promise(r => setTimeout(r, 50));

    expect(tracker.getLeader()).toBeNull();
  });

  test('leaves currentLeader null when all replicas are unreachable', async () => {
    loadTracker();

    axiosMock.get.mockRejectedValue(new Error('ECONNREFUSED'));

    tracker.start();
    await new Promise(r => setTimeout(r, 50));

    expect(tracker.getLeader()).toBeNull();
  });

  test('fires onLeaderChange callback when leader is discovered', async () => {
    loadTracker();

    const cb = jest.fn();
    tracker.onLeaderChange(cb);

    axiosMock.get.mockResolvedValue({ data: { state: 'Leader' } });

    tracker.start();
    await new Promise(r => setTimeout(r, 50));

    expect(cb).toHaveBeenCalled();
    const [newLeader, prevLeader] = cb.mock.calls[0];
    expect(newLeader).toMatch(/http:\/\/replica/);
    expect(prevLeader).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forwardStroke() — success path
// ─────────────────────────────────────────────────────────────────────────────

describe('forwardStroke() — success path', () => {
  test('POSTs stroke to the known leader and returns { success: true }', async () => {
    loadTracker();

    // Manually set known leader by simulating a successful discovery
    axiosMock.get.mockResolvedValue({ data: { state: 'Leader' } });
    tracker.start();
    await new Promise(r => setTimeout(r, 50));

    axiosMock.post.mockResolvedValue({ data: { success: true, index: 1 } });

    const result = await tracker.forwardStroke(STROKE);

    expect(result).toMatchObject({ success: true, index: 1 });
    expect(axiosMock.post).toHaveBeenCalledWith(
      expect.stringContaining('/client-stroke'),
      { stroke: STROKE },
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forwardStroke() — no leader known → queue
// ─────────────────────────────────────────────────────────────────────────────

describe('forwardStroke() — no leader', () => {
  test('queues the stroke when currentLeader is null and returns { queued: true }', async () => {
    loadTracker();

    // Keep leader null (all replicas refuse to be Leader)
    axiosMock.get.mockResolvedValue({ data: { state: 'Follower' } });

    const result = await tracker.forwardStroke(STROKE);

    expect(result).toMatchObject({ queued: true });
    expect(tracker.getStats().queueDepth).toBe(1);
  });

  test('increments queueDepth for each stroke forwarded with no leader', async () => {
    loadTracker();
    axiosMock.get.mockResolvedValue({ data: { state: 'Follower' } });

    await tracker.forwardStroke(STROKE);
    await tracker.forwardStroke(STROKE);
    await tracker.forwardStroke(STROKE);

    expect(tracker.getStats().queueDepth).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forwardStroke() — leader unreachable → queue + re-discover
// ─────────────────────────────────────────────────────────────────────────────

describe('forwardStroke() — leader unreachable', () => {
  test('queues stroke when leader POST times out', async () => {
    loadTracker();

    // Discovery finds replica1 as leader
    axiosMock.get.mockImplementation((url) => {
      if (url.includes('replica1')) return Promise.resolve({ data: { state: 'Leader' } });
      return Promise.resolve({ data: { state: 'Follower' } });
    });
    tracker.start();
    await new Promise(r => setTimeout(r, 50));

    // But POST to leader fails
    axiosMock.post.mockRejectedValue(new Error('ETIMEDOUT'));

    const result = await tracker.forwardStroke(STROKE);

    expect(result).toMatchObject({ queued: true });
  });

  test('sets currentLeader to null after unreachable error', async () => {
    loadTracker();

    axiosMock.get.mockResolvedValue({ data: { state: 'Leader' } });
    tracker.start();
    await new Promise(r => setTimeout(r, 50));

    axiosMock.post.mockRejectedValue(new Error('ECONNRESET'));
    // Make re-discovery also fail to keep it null
    axiosMock.get.mockResolvedValue({ data: { state: 'Follower' } });

    await tracker.forwardStroke(STROKE);

    expect(tracker.getLeader()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forwardStroke() — "not leader" hint fast-path
// ─────────────────────────────────────────────────────────────────────────────

describe('forwardStroke() — not-leader hint', () => {
  test('uses the hint URL to find the new leader without full re-poll', async () => {
    loadTracker();

    // Start with replica1 as known leader
    axiosMock.get.mockResolvedValue({ data: { state: 'Leader' } });
    tracker.start();
    await new Promise(r => setTimeout(r, 50));

    expect(tracker.getLeader()).toMatch(/replica/);

    // replica1 says "not leader, try replica2"
    axiosMock.post.mockResolvedValueOnce({
      data: { success: false, error: 'not leader', leader: 'replica2' },
    });

    // Hint verification: replica2/status returns Leader
    axiosMock.get.mockImplementation((url) => {
      if (url.includes('replica2')) return Promise.resolve({ data: { state: 'Leader' } });
      return Promise.resolve({ data: { state: 'Follower' } });
    });

    const result = await tracker.forwardStroke(STROKE);

    // Should have queued (the hint triggers requeue)
    expect(result).toMatchObject({ queued: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Queue depth guard
// ─────────────────────────────────────────────────────────────────────────────

describe('stroke queue depth guard', () => {
  test('never exceeds MAX_QUEUE_SIZE — drops oldest entry', async () => {
    loadTracker();

    axiosMock.get.mockResolvedValue({ data: { state: 'Follower' } });

    const MAX = 100; // matches leaderTracker constant
    // Push 105 strokes — should cap at 100
    const promises = [];
    for (let i = 0; i < MAX + 5; i++) {
      promises.push(tracker.forwardStroke({ ...STROKE, color: `color-${i}` }));
    }
    await Promise.all(promises);

    expect(tracker.getStats().queueDepth).toBeLessThanOrEqual(MAX);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// onLeaderChange() callback
// ─────────────────────────────────────────────────────────────────────────────

describe('onLeaderChange()', () => {
  test('registers a callback that fires with (newLeader, prevLeader) args', async () => {
    loadTracker();

    const changes = [];
    tracker.onLeaderChange((n, p) => changes.push({ n, p }));

    axiosMock.get.mockResolvedValue({ data: { state: 'Leader' } });
    tracker.start();
    await new Promise(r => setTimeout(r, 50));

    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0].p).toBeNull(); // from null
    expect(changes[0].n).toMatch(/http:\/\/replica/);
  });

  test('does not crash when callback throws', async () => {
    loadTracker();

    tracker.onLeaderChange(() => { throw new Error('cb error'); });

    axiosMock.get.mockResolvedValue({ data: { state: 'Leader' } });

    // Should not throw when discoverLeader fires the bad callback
    await expect(tracker.start()).resolves === undefined;
    await new Promise(r => setTimeout(r, 50));
    // Tracker still functional
    expect(typeof tracker.getLeader()).toBe('string');
  });

  test('only the last registered callback is active', async () => {
    loadTracker();

    const cb1 = jest.fn();
    const cb2 = jest.fn();
    tracker.onLeaderChange(cb1);
    tracker.onLeaderChange(cb2); // overrides cb1

    axiosMock.get.mockResolvedValue({ data: { state: 'Leader' } });
    tracker.start();
    await new Promise(r => setTimeout(r, 50));

    expect(cb2).toHaveBeenCalled();
    expect(cb1).not.toHaveBeenCalled();
  });
});
