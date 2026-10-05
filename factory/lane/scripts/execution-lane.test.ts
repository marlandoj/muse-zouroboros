import { describe, expect, test } from "bun:test";
import { executionLaneForTicket } from "./execution-lane";

const ENV = { SF003_POOL: "1", SF_HETZNER_EXECUTOR: "1" };

describe("factory execution lane", () => {
  test("binding Hetzner intent wins before SF-003 pool fan-out", () => {
    const lane = executionLaneForTicket(
      { title: "Build", description: "Hetzner is to be used for the complete execution." },
      "SWARM",
      ENV,
    );
    expect(lane.lane).toBe("hetzner");
    expect(lane.pool_route).toBe(false);
    expect(lane.hetzner_route.binding).toBe(true);
  });

  test("ordinary work keeps the enabled pool lane", () => {
    const lane = executionLaneForTicket(
      { title: "Build", description: "Implement the requested change." },
      "SWARM",
      ENV,
    );
    expect(lane.lane).toBe("pool");
    expect(lane.pool_route).toBe(true);
    expect(lane.inline_route).toBeUndefined();
  });

  test("an exact ticket-bound contract selects inline without changing the global pool flag", () => {
    const lane = executionLaneForTicket(
      {
        identifier: "ZOU-1550",
        title: "Recover held execution",
        description: "## Execution Lane\n\ninline\n\n## Target Repo\n\n/home/workspace/zouroboros",
      },
      "DIRECT",
      ENV,
    );
    expect(lane.lane).toBe("inline");
    expect(lane.pool_route).toBe(false);
    expect(lane.inline_route).toEqual({
      source: "ticket-contract",
      ticket_identifier: "ZOU-1550",
      heading: "Execution Lane",
      value: "inline",
    });
    expect(ENV.SF003_POOL).toBe("1");
  });

  test("prose, malformed sections, duplicate sections, and unbound requests stay on the pool", () => {
    const descriptions = [
      "Please use the inline execution lane.",
      "### Execution Lane\n\ninline",
      "## execution lane\n\ninline",
      "##  Execution Lane\n\ninline",
      "## Execution Lane \n\ninline",
      "## Execution Lane\n\npool",
      "## Execution Lane\n\ninline with recovery",
      "## Execution Lane\n\ninline\n\n## Execution Lane\n\ninline",
      "## Execution Lane\n\ninline\n\n## execution lane\n\ninline",
      "## Execution Lane\n\ninline\n\n##  Execution Lane\n\ninline",
      "```md\n## Execution Lane\n\ninline\n```",
      "~~~markdown\n## Execution Lane\n\ninline\n~~~",
    ];
    for (const description of descriptions) {
      const lane = executionLaneForTicket(
        { identifier: "ZOU-1550", title: "Recover held execution", description },
        "DIRECT",
        ENV,
      );
      expect(lane.lane).toBe("pool");
      expect(lane.pool_route).toBe(true);
      expect(lane.inline_route).toBeUndefined();
    }

    const unbound = executionLaneForTicket(
      { title: "Recover held execution", description: "## Execution Lane\n\ninline" },
      "DIRECT",
      ENV,
    );
    expect(unbound.lane).toBe("pool");
    expect(unbound.inline_route).toBeUndefined();

    for (const identifier of ["zou-1550", "ZOU-", "ZOU-1550 extra", " ZOU-1550 "]) {
      const invalid = executionLaneForTicket(
        { identifier, title: "Recover held execution", description: "## Execution Lane\n\ninline" },
        "DIRECT",
        ENV,
      );
      expect(invalid.lane).toBe("pool");
      expect(invalid.inline_route).toBeUndefined();
    }
  });

  test("binding Hetzner intent retains precedence over the inline ticket contract", () => {
    const lane = executionLaneForTicket(
      {
        identifier: "ZOU-1550",
        title: "Recover held execution",
        description: "Hetzner is to be used for the complete execution.\n\n## Execution Lane\n\ninline",
      },
      "DIRECT",
      ENV,
    );
    expect(lane.lane).toBe("hetzner");
    expect(lane.pool_route).toBe(false);
    expect(lane.inline_route).toBeUndefined();
  });

  test("ERROR behavior remains unchanged even when a ticket carries the inline contract", () => {
    const lane = executionLaneForTicket(
      {
        identifier: "ZOU-1550",
        title: "Recover held execution",
        description: "## Execution Lane\n\ninline",
      },
      "ERROR",
      ENV,
    );
    expect(lane.lane).toBe("inline");
    expect(lane.pool_route).toBe(false);
    expect(lane.inline_route).toBeUndefined();
  });

  test("negated Hetzner language does not override the pool", () => {
    const lane = executionLaneForTicket(
      { title: "Build", description: "Do not use Hetzner for this build." },
      "DIRECT",
      ENV,
    );
    expect(lane.lane).toBe("pool");
    expect(lane.hetzner_route.requested).toBe(false);
  });

  test("compute routing is absent by default and cannot change the incumbent lane", () => {
    const lane = executionLaneForTicket(
      { title: "Verify public fixture", description: "Run 10 deterministic test shards." },
      "DIRECT",
      ENV,
    );
    expect(lane.lane).toBe("pool");
    expect(lane.compute_shadow).toBeUndefined();
  });

  test("shadow routing records a Modal proposal without dispatch or lane mutation", () => {
    const lane = executionLaneForTicket(
      { title: "Verify public fixture", description: "Run deterministic public fixture test shards." },
      "DIRECT",
      {
        ...ENV,
        FACTORY_COMPUTE_ROUTER: "shadow",
        FACTORY_COMPUTE_ENVIRONMENT: "test",
        FACTORY_COMPUTE_ENVIRONMENT_ENABLED: "1",
        FACTORY_COMPUTE_MODAL: "1",
        FACTORY_COMPUTE_WORKLOADS: "deterministic-verification",
        FACTORY_COMPUTE_MODAL_MAX_USD: "1",
        FACTORY_COMPUTE_ESTIMATE_USD: "0.1",
        FACTORY_COMPUTE_APPROVAL_ID: "shadow-qualification",
      },
    );
    expect(lane.lane).toBe("pool");
    expect(lane.compute_shadow).toMatchObject({
      incumbent_lane: "pool",
      no_dispatch: true,
      proposed: { action: "shadow", provider: "modal" },
    });
  });

  test("canonical mutation language is held while incumbent execution stays unchanged", () => {
    const lane = executionLaneForTicket(
      { title: "Update Linear", description: "Commit and merge a GitHub change." },
      "DIRECT",
      {
        ...ENV,
        FACTORY_COMPUTE_ROUTER: "shadow",
        FACTORY_COMPUTE_ENVIRONMENT_ENABLED: "1",
        FACTORY_COMPUTE_LOCAL: "1",
        FACTORY_COMPUTE_WORKLOADS: "agent-session",
        FACTORY_COMPUTE_APPROVAL_ID: "shadow-qualification",
        FACTORY_COMPUTE_ESTIMATE_USD: "0",
      },
    );
    expect(lane.lane).toBe("pool");
    expect(lane.compute_shadow?.proposed).toMatchObject({ action: "hold", holdReason: "unauthorized_mutation" });
  });
});
