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
export type GateStatus =
  | 'not_ready'
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'needs_revision';
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
  /** Optional execution metrics recorded by AI for test/build stages. */
  metrics?: {
    stageCoverage?: number;
    buildSuccess?: boolean;
    cycleTimeMs?: number;
  };
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

/** Requirements stage structured data (Phase 5). */
export interface AffectedFile {
  /** Full repo-relative path, e.g. 'src/app/shared/provider/Foo.ts'. */
  path: string;
  impact?: string;
}

export interface ReqItem {
  title: string;
  detail?: string;
}

export interface RequirementsData {
  /** Flat list of affected files; the dashboard groups these into a tree. */
  affectedFiles: AffectedFile[];
  reuse: ReqItem[];
  buildFromScratch: ReqItem[];
  dataMigration: ReqItem[];
  integrations: ReqItem[];
}

export interface RequirementsArtifact {
  kind: 'requirements';
  /** Human-readable markdown summary. */
  path: string;
  /** JSON sidecar holding the structured RequirementsData. */
  dataPath: string;
}

export type Artifact =
  | MarkdownArtifact
  | DeployChecklistArtifact
  | OpsReportArtifact
  | RequirementsArtifact;

export type { Stage, SpecFile, Subtask, WorkflowOptions, CheckEvidence } from '../../src/core/schemas';

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
