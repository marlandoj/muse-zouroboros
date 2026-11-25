# Connect your AI client to the Zouroboros workshop (Community Edition)

The workshop is two MCP servers that run on the machine where you installed it:

| Server | What it gives your client | Tools |
|---|---|---|
| `zouroboros-memory` | shared memory across every client you connect | `memory_search`, `memory_store`, `memory_episodes`, `memory_procedures`, `cognitive_profile`, `memory_session_observations` |
| `zouroboros-swarm` | dispatch to the local coding agents (the swarm) | `swarm_execute`, `swarm_status`, `swarm_results`, `swarm_benchmark`, `swarm_list` |

Connect **both** in every client. Each client also needs the **concierge
playbook** (`docs/concierge.md`), loaded the way that client loads
instructions. The playbook is what lets the assistant read the installer's
handoff block and walk you through setup.

There are two kinds of client:

- **Local clients** (terminal agents, desktop apps, editors) start the servers
  themselves over stdio. Nothing listens on the network. Sections 1-10.
- **Web clients** (ChatGPT, Claude.ai, Muse) run in the vendor's cloud and can
  only reach a public HTTPS URL. They use the opt-in **remote mode**. Section 11.

> **Status of this guide.** Everything marked **Tested** was run end to end on
> 2026-11-25 against a clean install. That means the client's own config,
> the client's own MCP connection, tools listed, and a `memory_store` →
> `memory_search` round trip made by the client. The client versions are
> listed in each section. Anything marked **UNTESTED** comes from vendor
> documentation only, and the reason is given.

## 0. Before you start

1. Install the workshop. The installer puts it at `~/workspace/muse-zouroboros`:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/marlandoj/muse-zouroboros/main/scripts/quickstart.sh | bash
   ```
2. Create the memory database (walkthrough step 03):
   ```bash
   cd ~/workspace/muse-zouroboros/packages/memory-system && bash scripts/install.sh
   ```
3. Print the config for your client. It comes out with **your** absolute paths filled in:
   ```bash
   cd ~/workspace/muse-zouroboros
   bash scripts/connect-config.sh --list
   bash scripts/connect-config.sh <client>
   ```
   Use the printed block, not a hand-edited copy. Most clients do not expand
   `~` or `$HOME` inside MCP config. GUI apps (Claude Desktop, Cursor, VS Code)
   also don't see `~/.bun/bin` on their `PATH`, so the block names `bun` by its
   absolute path.

The examples below show what the script prints for a user whose home is
`/home/you`. Your paths will differ.

**The shared JSON block (A).** Gemini CLI, Kimi Code, Claude Desktop and
Cursor all read this exact shape:

```json
{
  "mcpServers": {
    "zouroboros-memory": {
      "command": "/home/you/.bun/bin/bun",
      "args": ["/home/you/workspace/muse-zouroboros/packages/memory-system/scripts/mcp-server.ts"],
      "env": { "ZOUROBOROS_MEMORY_DB": "/home/you/.zo/memory/shared-facts.db" }
    },
    "zouroboros-swarm": {
      "command": "/home/you/.bun/bin/bun",
      "args": ["/home/you/workspace/muse-zouroboros/packages/swarm-orchestrator/scripts/mcp-server.ts"],
      "env": {
        "ZOUROBOROS_MEMORY_DB": "/home/you/.zo/memory/shared-facts.db",
        "SWARM_EXECUTOR_REGISTRY": "/home/you/workspace/muse-zouroboros/packages/swarm-executors/registry/executor-registry.json",
        "SWARM_WORKSPACE": "/home/you/workspace/muse-zouroboros"
      }
    }
  }
}
```

**First check for every client:** ask it to *"store a fact in Zouroboros
memory with your own actor, persona shared, then search for it"*. You should
see `Stored fact …`, then `Found 1 results …` with your fact. Then ask a
second client to search for the same words. Recall across clients is the
point of the shared memory.

---

## 1. Codex CLI — **Tested** (codex-cli 0.172.0)

**Config:** append to `~/.codex/config.toml`:

```toml
[mcp_servers.zouroboros-memory]
command = "/home/you/.bun/bin/bun"
args = ["/home/you/workspace/muse-zouroboros/packages/memory-system/scripts/mcp-server.ts"]

[mcp_servers.zouroboros-memory.env]
ZOUROBOROS_MEMORY_DB = "/home/you/.zo/memory/shared-facts.db"

[mcp_servers.zouroboros-swarm]
command = "/home/you/.bun/bin/bun"
args = ["/home/you/workspace/muse-zouroboros/packages/swarm-orchestrator/scripts/mcp-server.ts"]

