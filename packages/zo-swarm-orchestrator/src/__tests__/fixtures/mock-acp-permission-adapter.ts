/**
 * Mock ACP adapter that exercises the permission seam.
 *
 * On `session/prompt` it sends one or more `session/request_permission`
 * JSON-RPC requests back over the wire — the real adapter→client direction —
 * waits for each response, and reports what it received as agent text:
 * `PERMISSION:<outcome>[|<outcome>...]` where an outcome is
 * `selected:<optionId>` or `cancelled`. This lets tests prove, on the actual
 * ACP wire, that a dispatch traverses SwarmClient.requestPermission and that
 * the decision gate's verdict is what the adapter observes.
 *
 * Prompt keywords: 'destructive twice' → two identical delete-kind requests
 * (retry-after-denial probe); 'destructive' → one delete-kind request;
 * anything else → one read-kind request.
 */

let nextRequestId = 1000;
const pendingResponses = new Map<number, (result: unknown) => void>();

function send(message: unknown): void {
  console.log(JSON.stringify(message));
}

function requestPermission(tool: { title: string; kind: string; target?: string }): Promise<unknown> {
  const id = nextRequestId++;
  send({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId: 'mock-session',
      toolCall: {
        toolCallId: `tc-${id}`,
        title: tool.title,
        kind: tool.kind,
        status: 'pending',
        ...(tool.target ? { locations: [{ path: tool.target }] } : {}),
      },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    },
  });
  return new Promise(resolve => pendingResponses.set(id, resolve));
}

function label(result: unknown): string {
  const outcome = (result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
  if (!outcome) return 'missing';
  return outcome.outcome === 'selected' ? `selected:${outcome.optionId}` : String(outcome.outcome);
}

for await (const line of console) {
  const message = JSON.parse(line);

  // A message with an id and no method is a response to one of our requests.
  if (message.method === undefined && message.id !== undefined) {
    const resolve = pendingResponses.get(message.id);
    if (resolve) {
      pendingResponses.delete(message.id);
      resolve(message.result);
    }
    continue;
  }

  const reply = (result: unknown) => send({ jsonrpc: '2.0', id: message.id, result });

  switch (message.method) {
    case 'initialize':
      reply({ protocolVersion: 1, agentCapabilities: {} });
      break;
    case 'session/new':
      reply({ sessionId: 'mock-session' });
      break;
    case 'session/prompt':
      // Handled asynchronously: the permission round-trips need the main loop
      // free to route the client's responses back to requestPermission.
      void (async () => {
        const promptText: string = message.params.prompt?.[0]?.text ?? '';
        const outcomes: string[] = [];
        if (promptText.includes('destructive twice')) {
          outcomes.push(label(await requestPermission({ title: 'Delete', kind: 'delete', target: '/etc/passwd' })));
          outcomes.push(label(await requestPermission({ title: 'Delete', kind: 'delete', target: '/etc/passwd' })));
        } else if (promptText.includes('destructive')) {
          outcomes.push(label(await requestPermission({ title: 'Delete', kind: 'delete', target: '/etc/passwd' })));
        } else {
          outcomes.push(label(await requestPermission({ title: 'Read', kind: 'read', target: '/tmp/file.txt' })));
        }
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'mock-session',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `PERMISSION:${outcomes.join('|')}` },
            },
          },
        });
        reply({ stopReason: 'end_turn' });
      })();
      break;
    case 'session/cancel':
      break;
    default:
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not found' },
      });
  }
}
