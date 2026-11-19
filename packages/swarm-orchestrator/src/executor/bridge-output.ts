/** Reject transport error text before either structured or plain output is scored. */
export function bridgeOutputFailure(output: string, stderr: string): string | null {
  if (/BRIDGE_ERROR/.test(stderr)) return stderr.trim().slice(0, 500);
  const text = output.trim();
  if (!text) return 'empty bridge output';
  if (/^HTTP(?:\/\d(?:\.\d)?)?\s+[45]\d\d\b/i.test(text)) return 'HTTP error response';
  return null;
}
