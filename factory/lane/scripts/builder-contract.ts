const BUILD_ARCHETYPES = new Set([
  "build",
  "bugfix",
  "feature",
  "fix",
  "implementation",
  "refactor",
]);

export function isBuildArchetype(archetype: string | undefined): boolean {
  return BUILD_ARCHETYPES.has(archetype?.trim().toLowerCase() ?? "");
}

export function builderCheckpointContract(): string[] {
  return [
    "- Use harness-tracked background execution for implementation; do not hand work to a raw /zo/ask session.",
    "- Commit each completed sub-scope before starting the next sub-scope.",
    "- Never leave completed work only as untracked files; checkpoint tracked work before any branch or worktree switch.",
  ];
}

export function mayUseZoAskFallback(
  archetype: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(archetype?.trim())
    && env.SF_EXEC_ZO_ASK_FALLBACK === "1"
    && !isBuildArchetype(archetype);
}