[mcp_servers.zouroboros-swarm.env]
ZOUROBOROS_MEMORY_DB = "/home/you/.zo/memory/shared-facts.db"
SWARM_EXECUTOR_REGISTRY = "/home/you/workspace/muse-zouroboros/packages/swarm-executors/registry/executor-registry.json"
SWARM_WORKSPACE = "/home/you/workspace/muse-zouroboros"
```

**Playbook:** Codex reads `~/.codex/AGENTS.md`. It has no import syntax, so link or copy the file:
`ln -s ~/workspace/muse-zouroboros/docs/concierge.md ~/.codex/AGENTS.md`. If you already have an
AGENTS.md, append to it instead: `cat …/docs/concierge.md >> ~/.codex/AGENTS.md`.

**First check:** `codex mcp list` shows both servers `enabled`. Then run the memory round trip above.

**Good to know:** Codex asks before each MCP tool call in an interactive
session. Under `codex exec` with `approval_policy = "never"` it refuses MCP
calls unless the server is pre-approved. To pre-approve a server, add
`default_tools_approval_mode = "approve"` under `[mcp_servers.zouroboros-memory]`.
Do this only for servers you trust. Leave the swarm server on prompts.

## 2. Claude Code — **Tested** (2.1.306)

**Config:** run the two commands `connect-config.sh claude-code` prints. They write user scope into `~/.claude.json`:

```bash
claude mcp add-json --scope user zouroboros-memory '{"command":"/home/you/.bun/bin/bun","args":["/home/you/workspace/muse-zouroboros/packages/memory-system/scripts/mcp-server.ts"],"env":{"ZOUROBOROS_MEMORY_DB":"/home/you/.zo/memory/shared-facts.db"}}'
claude mcp add-json --scope user zouroboros-swarm '{"command":"/home/you/.bun/bin/bun","args":["/home/you/workspace/muse-zouroboros/packages/swarm-orchestrator/scripts/mcp-server.ts"],"env":{"ZOUROBOROS_MEMORY_DB":"/home/you/.zo/memory/shared-facts.db","SWARM_EXECUTOR_REGISTRY":"/home/you/workspace/muse-zouroboros/packages/swarm-executors/registry/executor-registry.json","SWARM_WORKSPACE":"/home/you/workspace/muse-zouroboros"}}'
```

**Playbook:** add this one import line to `~/.claude/CLAUDE.md`:
`@/home/you/workspace/muse-zouroboros/docs/concierge.md`. Claude Code follows
imports with absolute paths. This was tested: the playbook text reached the model.

**First check:** `claude mcp list` shows both servers `✔ Connected`. Then run the memory round trip.

## 3. Gemini CLI — **Tested** (0.71.1)

**Config:** merge block A into `~/.gemini/settings.json`.

**Playbook:** link the file as `~/.gemini/GEMINI.md`:
`ln -s ~/workspace/muse-zouroboros/docs/concierge.md ~/.gemini/GEMINI.md`. If you
already have a GEMINI.md, append to it instead. **Do not use an `@import` line**:
Gemini refuses imports from outside `~/.gemini` ("Import failed … Path traversal
attempt"). This was observed in testing.

**Folder trust:** Gemini disables **every** MCP server, user-level ones
included, in a folder you have not trusted. `gemini mcp list` then shows both
servers `Disabled`. Answer "trust" at Gemini's folder-trust prompt for the
directory you work in. This was observed in testing.

**First check:** `gemini mcp list` shows both servers `✓ Connected`. Then run the memory round trip.

## 4. OpenCode — **Tested** (1.19.6)

**Config:** merge into `~/.config/opencode/opencode.json`. OpenCode's own shape: `mcp`, `type: "local"`, the command as an array, `environment`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "zouroboros-memory": {
      "type": "local",
      "command": ["/home/you/.bun/bin/bun", "/home/you/workspace/muse-zouroboros/packages/memory-system/scripts/mcp-server.ts"],
      "environment": { "ZOUROBOROS_MEMORY_DB": "/home/you/.zo/memory/shared-facts.db" },
      "enabled": true
    },
    "zouroboros-swarm": {
      "type": "local",
      "command": ["/home/you/.bun/bin/bun", "/home/you/workspace/muse-zouroboros/packages/swarm-orchestrator/scripts/mcp-server.ts"],
      "environment": {
        "ZOUROBOROS_MEMORY_DB": "/home/you/.zo/memory/shared-facts.db",
        "SWARM_EXECUTOR_REGISTRY": "/home/you/workspace/muse-zouroboros/packages/swarm-executors/registry/executor-registry.json",
        "SWARM_WORKSPACE": "/home/you/workspace/muse-zouroboros"
      },
      "enabled": true
    }
  },
  "instructions": ["/home/you/workspace/muse-zouroboros/docs/concierge.md"]
}
```

