import type { GoalSnapshot, ResumableGoalStatus } from '../domain/types.js';
import { chooseCodexPrompt } from '../domain/policy.js';
import {
  associateCodexThread,
  type CodexProcessContext,
  type CodexThreadRecord,
  type ThreadAssociationResult,
} from './thread-association.js';
import { AppServerClient } from './app-server.js';
import { openCodexState, type CodexStateReader } from './sqlite-state.js';

export type { CodexProcessContext, CodexThreadRecord } from './thread-association.js';

export interface CodexAdapterOptions {
  readonly statePath?: string;
  readonly goalPath?: string;
  readonly stateReader?: CodexStateReader;
  readonly normalPrompt?: string;
  readonly goalPrompt?: string;
  readonly goalStatuses?: readonly ResumableGoalStatus[];
  readonly appServer?: AppServerClient;
}

export interface CodexContinuationContext extends CodexProcessContext {
  readonly threadRecords?: readonly CodexThreadRecord[];
}

export type CodexContinuationDecision =
  | {
      readonly kind: 'inject';
      readonly threadId: string;
      readonly prompt: string;
      readonly goal: GoalSnapshot | null;
    }
  | {
      readonly kind: 'skip';
      readonly reason: CodexSkipReason;
      readonly candidates?: readonly string[];
    };

export type CodexSkipReason =
  | 'ambiguous-thread'
  | 'thread-not-found'
  | 'terminal-goal'
  | 'unknown-goal-status';

export type CodexInjectionResult =
  | CodexContinuationDecision
  | (Extract<CodexContinuationDecision, { kind: 'inject' }> & { readonly transport: 'codex-app-server' });

const TERMINAL_STATUSES = new Set(['complete', 'blocked', 'usage_limited', 'budget_limited']);

/** Coordinates process/thread association, goal policy, and optional App Server injection. */
export class CodexAdapter {
  private readonly reader: CodexStateReader;
  private readonly ownsReader: boolean;
  private readonly normalPrompt: string;
  private readonly goalPrompt: string;
  private readonly goalStatuses: readonly ResumableGoalStatus[];
  private readonly appServer?: AppServerClient;

  public constructor(options: CodexAdapterOptions) {
    if (options.stateReader === undefined && options.statePath === undefined) {
      throw new TypeError('CodexAdapter requires statePath or stateReader');
    }
    this.reader =
      options.stateReader ??
      openCodexState(options.statePath as string, {
        ...(options.goalPath === undefined ? {} : { goalPath: options.goalPath }),
      });
    this.ownsReader = options.stateReader === undefined;
    this.normalPrompt = requirePrompt(options.normalPrompt ?? '继续', 'normalPrompt');
    this.goalPrompt = requirePrompt(options.goalPrompt ?? '/goal resume', 'goalPrompt');
    this.goalStatuses = Object.freeze([...(options.goalStatuses ?? ['active', 'paused'])]);
    this.appServer = options.appServer;
  }

  public async getContinuation(context: CodexContinuationContext): Promise<CodexContinuationDecision> {
    const threads = context.threadRecords ?? this.reader.listThreads().map(toThreadRecord);
    const association = associateCodexThread(context, threads);
    if (association.kind === 'ambiguous') {
      return Object.freeze({
        kind: 'skip',
        reason: 'ambiguous-thread',
        candidates: association.candidates,
      });
    }
    if (association.kind === 'unmatched') {
      return Object.freeze({
        kind: 'skip',
        reason: 'thread-not-found',
      });
    }

    const goal = this.reader.getGoal(association.thread.id);
    if (goal !== null && TERMINAL_STATUSES.has(goal.status)) {
      return Object.freeze({ kind: 'skip', reason: 'terminal-goal' });
    }
    if (goal !== null && goal.status === 'unknown') {
      return Object.freeze({ kind: 'skip', reason: 'unknown-goal-status' });
    }
    const prompt = chooseCodexPrompt(goal, {
      enabled: true,
      normalPrompt: this.normalPrompt,
      goalPrompt: this.goalPrompt,
      goalStatuses: this.goalStatuses,
    });
    return Object.freeze({
      kind: 'inject',
      threadId: association.thread.id,
      prompt,
      goal,
    });
  }

  /** Perform a semantic App Server turn when configured; otherwise return the decision for a console transport. */
  public async injectContinuation(context: CodexContinuationContext): Promise<CodexInjectionResult> {
    const decision = await this.getContinuation(context);
    if (decision.kind === 'skip' || this.appServer === undefined) return decision;
    await this.appServer.resumeThread(decision.threadId);
    await this.appServer.startTurn(decision.threadId, decision.prompt);
    return Object.freeze({ ...decision, transport: 'codex-app-server' });
  }

  public associate(context: CodexContinuationContext): ThreadAssociationResult {
    const threads = context.threadRecords ?? this.reader.listThreads().map(toThreadRecord);
    return associateCodexThread(context, threads);
  }

  /** Return only the associated thread's status for dashboard/state reporting. */
  public getGoal(context: CodexContinuationContext): GoalSnapshot | null {
    const association = this.associate(context);
    return association.kind === 'matched' ? this.reader.getGoal(association.thread.id) : null;
  }

  public close(): void {
    this.appServer?.close();
    if (this.ownsReader) this.reader.close();
  }
}

function toThreadRecord(thread: ReturnType<CodexStateReader['listThreads']>[number]): CodexThreadRecord {
  return {
    id: thread.id,
    cwd: thread.cwd,
    createdAtMs: thread.createdAtMs,
    updatedAtMs: thread.updatedAtMs,
    rolloutPath: thread.rolloutPath,
    status: thread.status,
  };
}

function requirePrompt(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${name} must be non-empty`);
  return value;
}
