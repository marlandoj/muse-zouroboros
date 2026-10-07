export interface AvailabilityVerdict {
  model: string;
  confidence: number;
  issues: string[];
}

export function isUnavailableVerdict(verdict: AvailabilityVerdict): boolean {
  if (verdict.confidence !== 0) return false;
  return verdict.issues.some((issue) =>
    issue === "Empty response from vendor"
    || issue.startsWith("API error:")
    || issue.startsWith("Call failed:")
    || issue.startsWith("Unparseable verdict"),
  );
}

export function selectConsensusVoters<T extends AvailabilityVerdict>(
  llmVerdicts: T[],
  arbiter: T,
  minimumResponsiveLlm: number,
): {
  quorumOk: boolean;
  voters: T[];
  responsive: T[];
  unavailable: T[];
} {
  const responsive = llmVerdicts.filter((verdict) => !isUnavailableVerdict(verdict));
  const unavailable = llmVerdicts.filter(isUnavailableVerdict);
  return {
    quorumOk: responsive.length >= minimumResponsiveLlm,
    voters: [...responsive, arbiter],
    responsive,
    unavailable,
  };
}
