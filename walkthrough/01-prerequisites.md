# Walkthrough 01 — Prerequisites

## The machine

A Muse VM works out of the box (persistent home, shell, network). Any Linux
host with the same shape works — the only hard assumption is a persistent
`$HOME` and outbound HTTPS.

## Runtimes

Install Bun (memory system, swarm, factory lane), Node 22+ (hooks, verity's
engine), and Python 3.11+ (wayfinder engine). Also needed: `git`, `jq`,
`bash`, and `timeout` (GNU coreutils).

You don't have to work out the install commands yourself. The installer
(`quickstart.sh`, and `bootstrap.sh` when run directly) checks every one of
these first. For anything missing or too old, it prints the exact commands
for your distro family (Debian/Ubuntu, Fedora, Arch, or generic package
names and upstream links). It never runs them and never uses `sudo`: you
run them, then re-run the installer. For reference, on Debian/Ubuntu:

```bash
# bun: not in most distro package managers; the official installer puts
# it in ~/.bun/bin
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"   # or open a new shell

# Node 22 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# git, python3, jq, timeout (coreutils)
sudo apt-get update && sudo apt-get install -y git python3 jq coreutils
```

The Bun installer adds `~/.bun/bin` to your *interactive* shell profile only.
That means a non-interactive shell (`ssh host 'command'`, cron, CI) won't
have it on `PATH`. The installer checks `~/.bun/bin`, `~/.local/bin` and
`~/bin` before it reports a tool missing.

Check them all:

```bash
bun --version
node --version     # want v22+
python3 --version  # want 3.11+
git --version; jq --version; timeout --version
```

## Agent CLIs (your executors)

Install and authenticate **whichever of these you actually use** — any subset
works, the router skips the rest: Claude Code, Codex CLI, OpenCode, Hermes,
Gemini CLI, Kimi, and Pi.

Two healthy executors is the practical minimum (so fallback chains mean
something). Four is comfortable.

**Prove it:** run each CLI's version/help command and confirm you're logged
in. The swarm's `doctor` will re-verify later; this step just confirms the
CLIs themselves work.

## The one API key

`OPENAI_API_KEY` funds memory embeddings (`text-embedding-3-small`) and the
default generation workloads (`gpt-4o-mini`: gate, HyDE, capture, briefing).
Without it, memory runs FTS5-only — fully usable, just keyword-based.

Optional: `ANTHROPIC_API_KEY` if you want the Anthropic generation route.

New to API keys? Read `docs/api-keys.md` first — it covers which keys you
actually need, how to obtain each one, what they cost, and how to tell
they're working.

**Key hygiene (do this now, thank yourself later):**

```bash
mkdir -p ~/.config/zouroboros
chmod 700 ~/.config/zouroboros
cat > ~/.config/zouroboros/apis.env <<'EOF'
export OPENAI_API_KEY="put-your-key-here"
# export ANTHROPIC_API_KEY="put-your-key-here"
EOF
chmod 600 ~/.config/zouroboros/apis.env
echo 'source ~/.config/zouroboros/apis.env' >> ~/.bashrc
```

Keys live in a root-only file, never in chat, never in the repo. If a key
ever touches a transcript, rotate it.

## Clone this repo

Clone this repo to `~/workspace/zouroboros-for-muse` and `cd` into it.

## Prove it

- [ ] `bun --version`, `node --version` (v22+), `python3 --version` (3.11+), and `git`, `jq`, `timeout` all present
- [ ] At least two agent CLIs installed and authenticated
- [ ] `~/.config/zouroboros/apis.env` exists at mode 600 with `OPENAI_API_KEY`

Next: [02 — Core install](02-core-install.md).
