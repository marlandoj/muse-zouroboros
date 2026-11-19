/** Acceptance rules shared by the runner and its regression tests. */
export function finishCase(
  receipt: any,
  worker: { code: number | null; timedOut: boolean }
) {
  const cleanExit = worker.code === 0 && !worker.timedOut;
  return {
    ...receipt,
    success: receipt?.success === true && cleanExit,
    workerCode: worker.code,
    timedOut: worker.timedOut,
    ...(cleanExit
      ? {}
      : {
          error: worker.timedOut
            ? "Worker exceeded its deadline (including cleanup)"
            : `Worker exited abnormally: ${worker.code}`,
        }),
  };
}

export function nativeChildCalls(events: any[]): string[] {
  const calls = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    let content: any;
    try {
      content = JSON.parse(event.content);
    } catch {
      continue;
    }
    // Require a structured native tool invocation, never the parent's prose.
    if (
      !/^(agent|task|delegate_task|subagent)(?::|$)/i.test(content.title ?? "")
    )
      continue;
    const id = content.toolCallId ?? event.metadata?.tool_call_id;
    if (typeof id === "string" && id) calls.add(id);
  }
  return [...calls];
}

export function nativeDelegationRequests(events: any[]): number {
  const ids = new Set(nativeChildCalls(events));
  let count = 0;
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    let content: any;
    try {
      content = JSON.parse(event.content);
    } catch {
      continue;
    }
    const id = content.toolCallId ?? event.metadata?.tool_call_id;
    if (!ids.delete(id)) continue;
    // Hermes emits one native call for a batch. The adapter's structured title
    // records its size. This is dispatch evidence, not proof of completion.
    const batch = /^delegate_task: (\d+) tasks:/i.exec(content.title ?? "");
    count += batch ? Number(batch[1]) : 1;
  }
  return count;
}

export function classifyFailure(message: string): string {
  if (
    /invalid.api.key|unauthorized|authentication|\b401\b|\b403\b/i.test(message)
  )
    return "authentication";
  if (/quota|rate.limit|insufficient.credit|\b429\b/i.test(message))
    return "quota";
  if (/model.*not.found|unknown.model|not.advertised|\b404\b/i.test(message))
    return "model-not-found";
  if (/newer version|unknown variant|unsupported|incompatible/i.test(message))
    return "incompatible-harness";
  if (/timed.out|timeout|deadline/i.test(message)) return "timeout";
  return "other";
}
