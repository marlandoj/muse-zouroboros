/** Run a campaign with a bounded lifetime and drain both output streams. */
export async function runMcpCampaign(
  command: string[], timeout: number, env: Record<string, string | undefined> = process.env,
): Promise<{ stdout: string }> {
  const proc = Bun.spawn(command, { env, timeout, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `Campaign exited with code ${exitCode}`);
  return { stdout };
}
