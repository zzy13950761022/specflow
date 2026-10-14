export const STAGE_IDS = [
  'spec',
  'requirements',
  'design',
  'develop',
  'test',
  'build',
  'deploy',
  'ops',
] as const;
export type StageId = (typeof STAGE_IDS)[number];

export const STAGE_LABELS: Record<StageId, string> = {
  spec: 'SPEC',
  requirements: 'REQUIREMENTS',
  design: 'DESIGN',
  develop: 'DEVELOP',
  test: 'TEST',
  build: 'BUILD',
  deploy: 'DEPLOY',
  ops: 'OPS',
};

export type AiStatus = 'not_started' | 'in_progress' | 'done' | 'stubbed';
export type GateStatus = 'not_ready' | 'pending_review' | 'approved' | 'rejected';
export type AiCapability = 'auto' | 'stub';

export interface Gate {
  status: GateStatus;
  comment?: string;
  reviewedAt?: string;
}

export interface Stage {
  id: StageId;
  aiStatus: AiStatus;
  aiCapability: AiCapability;
  gate: Gate;
  artifactPath?: string;
  subtasks?: Array<{ id: string; description: string; completed: boolean }>;
}

export interface SpecFile {
  schemaVersion: number;
  ticketId: string;
  title: string;
  specPath: string;
  stages: Stage[];
  gateHistory: Array<{ stageId: StageId; from: GateStatus; to: GateStatus; at: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface RepoEntry {
  id: string;
  path: string;
  name: string;
  addedAt: string;
}
