import type { ToolRegistry } from '../tools/registry';

export const GENERIC_TOOL_PLANNING_PROMPT = [
  '## Tool planning and execution',
  '- You are the planner: preserve every requested part of the goal. Use declared tools where needed, complete independent parts even if another part is blocked, and stop only work that depends on the proven blocker.',
  '- Do not announce that you will run a tool and then stop. When work is requested and an appropriate declared tool exists, call it in this turn.',
  '- Tool descriptions and schemas are the capability source of truth. Do not invent modes, tools, settings, execution, or results.',
  '- Ground tool-action claims in their receipts and analysis in the available conversation or source content. Deliver each available result, identify each unfinished part and its specific blocker, and give the next step. Claim whole-request completion only when every requested part is satisfied.',
].join('\n');

export const GENERIC_TOOL_REPLAN_PROMPT = [
  'Your previous response stopped before using a relevant evidence-producing tool that is declared for this turn.',
  'Re-plan from the user goal now. Call the appropriate tool(s), preserve the requested scope, inspect the receipts, and only then answer.',
  'If none of the declared tools can actually satisfy the goal, state the concrete capability gap instead of promising future execution.',
].join(' ');

export function hasRelevantEvidenceTool(
  registry: ToolRegistry,
  taskText: string,
  exposedToolNames: Iterable<string>,
): boolean {
  const exposed = new Set(exposedToolNames);
  return registry.findRelevant(taskText, {
    limit: 8,
    evidenceOperations: ['observe', 'test'],
  }).some(tool => exposed.has(tool.name));
}
