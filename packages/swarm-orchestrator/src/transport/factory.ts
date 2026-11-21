/**
 * Transport factory — resolves the correct ExecutorTransport for a registry entry.
 *
 * Reads the optional `transport` field from the executor registry entry.
 * Defaults to 'bridge' for backward compatibility.
 */

import type { ExecutorRegistryEntry } from '../types.js';
import { CircuitBreaker } from '../circuit/breaker.js';
import { BridgeTransport } from './bridge-transport.js';
import { ACPTransport } from './acp-transport.js';
import type { ExecutorTransport, TransportType } from './types.js';

export function resolveTransportType(entry: ExecutorRegistryEntry): TransportType {
  const fallback = entry.transportFallback;
  if (fallback && process.env[fallback.envVar] === fallback.equals) {
    return fallback.transport;
  }
  return entry.transport ?? 'bridge';
}
export function createTransport(
  entry: ExecutorRegistryEntry,
  circuitBreaker: CircuitBreaker,
): ExecutorTransport {
  const transport = resolveTransportType(entry);

  switch (transport) {
    case 'bridge':
      return new BridgeTransport(entry, circuitBreaker);
    case 'acp': {
      const spec = entry.acp;
      if (!spec) {
        throw new Error(
          `Executor '${entry.id}' uses ACP transport but has no registry acp configuration.`,
        );
      }
      return new ACPTransport(entry, circuitBreaker, {
        adapterBin: spec.adapterBin,
        adapterArgs: spec.adapterArgs,
        extraEnv: spec.extraEnv,
        allowedTools: spec.allowedTools,
        mcpConfig: spec.mcpConfig,
      });
    }
    default:
      throw new Error(`Unknown transport type '${transport}' for executor '${entry.id}'`);
  }
}
