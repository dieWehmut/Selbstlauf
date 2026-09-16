import type { CodexToolConfig, GoalSnapshot } from './types.js';

const resumableGoalStatuses = new Set(['active', 'paused']);

export function chooseCodexPrompt(
  goal: Pick<GoalSnapshot, 'status'> | null | undefined,
  config: CodexToolConfig,
): string {
  const isResumable =
    goal !== null &&
    goal !== undefined &&
    resumableGoalStatuses.has(goal.status) &&
    config.goalStatuses.includes(goal.status as 'active' | 'paused');

  return isResumable ? config.goalPrompt : config.normalPrompt;
}
