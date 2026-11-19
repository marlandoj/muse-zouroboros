import type {
  ChildTaskRecord,
  DelegationMode,
  HierarchicalDelegationConfig,
  Task,
} from "./types.js";

export interface HierarchicalDelegationDecision {
  allowed: boolean;
  blockedReason?: string;
  maxChildren: number;
  telemetryMode: "none" | "summary_only" | "child_records";
}

export interface HierarchicalDelegationProfile {
  supported: boolean;
  mode: "leaf" | "conditional" | "enabled";
  maxChildren: number;
  telemetryMode: "none" | "summary_only" | "child_records";
}

type HierarchicalConfigLike = {
  hierarchicalDelegation: HierarchicalDelegationConfig;
};

function normalizeDelegationPayload(payload: any): {
  childRecords: ChildTaskRecord[];
  artifacts: string[];
  delegated: boolean;
} {
  const delegation = payload?.delegation_report ?? payload ?? {};
  const rawChildren = Array.isArray(delegation?.children)
    ? delegation.children
    : Array.isArray(delegation?.child_tasks)
      ? delegation.child_tasks
      : [];

  const childRecords: ChildTaskRecord[] = rawChildren.map((child: any, index: number) => ({
    childId: String(child.childId || child.child_id || child.id || `child-${index + 1}`),
    parentTaskId: String(child.parentTaskId || child.parent_task_id || ""),
    executorId: String(child.executorId || child.executor_id || child.executor || "unknown"),
    delegatedModel: child.delegatedModel || child.delegated_model || child.model || undefined,
    writeScope: Array.isArray(child.writeScope)
      ? child.writeScope.map((v: unknown) => String(v))
      : Array.isArray(child.write_scope)
        ? child.write_scope.map((v: unknown) => String(v))
        : undefined,
    toolset: Array.isArray(child.toolset)
      ? child.toolset.map((v: unknown) => String(v))
      : Array.isArray(child.tool_set)
        ? child.tool_set.map((v: unknown) => String(v))
        : undefined,
    status: child.status === "failure" || child.status === "blocked" || child.status === "skipped"
      ? child.status
      : "success",
    durationMs: typeof child.durationMs === "number"
      ? child.durationMs
      : typeof child.duration_ms === "number"
        ? child.duration_ms
        : undefined,
    artifacts: Array.isArray(child.artifacts)
      ? child.artifacts.map((v: unknown) => String(v))
      : undefined,
    source: child.source === "executor_bridge" || child.source === "logger_synthesis"
      ? child.source
      : "parent_summary",
    summary: typeof child.summary === "string" ? child.summary : undefined,
  }));

  return {
    childRecords,
    artifacts: childRecords.flatMap(child => child.artifacts || []),
    delegated: Boolean(delegation?.used) || Boolean(delegation?.delegation_used) || childRecords.length > 0,
  };
}