**Playbook:** the `instructions` entry above loads it in every session. This was tested.

**First check:** `opencode mcp list` shows both servers `✓ … connected`. Then run the memory round trip.

## 5. Hermes Agent — **Tested** (v0.22.2)

**Config:** merge into `~/.hermes/config.yaml`. If you use a profile, use `<profile dir>/config.yaml`:

```yaml
mcp_servers:
  zouroboros-memory:
    command: "/home/you/.bun/bin/bun"
    args: ["/home/you/workspace/muse-zouroboros/packages/memory-system/scripts/mcp-server.ts"]
    env:
      ZOUROBOROS_MEMORY_DB: "/home/you/.zo/memory/shared-facts.db"
  zouroboros-swarm:
    command: "/home/you/.bun/bin/bun"
    args: ["/home/you/workspace/muse-zouroboros/packages/swarm-orchestrator/scripts/mcp-server.ts"]
    env:
      ZOUROBOROS_MEMORY_DB: "/home/you/.zo/memory/shared-facts.db"
      SWARM_EXECUTOR_REGISTRY: "/home/you/workspace/muse-zouroboros/packages/swarm-executors/registry/executor-registry.json"
      SWARM_WORKSPACE: "/home/you/workspace/muse-zouroboros"
```

**Playbook:** Hermes reads `AGENTS.md` only from the directory it starts in.
For the playbook to apply in every directory, install it as a skill. The
commands `connect-config.sh hermes` prints are:

```bash
mkdir -p ~/.hermes/skills/zouroboros-concierge
{ printf -- '---\nname: zouroboros-concierge\ndescription: Use when the user asks to set up, install, verify or operate the Zouroboros workshop. Onboarding playbook.\n---\n\n'; cat ~/workspace/muse-zouroboros/docs/concierge.md; } > ~/.hermes/skills/zouroboros-concierge/SKILL.md
```

The skill shows up in Hermes's skill index. The model loads it when you ask
about Zouroboros. This was tested: the model loaded it before calling the memory tools.

**First check:** `hermes mcp test zouroboros-memory` reports `✓ Connected` and
`Tools discovered: 6`. For the swarm server it reports 5. Then run the memory round trip.

## 6. Kimi Code CLI — **Tested** (kimi-code 2.4.1)

The format comes from the tool itself, because the audit had not established
it. Kimi Code 2.4.1 keeps MCP servers in `~/.kimi-code/mcp.json`, or
`$KIMI_CODE_HOME/mcp.json` if you set that variable.

**Config:** block A, verbatim, as `~/.kimi-code/mcp.json`. If the file already has `mcpServers`, merge into it.

**Playbook:** Kimi Code reads `~/.kimi-code/AGENTS.md`, with no import syntax:
`ln -s ~/workspace/muse-zouroboros/docs/concierge.md ~/.kimi-code/AGENTS.md`. If you
already have one, append to it. This was tested: the playbook text reached the model.

**First check:** run the memory round trip in a session (`kimi`, or
`kimi -p "…"`). The 2.4.1 CLI has no `mcp list` subcommand. Its interactive
`/mcp` command was **UNTESTED** here because it needs an interactive terminal.

## 7. Pi — **Tested** (pi 1.6.0)

The format comes from the tool itself (`pi mcp add` writes it).

**Config:** merge into `~/.pi/agent/mcp.json`. This is block A plus `"exposure": "direct"` on each server:

```json
{
  "mcpServers": {
    "zouroboros-memory": {
      "command": "/home/you/.bun/bin/bun",
      "args": ["/home/you/workspace/muse-zouroboros/packages/memory-system/scripts/mcp-server.ts"],
      "env": { "ZOUROBOROS_MEMORY_DB": "/home/you/.zo/memory/shared-facts.db" },
      "exposure": "direct"
    },
    "zouroboros-swarm": {
      "command": "/home/you/.bun/bin/bun",
      "args": ["/home/you/workspace/muse-zouroboros/packages/swarm-orchestrator/scripts/mcp-server.ts"],
      "env": {
        "ZOUROBOROS_MEMORY_DB": "/home/you/.zo/memory/shared-facts.db",
        "SWARM_EXECUTOR_REGISTRY": "/home/you/workspace/muse-zouroboros/packages/swarm-executors/registry/executor-registry.json",
        "SWARM_WORKSPACE": "/home/you/workspace/muse-zouroboros"
      },
      "exposure": "direct"
    }
  }
}
```

