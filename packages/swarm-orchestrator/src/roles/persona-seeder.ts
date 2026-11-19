/**
 * Persona Seeder — imports agency personas into the RoleRegistry.
 *
 * Reads agency-agents-personas.json, maps each persona to an executor
 * based on its domain category, and populates the RoleRegistry.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getWorkspaceRoot } from 'zouroboros-core';
import type { RoleRegistry, Role } from './registry.js';

export interface PersonaEntry {
  name: string;
  abspath: string;
}

export interface PersonaSeedOptions {
  personasPath?: string;
  overwrite?: boolean;
}

const DEFAULT_PERSONAS_PATH = join(getWorkspaceRoot(), 'agency-agents-personas.json');

const CATEGORY_EXECUTOR_MAP: Record<string, { executorId: string; model: string | null }> = {
  engineering: { executorId: 'claude-code', model: 'mid' },
  design: { executorId: 'gemini', model: 'heavy' },
  marketing: { executorId: 'hermes', model: null },
  product: { executorId: 'claude-code', model: 'mid' },
  'project-management': { executorId: 'claude-code', model: 'mid' },
  'spatial-computing': { executorId: 'claude-code', model: 'mid' },
  specialized: { executorId: 'claude-code', model: 'mid' },
  support: { executorId: 'hermes', model: null },
  testing: { executorId: 'codex', model: null },
};

interface SOPContract {
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  successCriteria: string[];
}

const CATEGORY_SOP_MAP: Record<string, SOPContract> = {
  engineering: {
    inputs: { task_spec: 'string', codebase_context: 'string' },
    outputs: { code_diff: 'string', test_results: 'string' },
    successCriteria: ['code_diff non-empty', 'tests pass'],
  },
  design: {
    inputs: { design_brief: 'string', brand_tokens: 'object' },
    outputs: { design_artifacts: 'array', design_doc: 'string' },
    successCriteria: ['design_artifacts non-empty', 'design_doc non-empty'],
  },
  marketing: {
    inputs: { campaign_brief: 'string', target_audience: 'string' },
    outputs: { content_draft: 'string', channel_plan: 'object' },
    successCriteria: ['content_draft non-empty', 'channel_plan non-empty'],
  },
  product: {
    inputs: { requirements: 'string', user_stories: 'array' },
    outputs: { spec_doc: 'string', acceptance_criteria: 'array' },
    successCriteria: ['spec_doc non-empty', 'acceptance_criteria length >= 1'],
  },
  'project-management': {
    inputs: { project_scope: 'string', timeline: 'string' },
    outputs: { project_plan: 'object', milestone_map: 'array' },
    successCriteria: ['project_plan non-empty', 'milestone_map length >= 1'],
  },
  'spatial-computing': {
    inputs: { spatial_spec: 'string', environment_context: 'object' },
    outputs: { spatial_design: 'object', implementation_plan: 'string' },
    successCriteria: ['spatial_design non-empty', 'implementation_plan non-empty'],
  },
  specialized: {
    inputs: { domain_context: 'string', task_requirements: 'string' },
    outputs: { domain_output: 'string', recommendations: 'array' },
    successCriteria: ['domain_output non-empty'],
  },
  support: {
    inputs: { user_query: 'string', context: 'string' },
    outputs: { response: 'string', escalation_needed: 'boolean' },
    successCriteria: ['response non-empty'],
  },
  testing: {
    inputs: { code_under_test: 'string', test_requirements: 'string' },
    outputs: { test_suite: 'string', coverage_report: 'object' },
    successCriteria: ['test_suite non-empty', 'coverage_report non-empty'],
  },
};

export function inferCategoryFromPath(abspath: string): string {
  const match = abspath.match(/agency-agents\/([^/]+)\//);
  return match ? match[1] : 'specialized';
}

export function mapCategoryToExecutor(category: string): { executorId: string; model: string | null } {
  return CATEGORY_EXECUTOR_MAP[category] ?? { executorId: 'claude-code', model: 'mid' };
}

export function personaNameToRoleId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function categoryToSOP(category: string): SOPContract {
  return CATEGORY_SOP_MAP[category] ?? CATEGORY_SOP_MAP['specialized'];
}

export function seedPersonasToRegistry(
  registry: RoleRegistry,
  options: PersonaSeedOptions = {},
): { added: number; skipped: number; roles: Array<{ id: string; name: string; executorId: string }> } {
  const personasPath = options.personasPath ?? DEFAULT_PERSONAS_PATH;

  if (!existsSync(personasPath)) {
    throw new Error(`Personas file not found: ${personasPath}`);
  }

  const personas: PersonaEntry[] = JSON.parse(readFileSync(personasPath, 'utf-8'));
  let added = 0;
  let skipped = 0;
  const roles: Array<{ id: string; name: string; executorId: string }> = [];

  for (const persona of personas) {
    const category = inferCategoryFromPath(persona.abspath);
    const { executorId, model } = mapCategoryToExecutor(category);
    const sop = categoryToSOP(category);
    const roleId = personaNameToRoleId(persona.name);

    const existing = registry.get(roleId);
    if (existing && !options.overwrite) {
      skipped++;
      continue;
    }

    const roleFields = {
      name: persona.name,
      executorId,
      model,
      tags: [category, ...persona.name.toLowerCase().split(/\s+/)],
      description: `${persona.name} persona from ${category} agency`,
      inputs: sop.inputs,
      outputs: sop.outputs,
      successCriteria: sop.successCriteria,
    };

    if (existing && options.overwrite) {
      registry.update(roleId, roleFields);
    } else {
      registry.create({ id: roleId, ...roleFields });
    }

    added++;
    roles.push({ id: roleId, name: persona.name, executorId });
  }

  return { added, skipped, roles };
}
