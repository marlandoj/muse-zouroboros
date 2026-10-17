# Engine soak runbook — Verity engine cutover

Goal: prove the clean-room engine (`engine/`) behaves identically to the
pinned Canny engine on **real traffic** before the default flips.

## The bar

Zero verdict divergences over several days of live hook traffic, across all
harnesses in use. The golden corpus (`test/engine-parity.sh`, 33/33) proves
equivalence on synthetic fixtures; the soak proves it on the wild.

## 1. Capture live events

On the machine whose traffic you want to soak, export the capture path in
the hook's environment (e.g. in the shell profile that launches the agent):

```bash
export VERITY_EVENT_CAPTURE="$HOME/.verity/soak-events.jsonl"
```

`verity-hook.sh` then appends every post-adapter event as
`{"agent":..., "event":{...}}`, one JSON per line. Capture is inert by
default (unset = no capture, no overhead beyond one `[ -n ... ]` test).

Rotate the file daily (`soak-events-2026-10-14.jsonl`, …) so each day is an
independent run.

## 2. Run the comparison

```bash
bash scripts/engine-dual-run.sh --events ~/.verity/soak-events-2026-10-14.jsonl
```

This feeds every event to **both** engines in order, from empty homes, and
diffs the verdicts. Exit 0 (and `0 divergences`) is a clean day.

Homes are kept separate inside the script: the new engine gets an explicit
`VERITY_ENGINE_HOME`, so its `CANNY_HOME` fallback can never collide with
the old engine's home. Do not "simplify" this — a shared home would let one
engine read the other's ledger and invalidate the comparison.

Point at existing homes to soak against real accumulated state:

```bash
bash scripts/engine-dual-run.sh --events day.jsonl \
  --old-home ~/.canny --new-home ~/.verity/engine
```

## 3. Triage divergences

Each divergence prints the event plus both verdicts.

1. **Reproduce minimally**: shrink the event stream to the smallest prefix
   that still diverges (binary chop the capture file).
2. **Characterize the old engine**: probe the pinned Canny binary directly
   (`CANNY_HOME=$(mktemp -d)` — never the live `~/.canny`) to pin the exact
   expected behavior.
3. **Add a fixture**: extend `test/fixtures/engine/` with the case
   (see `test/engine-corpus-generate.sh`), so the corpus — not just the
   soak — guards the behavior.
4. **Fix `engine/`**, re-run `test/engine-parity.sh` (must stay 33+/33+)
   and the soak day (must return to 0 divergences).

Never "fix" a divergence by editing the old engine's expectations, and
never read its sources — black-box probing only, per `engine/ENGINE.md`.

## 4. Flip criteria

- [ ] Corpus parity green (`bash test/engine-parity.sh engine/cli.js`).
- [ ] `bash test/run.sh` green.
- [ ] ≥ 3 business days of live traffic with 0 divergences, covering Stop
      verdicts (blocks and allows), secret/test-deletion guards, and at
      least one trusted `.canny.json` project if any exist.
- [ ] Similarity self-check re-run on the final `engine/` (see §5).

Then: `scripts/install.sh --engine verity` (or set `"engine":"verity"` in
the Verity config) to flip the default. Keep the old checkout until Phase 6.

## 5. Similarity self-check

Before the flip, diff `engine/` against the old `dist/` for accidental
textual similarity. Structural similarity (same CLI contract, same ledger
format) is expected; shared code is not. A lightweight check:

```bash
for f in engine/*.js; do
  echo "== $f"
  grep -r -F -f <(tr -c '[:alnum:]_' '\n' < "$f" | sort -u | awk 'length > 12') \
    /home/workspace/Integrations/canny/dist/ | head -n 5
done
```

Long shared token runs (beyond message strings required for byte-parity,
e.g. `Canny:` prefixes and the SessionStart note) deserve a second look.
The pre-delivery result is recorded in the phase report.

## 6. After the flip (Phase 6, separate approval)

- Remove the Canny attribution from README/hero/SKILL.md.
- Decide the `Canny:` message prefix and `.canny.json` filename (kept for
  byte-parity during the soak; both are flagged for revisit).
- Retire the old checkout; keep dual-run tooling for regression.
