/**
 * Bun preload for specialist-fence-orchestrator.test.ts.
 *
 * Loads the real persona/specialist-consult module with consultSpecialists()
 * swapped for a stub: every assignment for the requested phase comes back as
 * an invoked specialist whose output is $SPECIALIST_FIXTURE_OUTPUT. This lets
 * the test drive the real orchestrate-v5 prompt path without a persona
 * directory or a model call. The rest of the module is untouched.
 */
import { plugin } from "bun";
import { readFileSync } from "node:fs";

plugin({
  name: "specialist-consult-stub",
  setup(build) {
    build.onLoad({ filter: /persona[\\/]specialist-consult\.ts$/ }, (args) => {
      const real = readFileSync(args.path, "utf8");
      const renamed = real.replace(
        "export async function consultSpecialists(",
        "async function realConsultSpecialists(",
      );
      if (renamed === real) throw new Error("specialist-consult stub: consultSpecialists() not found");
      const stub = `
export async function consultSpecialists(options: ConsultSpecialistsOptions): Promise<SpecialistConsultResult> {
  void realConsultSpecialists;
  const evidence = options.assignments
    .filter((assignment) => assignment.phases.includes(options.phase))
    .map((assignment) => ({
      ...baseEvidence(assignment, options.phase, "invoked", null),
      output: process.env.SPECIALIST_FIXTURE_OUTPUT ?? "",
    }));
  return {
    ok: true, mode: options.mode, phase: options.phase, directorySnapshotHash: null,
    evidence, totalCostUsd: 0, blockedReason: null,
  };
}
`;
      return { contents: renamed + stub, loader: "ts" };
    });
  },
});