`"exposure": "direct"` gives the model the tools by name. Pi's default,
`codemode`, wraps them behind its code tool. Only direct exposure was tested.

**Playbook:** `ln -s ~/workspace/muse-zouroboros/docs/concierge.md ~/.pi/agent/AGENTS.md`.
If you already have one, append to it.

**First check:** `pi mcp list` shows `zouroboros-memory: connected, 6 tools` and
`zouroboros-swarm: connected, 5 tools`. Then run the memory round trip.

## 8. Claude Desktop — config **tested by a scripted client**, app **UNTESTED**

There is no Claude Desktop app on the test host. What was tested: a scripted
MCP client read the same file you would write and started both servers from
it. It listed all 11 tools and did the memory round trip. That this exact
file shows up correctly inside the app is **UNTESTED**.

**Config:** merge block A into `claude_desktop_config.json`. On macOS that is
`~/Library/Application Support/Claude/claude_desktop_config.json`. On Windows
it is `%APPDATA%\Claude\claude_desktop_config.json`. Then fully quit and reopen Claude Desktop.

**Playbook:** Claude Desktop has no instructions file. Paste the contents of
`docs/concierge.md` into a Project's instructions, and use that Project for workshop chats.

**First check:** the connectors / tools menu lists both servers. Then run the memory round trip.

## 9. Cursor — config **tested by a scripted client**, app **UNTESTED**

As with Claude Desktop, only a scripted MCP client read this file. The app itself was not run.

**Config:** block A as `~/.cursor/mcp.json` (all projects) or `<project>/.cursor/mcp.json`.

**Playbook:** a project rule that always applies:

```bash
mkdir -p <project>/.cursor/rules
{ printf -- '---\ndescription: Zouroboros concierge playbook\nalwaysApply: true\n---\n\n'; cat ~/workspace/muse-zouroboros/docs/concierge.md; } > <project>/.cursor/rules/zouroboros-concierge.mdc
```

**First check:** Cursor Settings → MCP shows both servers with their tools. Then run the memory round trip in Agent mode.

## 10. VS Code (Copilot agent mode) — config **tested by a scripted client**, app **UNTESTED**

As with Claude Desktop, only a scripted MCP client read this file. The app itself was not run.

**Config:** VS Code uses `servers` (not `mcpServers`) and `type: "stdio"`. Open
it with **MCP: Open User Configuration**, or use `<project>/.vscode/mcp.json`:

```json
{
  "servers": {
    "zouroboros-memory": {
      "type": "stdio",
      "command": "/home/you/.bun/bin/bun",
      "args": ["/home/you/workspace/muse-zouroboros/packages/memory-system/scripts/mcp-server.ts"],
      "env": { "ZOUROBOROS_MEMORY_DB": "/home/you/.zo/memory/shared-facts.db" }
    },
    "zouroboros-swarm": {
      "type": "stdio",
      "command": "/home/you/.bun/bin/bun",
      "args": ["/home/you/workspace/muse-zouroboros/packages/swarm-orchestrator/scripts/mcp-server.ts"],
      "env": {
        "ZOUROBOROS_MEMORY_DB": "/home/you/.zo/memory/shared-facts.db",
        "SWARM_EXECUTOR_REGISTRY": "/home/you/workspace/muse-zouroboros/packages/swarm-executors/registry/executor-registry.json",
        "SWARM_WORKSPACE": "/home/you/workspace/muse-zouroboros"
      }
    }
  }
}
```

**Playbook:** `cp ~/workspace/muse-zouroboros/docs/concierge.md <project>/.github/copilot-instructions.md`.

**First check:** **MCP: List Servers** shows both servers running. Then run the memory round trip in agent mode.

---

## 11. Web clients: ChatGPT, Claude.ai, Muse — remote mode

Web clients cannot start a local command. The workshop's remote mode
(`packages/workshop-remote`) gives them a single HTTPS MCP endpoint. It is
protected by OAuth 2.1 with PKCE, discovery metadata and dynamic client
registration, the flow these clients run when you add a connector. It serves
the same tools as the local servers, because it runs them.

**Protocol status:** **Tested** with a scripted client, over a public HTTPS
URL, doing the same steps the web clients do: discovery, registration, PKCE
authorization, token, `tools/list`, a real `memory_store` / `memory_search`,
and refresh. **Inside the vendor apps: UNTESTED.** Registering the connector
in ChatGPT, Claude.ai or Muse needs a personal vendor account, and none was
used. The steps below are what that test will be.

