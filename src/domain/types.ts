/**
 * Domain model shared by the MCP API, the worker, and the database layer.
 */

export const TASK_STATUSES = [
  'QUEUED',
  'PREPARING',
  'RUNNING',
  'WAITING',
  'COMPLETED',
  'FAILED',
  'CANCEL_REQUESTED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** States in which the task occupies worker/branch resources. */
export const ACTIVE_STATUSES: readonly TaskStatus[] = [
  'QUEUED',
  'PREPARING',
  'RUNNING',
  'CANCEL_REQUESTED',
];

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

/** States from which a continuation may resume the same Claude session. */
export const CONTINUABLE_STATUSES: readonly TaskStatus[] = ['COMPLETED', 'FAILED', 'WAITING'];

export type TaskType = 'ENGINEERING' | 'ANALYSIS';
export type ExecutionMode = 'WRITE' | 'READ';
export type ContextMode = 'general' | 'repository' | 'branch' | 'pr';

export const EVENT_TYPES = [
  'TASK_CREATED',
  'REPOSITORY_PREPARING',
  'CLAUDE_STARTED',
  'CLAUDE_PROGRESS',
  'CLAUDE_TOOL_USE',
  'CLAUDE_FINISHED',
  'COMMAND_STARTED',
  'COMMAND_FINISHED',
  'TESTS_RUNNING',
  'TESTS_FAILED',
  'FIXING',
  'COMMIT_CREATED',
  'PUSHED',
  'PR_OPENED',
  'PR_UPDATED',
  'PR_MERGED',
  'REVIEW_RUNNING',
  'CONTINUATION_QUEUED',
  'CONTINUATION_STARTED',
  'CONTINUATION_FINISHED',
  'ATTENTION_REQUIRED',
  'COMPLETED',
  'FAILED',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'WORKSPACE_CLEANED',
  'RECONCILED',
] as const;
export type TaskEventType = (typeof EVENT_TYPES)[number];

/** Lifecycle events are always retained; progress events are capped per task. */
export const PRUNABLE_EVENT_TYPES: readonly TaskEventType[] = [
  'CLAUDE_PROGRESS',
  'CLAUDE_TOOL_USE',
  'COMMAND_STARTED',
  'COMMAND_FINISHED',
];

export interface TaskPermissions {
  allowCodeChanges: boolean;
  allowCommit: boolean;
  allowPush: boolean;
  allowOpenPr: boolean;
  allowUpdatePr: boolean;
  allowMerge: boolean;
}

export const READ_ONLY_PERMISSIONS: TaskPermissions = {
  allowCodeChanges: false,
  allowCommit: false,
  allowPush: false,
  allowOpenPr: false,
  allowUpdatePr: false,
  allowMerge: false,
};

export interface RepositoryConfig {
  key: string;
  githubOwner: string;
  githubRepo: string;
  defaultBranch: string;
  enabled: boolean;
  /** Repository-level ceilings; task permissions may never exceed these. */
  allowCodeChanges: boolean;
  allowCommit: boolean;
  allowPush: boolean;
  allowOpenPr: boolean;
  allowUpdatePr: boolean;
  allowMerge: boolean;
  concurrencyLimit: number;
  instructions: string | null;
  workflows: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ClaudeTask {
  id: string;
  type: TaskType;
  status: TaskStatus;
  phase: string | null;
  attentionRequired: boolean;
  attentionReason: string | null;
  repositoryKey: string | null;
  contextMode: ContextMode | null;
  baseBranch: string | null;
  targetBranch: string | null;
  workingBranch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  objective: string;
  executionMode: ExecutionMode;
  requestedModel: string | null;
  actualModel: string | null;
  claudeSessionId: string | null;
  permissions: TaskPermissions;
  maxTurns: number | null;
  createdBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelRequestedAt: Date | null;
  cancelledAt: Date | null;
  headShaBefore: string | null;
  headShaAfter: string | null;
  expectedHeadSha: string | null;
  merged: boolean;
  mergeSha: string | null;
  mergedAt: Date | null;
  exitCode: number | null;
  resultSummary: string | null;
  resultReport: unknown | null;
  reportParseError: string | null;
  rawFinalResponse: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  totalCostUsd: number | null;
  numTurns: number | null;
  claimedBy: string | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;
  claudeStarted: boolean;
  eventSeq: number;
  workspacePath: string | null;
  workspaceCleaned: boolean;
  metadata: Record<string, unknown>;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  seq: number;
  type: TaskEventType;
  message: string;
  detail: unknown | null;
  createdAt: Date;
}

export type ContinuationStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface Continuation {
  id: string;
  taskId: string;
  seq: number;
  instruction: string;
  status: ContinuationStatus;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  resultSummary: string | null;
  errorCode: string | null;
  errorDetail: string | null;
}

export interface WorkflowRun {
  id: string;
  repositoryKey: string;
  workflow: string;
  branch: string | null;
  prNumber: number | null;
  parameters: Record<string, unknown>;
  status: TaskStatus;
  phase: string | null;
  headSha: string | null;
  exitCode: number | null;
  outputSummary: string | null;
  findings: unknown | null;
  artifacts: unknown | null;
  errorCode: string | null;
  errorDetail: string | null;
  createdBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelRequestedAt: Date | null;
  cancelledAt: Date | null;
  claimedBy: string | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isActive(status: TaskStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}
