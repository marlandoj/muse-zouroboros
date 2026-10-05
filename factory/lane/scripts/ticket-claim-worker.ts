import { appendFileSync } from "node:fs";
import { acquireTicketClaim } from "./ticket-claim";

const [stateDir, ticketId, executionId, dispatchPath, prPath] = Bun.argv.slice(2);
if (!stateDir || !ticketId || !executionId || !dispatchPath || !prPath) process.exit(2);

const result = acquireTicketClaim({ ticket_id: ticketId, execution_id: executionId }, { stateDir });
if (result.status !== "acquired") process.exit(0);
appendFileSync(dispatchPath, `${executionId}\n`);
await Bun.sleep(50);
appendFileSync(prPath, `${executionId}\n`);