export function taskNeedsWriteScopes(task: Pick<Task, "task" | "expectedMutations">): boolean {
  if ((task.expectedMutations?.length || 0) > 0) return true;
  const lower = task.task.toLowerCase();
  if (/\b(read-only|readonly|do not edit|don't edit|no file changes|without editing files)\b/.test(lower)) {
    return false;
  }
  return /\b(implement|edit|modify|change|rewrite|refactor|fix|patch|update)\b/.test(lower);
}

export function hasDisjointWriteScopes(task: Pick<Task, "delegation">): boolean {
  const scopes = task.delegation?.writeScopes || [];
  if (scopes.length === 0) return false;

  const seen = new Set<string>();
  for (const scope of scopes) {
    if (!scope.paths?.length) return false;
    for (const rawPath of scope.paths) {
      const normalized = rawPath.trim();
      if (!normalized) return false;
      if (seen.has(normalized)) return false;
      seen.add(normalized);
    }
  }
  return true;
}

export function getDelegationProfile(
  executorId: string,
  config: HierarchicalConfigLike,
): HierarchicalDelegationProfile {
  switch (executorId) {
    case "hermes":
      return {
        supported: config.hierarchicalDelegation.enabled,
        mode: "enabled",
        maxChildren: config.hierarchicalDelegation.hermesMaxChildren,
        telemetryMode: "child_records",
      };
    case "claude-code":
      return {
        supported: config.hierarchicalDelegation.enabled,
        mode: "conditional",
        maxChildren: config.hierarchicalDelegation.claudeCodeMaxChildren,
        telemetryMode: "summary_only",
      };
    default:
      return {
        supported: false,
        mode: "leaf",
        maxChildren: 0,
        telemetryMode: "none",
      };
  }
}

export function evaluateDelegation(
  task: Task,
  executorId: string,
  config: HierarchicalConfigLike,
): HierarchicalDelegationDecision {
  const profile = getDelegationProfile(executorId, config);
  const mode: DelegationMode = task.delegation?.mode || config.hierarchicalDelegation.defaultMode;

  if (!config.hierarchicalDelegation.enabled || config.hierarchicalDelegation.maxDepth < 1) {
    return { allowed: false, blockedReason: "hierarchical delegation disabled", maxChildren: 0, telemetryMode: "none" };
  }
  if (mode === "disabled") {
    return { allowed: false, blockedReason: "task delegation disabled", maxChildren: 0, telemetryMode: "none" };
  }
  if (!profile.supported || profile.mode === "leaf") {
    return { allowed: false, blockedReason: "executor is leaf-only", maxChildren: 0, telemetryMode: "none" };
  }
  if (taskNeedsWriteScopes(task) && !hasDisjointWriteScopes(task)) {
    return {
      allowed: false,
      blockedReason: "delegated mutation work requires disjoint write scopes",
      maxChildren: 0,
      telemetryMode: "none",
    };
  }

  return {
    allowed: true,
    maxChildren: Math.min(task.delegation?.maxChildren || profile.maxChildren, profile.maxChildren),
    telemetryMode: profile.telemetryMode,
  };
}

export function renderHierarchicalPolicyBlock(
  task: Task,
  executorId: string,
  delegation: HierarchicalDelegationDecision,
): string {
  if (delegation.allowed) {
    const declaredScopes = (task.delegation?.writeScopes || [])
      .map(scope => `- ${scope.childId}: ${scope.paths.join(", ")}`)
      .join("\n");
    const scopeBlock = declaredScopes
      ? `Declared child write scopes:\n${declaredScopes}\n`
      : "";

    return `<hierarchical-orchestration-policy>
You may decompose this task into at most ${delegation.maxChildren} child tasks if it improves throughput or quality.
Only do so within the centralized swarm guardrails below:
- You remain responsible for the outer task result.
- Child success does not complete the outer task.
- Child tasks must be independent and bounded.
- Do not exceed delegation depth 1 from this outer swarm task.
- If file mutations are involved, respect these disjoint write scopes exactly.
${scopeBlock}- Return a final machine-readable delegation report inside <delegation_report>...</delegation_report>.
- The report must be valid JSON with shape: {"used": boolean, "children": [{"childId": string, "parentTaskId": "${task.id}", "executorId": "${executorId}", "delegatedModel"?: string, "writeScope"?: string[], "toolset"?: string[], "status": "success|failure|blocked|skipped", "durationMs"?: number, "artifacts"?: string[], "summary"?: string }]}.
- Outside that tag, return your normal human-readable answer.
</hierarchical-orchestration-policy>

`;
  }

  if (delegation.blockedReason) {
    return `<hierarchical-orchestration-policy>
Do not delegate this task. Reason: ${delegation.blockedReason}.
Complete it as a leaf executor.
</hierarchical-orchestration-policy>

`;
  }

  return "";
}

export function stripDelegationReport(output: string): {
  cleanOutput: string;
  childRecords: ChildTaskRecord[];
  artifacts: string[];
  delegated: boolean;
} {
  const tagMatch = output.match(/<delegation_report>\s*([\s\S]*?)\s*<\/delegation_report>/i);
  if (tagMatch) {
    const cleanOutput = output.replace(tagMatch[0], "").trim();
    try {
      return { cleanOutput, ...normalizeDelegationPayload(JSON.parse(tagMatch[1])) };
    } catch {
      return { cleanOutput, childRecords: [], artifacts: [], delegated: false };
    }
  }

  const fencedBlocks = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const block of fencedBlocks) {
    const candidate = block[1]?.trim();
    if (!candidate || !candidate.includes("delegation_report")) continue;
    try {
      const parsed = JSON.parse(candidate);
      const cleanOutput = output.replace(block[0], "").trim();
      return { cleanOutput, ...normalizeDelegationPayload(parsed) };
    } catch {
      continue;
    }
  }

  return { cleanOutput: output.trim(), childRecords: [], artifacts: [], delegated: false };
}
