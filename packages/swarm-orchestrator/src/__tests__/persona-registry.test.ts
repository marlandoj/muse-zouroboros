import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface PersonaEntry {
  id: string;
  name: string;
  expertise: string[];
  best_for: string[];
  source?: string;
  selector?: { type?: string; name?: string };
  executor?: string;
  bridge?: string;
}

interface PlatformPersonaEntry {
  slug: string;
  id: string;
  name: string;
  model: string | null;
  scopes: string[];
  purpose: string;
  redacted?: boolean;
  provenance: { source: string; observedAt: string };
}

const expectedGameDevNames = [
  "GameDev · All Out Game Director",
  "GameDev · All Out CSL Engineer",
  "GameDev · All Out Technical Art & UX",
  "GameDev · All Out QA & Release",
  "GameDev · Game Audio Designer",
  "GameDev · Game Designer",
  "GameDev · Godot Gameplay Scripter",
  "GameDev · Godot Shader Developer",
  "GameDev · Level Designer",
  "GameDev · Narrative Designer",
  "GameDev · Roblox Avatar Creator",
  "GameDev · Roblox Experience Designer",
  "GameDev · Roblox Systems Scripter",
  "GameDev · Unity Multiplayer Engineer",
  "GameDev · Unity Shader Graph Artist",
  "GameDev · Unreal Multiplayer Architect",
  "GameDev · Unity Editor Tool Developer",
  "GameDev · Unreal Systems Engineer",
  "GameDev · Unity Architect",
  "GameDev · Unreal World Builder",
  "GameDev · Unreal Technical Artist",
  "GameDev · Technical Artist",
  "GameDev · Three.js Designer",
  "GameDev · Three.js Engineer",
  "GameDev · Three.js Artist",
  "GameDev · Three.js Architect",
].sort();

function readRegistry(path: string): { personas: PersonaEntry[]; platform_personas: PlatformPersonaEntry[] } {
  return JSON.parse(readFileSync(path, "utf8")) as {
    personas: PersonaEntry[];
    platform_personas: PlatformPersonaEntry[];
  };
}

describe("swarm persona registry", () => {
  const packageRoot = join(import.meta.dir, "..", "..");
  const assetPath = join(packageRoot, "assets", "persona-registry.json");
  const docsPath = join(packageRoot, "docs", "persona-registry.json");
  const templateAssociationPath = join(
    packageRoot,
    "..",
    "..",
    "Projects",
    "software-template-library",
    "library",
    "persona-associations.json",
  );

  test("registers the complete 26-person live GameDev fleet by exact name", () => {
    const registry = readRegistry(assetPath);
    const gameDev = registry.personas.filter((entry) => entry.source === "zo-persona-directory");
    expect(gameDev.map((entry) => entry.name).sort()).toEqual(expectedGameDevNames);
    expect(new Set(gameDev.map((entry) => entry.id)).size).toBe(26);
    for (const entry of gameDev) {
      expect(entry.id).toMatch(/^gamedev-[a-z0-9-]+$/);
      expect(entry.expertise.length).toBeGreaterThan(0);
      expect(entry.best_for.length).toBeGreaterThan(0);
      expect(entry.selector).toEqual({ type: "exact-name", name: entry.name });
      expect(entry.executor).toBeUndefined();
      expect(entry.bridge).toBeUndefined();
      expect(JSON.stringify(entry)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
  });

  test("keeps the runtime asset and documentation registry byte-identical", () => {
    expect(readFileSync(docsPath, "utf8")).toBe(readFileSync(assetPath, "utf8"));
  });

  test("registers the observed Zo persona directory by stable platform ID", () => {
    const platform = readRegistry(assetPath).platform_personas;
    expect(platform.length).toBeGreaterThan(0);
    expect(new Set(platform.map((entry) => entry.id)).size).toBe(platform.length);
    expect(new Set(platform.map((entry) => entry.slug)).size).toBe(platform.length);
    for (const entry of platform) {
      expect(entry.slug).toMatch(/^zo-[a-z0-9-]+-[0-9a-f]{8}$/);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.purpose.length).toBeGreaterThan(0);
      expect(entry.provenance.source).toBe("zo.list_personas");
      expect(Number.isNaN(Date.parse(entry.provenance.observedAt))).toBe(false);
      expect(entry.scopes).toEqual([...entry.scopes].sort());
      if (entry.redacted) expect(entry.name).toMatch(/^Restricted Persona [0-9]+$/);
    }
    expect(platform.filter((entry) => entry.redacted)).toHaveLength(3);
  });

  test("ships the persona registry in the package payload", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { files?: string[] };
    expect(manifest.files).toContain("assets/");
  });

  test("registers every GameDev persona selected by the game template", () => {
    const registryNames = new Set(readRegistry(assetPath).personas.map((entry) => entry.name));
    const associations = JSON.parse(readFileSync(templateAssociationPath, "utf8")) as {
      associations: Array<{
        templateId: string;
        roles: Array<{ personaSelector: { name: string } }>;
      }>;
    };
    const game = associations.associations.find((entry) => entry.templateId === "game");
    expect(game).toBeDefined();
    expect(game!.roles.every((role) => registryNames.has(role.personaSelector.name))).toBe(true);
  });
});
