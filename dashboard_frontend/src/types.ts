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

/** Phase 4: typed artifact model. */
export interface MarkdownArtifact {
  kind: 'markdown';
  path: string;
}

export interface DeployChecklistItem {
  id: string;
  description: string;
  checked: boolean;
  governanceFlag: 'pci' | 'gdpr' | 'none';
}

export interface DeployChecklistArtifact {
  kind: 'deploy-checklist';
  path: string;
  items: DeployChecklistItem[];
  status: 'pending' | 'in_progress' | 'completed' | 'rolled_back';
  rollbackCriteria?: string;
}

export interface OpsReportArtifact {
  kind: 'ops-report';
  path: string;
  logsSanitized: boolean;
  rcaPath?: string;
  runbookPath?: string;
  metrics?: {
    stageCoverage?: number;
    cycleTimeMs?: number;
    buildSuccess?: boolean;
  };
}

export type Artifact = MarkdownArtifact | DeployChecklistArtifact | OpsReportArtifact;

export interface Stage {
  id: StageId;
  aiStatus: AiStatus;
  aiCapability: AiCapability;
  gate: Gate;
  artifact?: Artifact;
  subtasks?: Array<{
    id: string;
    description: string;
    completed: boolean;
    prompt?: string;
    requirementRef?: string;
  }>;
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

export type TemplateSource = 'repo-curated' | 'repo-draft' | 'blueprint-default';

export interface TemplateSummary {
  stageId: StageId;
  source: TemplateSource;
  content: string;
}

export interface RepoEntry {
  id: string;
  path: string;
  name: string;
  addedAt: string;
}
