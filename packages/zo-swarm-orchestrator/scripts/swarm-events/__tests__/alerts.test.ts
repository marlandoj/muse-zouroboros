import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { existsSync, rmSync, readFileSync } from "fs";

// We test the module's rate limiting and file-based logging (not actual SMS)
// since we don't have ZO_CLIENT_IDENTITY_TOKEN in test env.

const STATE_FILE = "/tmp/swarm-alert-state.json";
const ALERT_LOG = "/tmp/swarm-alerts.log";

beforeEach(() => {
  rmSync(STATE_FILE, { force: true });
  rmSync(ALERT_LOG, { force: true });
  // Clear the module cache to reset state
  delete require.cache[require.resolve("../alerts")];
});

afterEach(() => {
  rmSync(STATE_FILE, { force: true });
  rmSync(ALERT_LOG, { force: true });
});

describe("sendAlert", () => {
  test("logs to file when no token available", async () => {
    const { sendAlert } = await import("../alerts");
    // Ensure no token
    const origToken = process.env.ZO_CLIENT_IDENTITY_TOKEN;
    delete process.env.ZO_CLIENT_IDENTITY_TOKEN;

    const result = await sendAlert("swarm_failure", "Test swarm failure");

    expect(result.sent).toBe(false);
    expect(result.reason).toContain("logged to /tmp/swarm-alerts.log");
    expect(existsSync(ALERT_LOG)).toBe(true);

    const log = readFileSync(ALERT_LOG, "utf-8");
    expect(log).toContain("swarm_failure");
    expect(log).toContain("Test swarm failure");

    if (origToken) process.env.ZO_CLIENT_IDENTITY_TOKEN = origToken;
  });

  test("rate limits same event type", async () => {
    const { sendAlert } = await import("../alerts");
    delete process.env.ZO_CLIENT_IDENTITY_TOKEN;

    const r1 = await sendAlert("swarm_failure", "First");
    expect(r1.sent).toBe(false); // No token, but it records the send attempt

    // Manually write state to simulate a sent alert
    const stateData = {
      swarm_failure: {
        type: "swarm_failure",
        lastSent: Date.now(),
        count: 1,
      },
    };
    Bun.write(STATE_FILE, JSON.stringify(stateData));

    const r2 = await sendAlert("swarm_failure", "Second");
    expect(r2.sent).toBe(false);
    expect(r2.reason).toContain("Rate limited");
  });

  test("different event types not rate limited together", async () => {
    const { sendAlert } = await import("../alerts");
    delete process.env.ZO_CLIENT_IDENTITY_TOKEN;

    const stateData = {
      swarm_failure: {
        type: "swarm_failure",
        lastSent: Date.now(),
        count: 1,
      },
    };
    Bun.write(STATE_FILE, JSON.stringify(stateData));

    // swarm_failure should be rate limited
    const r1 = await sendAlert("swarm_failure", "Blocked");
    expect(r1.reason).toContain("Rate limited");

    // autoloop_regression should NOT be rate limited
    const r2 = await sendAlert("autoloop_regression", "Not blocked");
    expect(r2.reason).not.toContain("Rate limited");
  });

  test("force bypasses rate limit", async () => {
    const { sendAlert } = await import("../alerts");
    delete process.env.ZO_CLIENT_IDENTITY_TOKEN;

    const stateData = {
      swarm_failure: {
        type: "swarm_failure",
        lastSent: Date.now(),
        count: 1,
      },
    };
    Bun.write(STATE_FILE, JSON.stringify(stateData));

    const result = await sendAlert("swarm_failure", "Forced", { force: true });
    // Won't be "Rate limited" — will attempt to send (fails due to no token, but that's expected)
    expect(result.reason).not.toContain("Rate limited");
  });
});

describe("helper functions", () => {
  test("sendSwarmFailureAlert formats correctly", async () => {
    const { sendSwarmFailureAlert } = await import("../alerts");
    delete process.env.ZO_CLIENT_IDENTITY_TOKEN;

    const result = await sendSwarmFailureAlert("swarm_123", "wave2-build", "timeout after 600s");
    expect(result.sent).toBe(false); // No token
    expect(existsSync(ALERT_LOG)).toBe(true);

    const log = readFileSync(ALERT_LOG, "utf-8");
    expect(log).toContain("swarm_123");
    expect(log).toContain("wave2-build");
  });

  test("sendAutoloopRegressionAlert calculates drop percentage", async () => {
    const { sendAutoloopRegressionAlert } = await import("../alerts");
    delete process.env.ZO_CLIENT_IDENTITY_TOKEN;

    const result = await sendAutoloopRegressionAlert("trading-backtest", 4.13, 3.50);
    expect(result.sent).toBe(false);

    const log = readFileSync(ALERT_LOG, "utf-8");
    expect(log).toContain("15.3%"); // (4.13 - 3.50) / 4.13 * 100
    expect(log).toContain("trading-backtest");
  });

  test("sendServiceCriticalAlert includes crash count", async () => {
    const { sendServiceCriticalAlert } = await import("../alerts");
    delete process.env.ZO_CLIENT_IDENTITY_TOKEN;

    const result = await sendServiceCriticalAlert("trading-bot", 5);
    expect(result.sent).toBe(false);

    const log = readFileSync(ALERT_LOG, "utf-8");
    expect(log).toContain("trading-bot");
    expect(log).toContain("5x");
  });
});
