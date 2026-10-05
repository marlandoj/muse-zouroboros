import { resolveHetznerExecutionRoute, type HetznerExecutionRoute } from "./hetzner-executor-policy";
import { shadowFactoryComputeDecision, type FactoryComputeRoutingRecord } from "./factory-compute-routing";

export type FactoryGateDecision = "DIRECT" | "SUGGEST" | "SWARM" | "FORCE_SWARM" | "ERROR";

export interface ExecutionLaneDecision {
  lane: "hetzner" | "pool" | "inline";
  hetzner_route: HetznerExecutionRoute;
  pool_route: boolean;
  inline_route?: {
    source: "ticket-contract";
    ticket_identifier: string;
    heading: "Execution Lane";
    value: "inline";
  };
  compute_shadow?: FactoryComputeRoutingRecord;
}

const TICKET_IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;
const INLINE_LANE_HEADING = "## Execution Lane";
const INLINE_LANE_LOOKALIKE = /^\s*##\s+execution\s+lane\s*$/i;
const FENCE = /^\s*(`{3,}|~{3,})/;

export function ticketInlineExecutionRoute(
  ticket: { identifier?: string; description?: string },
): ExecutionLaneDecision["inline_route"] | null {
  const ticketIdentifier = ticket.identifier;
  if (!ticketIdentifier || !TICKET_IDENTIFIER.test(ticketIdentifier)) return null;

  const lines = (ticket.description ?? "").replace(/\r\n?/g, "\n").split("\n");
  const sections: string[] = [];
  let ambiguous = false;
  let fence: { marker: "`" | "~"; length: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      const length = fenceMatch[1].length;
      if (!fence) {
        fence = { marker, length };
      } else if (fence.marker === marker && length >= fence.length && line.slice(fenceMatch[0].length).trim() === "") {
        fence = null;
      }
      continue;
    }
    if (INLINE_LANE_LOOKALIKE.test(line)) {
      if (fence || line !== INLINE_LANE_HEADING) {
        ambiguous = true;
        continue;
      }
    } else {
      continue;
    }
    const body: string[] = [];
    for (index += 1; index < lines.length && !/^##(?:\s|$)/.test(lines[index]); index++) {
      body.push(lines[index]);
    }
    sections.push(body.join("\n").trim());
    index -= 1;
  }

  if (ambiguous || sections.length !== 1 || sections[0] !== "inline") return null;
  return {
    source: "ticket-contract",
    ticket_identifier: ticketIdentifier,
    heading: "Execution Lane",
    value: "inline",
  };
}

export function executionLaneForTicket(
  ticket: { identifier?: string; title?: string; description?: string },
  decision: FactoryGateDecision,
  env: Record<string, string | undefined> = process.env,
): ExecutionLaneDecision {
  const hetznerRoute = resolveHetznerExecutionRoute(ticket, env);
  if (hetznerRoute.requested && decision !== "ERROR") {
    const lane = "hetzner" as const;
    const computeShadow = shadowFactoryComputeDecision(ticket, decision, lane, env);
    return { lane, hetzner_route: hetznerRoute, pool_route: false, ...(computeShadow ? { compute_shadow: computeShadow } : {}) };
  }
  const inlineRoute = decision === "ERROR" ? null : ticketInlineExecutionRoute(ticket);
  const poolRoute =
    env.SF003_POOL === "1"
    && !inlineRoute
    && (decision === "DIRECT" || decision === "SUGGEST" || decision === "SWARM" || decision === "FORCE_SWARM");
  const lane = poolRoute ? "pool" : "inline";
  const computeShadow = shadowFactoryComputeDecision(ticket, decision, lane, env);
  return {
    lane,
    hetzner_route: hetznerRoute,
    pool_route: poolRoute,
    ...(inlineRoute ? { inline_route: inlineRoute } : {}),
    ...(computeShadow ? { compute_shadow: computeShadow } : {}),
  };
}