### Turn it on (off by default)

```bash
cd ~/workspace/muse-zouroboros && bun install
bash packages/workshop-remote/scripts/remote-init.sh     # creates ~/.config/zouroboros/remote-operator.secret (mode 600)
cat ~/.config/zouroboros/remote-operator.secret          # put it in your password manager
```

Expose `127.0.0.1:48410` over HTTPS with a reverse proxy, or a tunnel such as
`cloudflared tunnel --url http://127.0.0.1:48410`. Then start the server with the public origin:

```bash
ZO_REMOTE_ENABLE=1 \
ZO_REMOTE_PUBLIC_URL=https://workshop.example.com \
ZO_REMOTE_OPERATOR_SECRET_FILE=$HOME/.config/zouroboros/remote-operator.secret \
  bun packages/workshop-remote/src/server.ts
```

It will not start if remote mode is not enabled, if no secret file is set, if
the secret file is readable by anyone but you, if the URL is not `https://`,
or if you ask it to bind a non-loopback address without
`ZO_REMOTE_ALLOW_NONLOCAL_BIND=1`. Each case is a startup error.

The connector URL is `https://workshop.example.com/mcp`. By default it serves
the memory tools only. `ZO_REMOTE_EXPOSE_SWARM=1` adds the swarm tools; leave
it off unless you want a web chat to be able to start local coding agents.

When a web client connects, your browser opens the workshop's consent page.
It names the client and where it will send you. Approve with the **operator
secret**. Without it, no client gets a token.

### ChatGPT (developer mode) — **UNTESTED in the app**

Menu names follow OpenAI's documentation as of November 2026 and may move.

1. ChatGPT → Settings → Apps & Connectors → Advanced settings → turn on **Developer mode**.
2. Create a connector. Set **MCP server URL** to `https://<your host>/mcp` and **Authentication** to **OAuth**.
3. ChatGPT finds the authorization server, registers itself (dynamic client
   registration) and opens the consent page. Enter the operator secret and approve.
4. Ask ChatGPT to store and then search a fact in Zouroboros memory.

### Claude.ai custom connector — **UNTESTED in the app**

1. Claude → Settings → Connectors → **Add custom connector**. Set the URL to `https://<your host>/mcp`.
2. Under OAuth client, choose **Register automatically**. That is dynamic
   client registration. Do **not** choose "Use Claude's published identity":
   that option needs Client ID Metadata Documents, which this server does not implement.
3. Connect, approve on the consent page with the operator secret, then run the memory round trip.

### Muse (Meta) custom connector, our reference integration — **UNTESTED in the app**

Meta documents custom connectors that you ask Muse to build in chat. It does
not document MCP or OAuth for them. Third-party MCP providers report that a
message like the one below works. Muse's servers are in Meta's cloud, so the
URL must be public:

> Create a custom connector for my Zouroboros workshop. It is a remote MCP
> server over streamable HTTP at https://&lt;your host&gt;/mcp. It uses OAuth 2.1
> with PKCE and dynamic client registration; the metadata is at
> https://&lt;your host&gt;/.well-known/oauth-authorization-server. Use your
> built-in connector feature so the sign-in runs on your servers, then show me
> the sign-in link.

Approve on the consent page with the operator secret. For the playbook in any
web client, paste `docs/concierge.md` into its custom instructions or project
instructions.

---

## What the connections cannot do (the seams)

- **Filing a factory ticket.** No Community MCP tool files a ticket. The lane
  takes work from a **Linear issue in your Linear Intake project labelled
  `factory-ready`**. The puller (`factory/lane`) reads it. That needs a Linear
  workspace and the lane's Linear settings in `factory/lane/line-config.json`.
  A client with a Linear connector or Linear MCP can file the issue.
  Otherwise you file it in Linear yourself. There is no watched seed-YAML
  drop directory in the Community lane, so treat Linear as the intake. Seeds
  (`factory/lane/seed-*.yaml`) are the build spec a ticket carries, or one
  you run by hand (OPERATORS_MANUAL §3). They are not a filing channel.
  Neither path was tested here.
- **Health at a glance.** `examples/workshop-status.sh` is a shell script on
  the install host. Clients with a shell tool can run it: Claude Code, Codex,
  Gemini, OpenCode, Hermes, Kimi, Pi, and the agent terminals in Cursor and
  VS Code. Claude Desktop and the web clients cannot: no MCP tool wraps it.
- **The installer's handoff block** is addressed to "your AI assistant".
  Paste it into whichever client you connected. The playbook you loaded
  there reads it the same way in every client.
