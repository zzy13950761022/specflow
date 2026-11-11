import { z } from 'zod';
import { AgentProfileSchema } from './agent-profile.js';

/**
 * Canonical schemas for the on-disk spec file (.specflow/specs/{TICKET}.json)
 * and the shared enums. zod is the single source of truth; TypeScript types
 * are inferred from these schemas so disk, MCP tools, and the dashboard API
 * all agree on one shape.
 */

export const SCHEMA_VERSION = 3;

/** The eight stages, in fixed order. Index == position on the board. */
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

export const StageIdSchema = z.enum(STAGE_IDS);
export type StageId = z.infer<typeof StageIdSchema>;

/** AI action progress within a stage. 'stubbed' = stage not yet automated. */
export const AiStatusSchema = z.enum([
  'not_started',
  'in_progress',
  'done',
  'stubbed',
]);
export type AiStatus = z.infer<typeof AiStatusSchema>;

/** Human gate progress. 'rejected' routes back to in_progress (revision loop). */
export const GateStatusSchema = z.enum([
  'not_ready',
  'pending_review',
  'approved',
  'rejected',
  // Reserved for a future three-verdict review (approve / reject / needs-revision).
  // No transition writes this value yet; declared now so the schema needs no
  // migration when that feature lands.
  'needs_revision',
]);
export type GateStatus = z.infer<typeof GateStatusSchema>;

/** Whether a stage's AI action is really wired up or just a placeholder. */
export const AiCapabilitySchema = z.enum(['auto', 'stub']);
export type AiCapability = z.infer<typeof AiCapabilitySchema>;

export const GateSchema = z.object({
  status: GateStatusSchema,
  comment: z.string().optional(),
  reviewedAt: z.string().optional(),
  approvedRevision: z.number().int().optional(),
  actor: z.enum(['human', 'policy']).optional(),
});
export type Gate = z.infer<typeof GateSchema>;

export const ImplementationReviewSchema = z.object({
  id: z.string(), status: z.enum(['pending_review', 'approved', 'rejected', 'needs_revision']),
  developRevision: z.number().int(), taskAttempt: z.number().int(), codeFingerprint: z.string(),
  reportPath: z.string(), submittedAt: z.string(), reviewedAt: z.string().optional(), comment: z.string().optional(),
});

/** DEVELOP sub-task. Phase 3 makes this real: ordered checklist, individually checkable. */
export const SubtaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  completed: z.boolean().default(false),
  /** Per-subtask AI guidance shown when Claude works on this item. */
  prompt: z.string().optional(),
  /** Traceability back to a requirement artifact reference. */
  requirementRef: z.string().optional(),
  testRefs: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  status: z.enum(['pending', 'running', 'done']).default('pending'),
  claimId: z.string().optional(),
  attempt: z.number().int().min(0).default(0),
  review: ImplementationReviewSchema.optional(),
  reviewHistory: z.array(ImplementationReviewSchema).optional(),
  /** Existing files/utilities Claude should reuse when implementing this task. */
  leverage: z.array(z.string()).optional(),
});
export type Subtask = z.infer<typeof SubtaskSchema>;
export const SubtaskInputSchema = z.object({
  id: z.string().min(1).optional(), description: z.string().min(1), prompt: z.string().optional(),
  requirementRef: z.string().optional(), leverage: z.array(z.string()).optional(), testRefs: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(), files: z.array(z.string()).optional(),
});
export type SubtaskInput = z.infer<typeof SubtaskInputSchema>;

/** A single implementation log entry written after a subtask is coded. */
export const ImplArtifactsSchema = z.object({
  apiEndpoints: z.array(z.object({
    method: z.string(),
    path: z.string(),
    purpose: z.string(),
    location: z.string(),
    requestFormat: z.string().optional(),
    responseFormat: z.string().optional(),
  })).optional(),
  components: z.array(z.object({
    name: z.string(),
    type: z.string(),
    purpose: z.string(),
    location: z.string(),
    props: z.string().optional(),
    exports: z.array(z.string()).optional(),
  })).optional(),
  functions: z.array(z.object({
    name: z.string(),
    purpose: z.string(),
    location: z.string(),
    signature: z.string().optional(),
    isExported: z.boolean(),
  })).optional(),
  classes: z.array(z.object({
    name: z.string(),
    purpose: z.string(),
    location: z.string(),
    methods: z.array(z.string()).optional(),
    isExported: z.boolean(),
  })).optional(),
  integrations: z.array(z.object({
    description: z.string(),
    frontendComponent: z.string(),
    backendEndpoint: z.string(),
    dataFlow: z.string(),
  })).optional(),
});
export type ImplArtifacts = z.infer<typeof ImplArtifactsSchema>;

export const ImplementationLogSchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  subtaskId: z.string(),
  developRevision: z.number().int().optional(),
  taskAttempt: z.number().int().optional(),
  summary: z.string(),
  filesModified: z.array(z.string()),
  filesCreated: z.array(z.string()),
  statistics: z.object({
    linesAdded: z.number(),
    linesRemoved: z.number(),
  }),
  artifacts: ImplArtifactsSchema,
  createdAt: z.string(),
});
export type ImplementationLog = z.infer<typeof ImplementationLogSchema>;

/**
 * Typed artifact model (Phase 4). A discriminated union by kind:
 *   - markdown: prose AI output (default for spec/req/design/develop/test/build)
 *   - deploy-checklist: structured deployment gate checklist
 *   - ops-report: ops governance artifact with log-sanitization flag
 *
 * All kinds record a canonical file path so the content can always be read off
 * disk. Structured kinds additionally carry domain-specific fields that the
 * dashboard renders natively and the machine can gate on.
 */
export const MarkdownArtifactSchema = z.object({
  kind: z.literal('markdown'),
  path: z.string(),
  /** Optional execution metrics recorded by AI for test/build stages. */
  metrics: z
    .object({
      buildSuccess: z.boolean().optional(),
      stageCoverage: z.number().optional(),
      cycleTimeMs: z.number().optional(),
    })
    .optional(),
});

export const DeployChecklistItemSchema = z.object({
  id: z.string(),
  description: z.string(),
  checked: z.boolean().default(false),
  /** Flags items that touch payment or GDPR-scoped data per the SAP blueprint. */
  governanceFlag: z.enum(['pci', 'gdpr', 'none']).default('none'),
});

export const DeployChecklistArtifactSchema = z.object({
  kind: z.literal('deploy-checklist'),
  path: z.string(),
  items: z.array(DeployChecklistItemSchema),
  /** Overall deployment status derived from item checks. */
  status: z.enum(['pending', 'in_progress', 'completed', 'rolled_back']).default('pending'),
  rollbackCriteria: z.string().optional(),
});

export const OpsReportArtifactSchema = z.object({
  kind: z.literal('ops-report'),
  path: z.string(),
  /**
   * Governance gate: all logs must be sanitized before an ops-report artifact
   * can be considered 'done'. The dashboard surfaces this flag prominently.
   */
  logsSanitized: z.boolean(),
  rcaPath: z.string().optional(),
  runbookPath: z.string().optional(),
  metrics: z
    .object({
      stageCoverage: z.number().optional(),
      cycleTimeMs: z.number().optional(),
      buildSuccess: z.boolean().optional(),
    })
    .optional(),
});

/**
 * Requirements stage structured data (Phase 5). The dashboard renders a rich
 * view from this: an affected-files table (the frontend groups the flat file
 * list into a collapsible tree), plus a four-quadrant grid of reuse /
 * build-from-scratch / data-migration / integration items. Stored in a JSON
 * sidecar next to the markdown summary, so the artifact itself only carries
 * the two paths.
 *
 * NOTE: affectedFiles is a FLAT list of full paths — the model is not asked to
 * build a tree (unreliable). The dashboard derives the directory tree, merging
 * shared directories and compacting single-child chains (VSCode-style).
 */
export const AffectedFileSchema = z.object({
  /** Full repo-relative path, e.g. 'src/app/shared/provider/Foo.ts'. */
  path: z.string(),
  /** Impact note for this file. */
  impact: z.string().optional(),
});
export type AffectedFile = z.infer<typeof AffectedFileSchema>;

export const ReqItemSchema = z.object({
  title: z.string(),
  detail: z.string().optional(),
});
export type ReqItem = z.infer<typeof ReqItemSchema>;

export const RequirementsDataSchema = z.object({
  affectedFiles: z.array(AffectedFileSchema).default([]),
  reuse: z.array(ReqItemSchema).default([]),
  buildFromScratch: z.array(ReqItemSchema).default([]),
  dataMigration: z.array(ReqItemSchema).default([]),
  integrations: z.array(ReqItemSchema).default([]),
});
export type RequirementsData = z.infer<typeof RequirementsDataSchema>;

export const RequirementsArtifactSchema = z.object({
  kind: z.literal('requirements'),
  /** Human-readable markdown summary. */
  path: z.string(),
  /** JSON sidecar holding the structured RequirementsData. */
  dataPath: z.string(),
});

export const ArtifactSchema = z.discriminatedUnion('kind', [
  MarkdownArtifactSchema,
  DeployChecklistArtifactSchema,
  OpsReportArtifactSchema,
  RequirementsArtifactSchema,
]);
export type Artifact = z.infer<typeof ArtifactSchema>;
export type MarkdownArtifact = z.infer<typeof MarkdownArtifactSchema>;
export type DeployChecklistArtifact = z.infer<typeof DeployChecklistArtifactSchema>;
export type DeployChecklistItem = z.infer<typeof DeployChecklistItemSchema>;
export type OpsReportArtifact = z.infer<typeof OpsReportArtifactSchema>;
export type RequirementsArtifact = z.infer<typeof RequirementsArtifactSchema>;

/**
 * Input shape for recordAiOutput — path is computed by SpecStore, so callers
 * supply all fields except path.
 */
export type ArtifactInput =
  | {
      kind: 'markdown';
      metrics?: {
        buildSuccess?: boolean;
        stageCoverage?: number;
        cycleTimeMs?: number;
      };
    }
  | {
      kind: 'deploy-checklist';
      items?: Array<{
        id?: string;
        description: string;
        checked?: boolean;
        governanceFlag?: 'pci' | 'gdpr' | 'none';
      }>;
      rollbackCriteria?: string;
      status?: 'pending' | 'in_progress' | 'completed' | 'rolled_back';
    }
  | {
      kind: 'ops-report';
      logsSanitized: boolean;
      rcaPath?: string;
      runbookPath?: string;
      metrics?: {
        stageCoverage?: number;
        cycleTimeMs?: number;
        buildSuccess?: boolean;
      };
    }
  | {
      kind: 'requirements';
      data: RequirementsData;
    };

export const CheckEvidenceSchema = z.object({
  runId: z.string(), stageId: z.enum(['test', 'build']), command: z.string(), args: z.array(z.string()),
  exitCode: z.number().nullable(), startedAt: z.string(), finishedAt: z.string(),
  codeFingerprint: z.string(), codeChanged: z.boolean(), timedOut: z.boolean(), outputTruncated: z.boolean(),
  outputPath: z.string(), coverage: z.number().min(0).max(1).optional(),
});
export type CheckEvidence = z.infer<typeof CheckEvidenceSchema>;

export const StageSchema = z.object({
  id: StageIdSchema,
  revision: z.number().int().min(0).default(0),
  stale: z.boolean().default(false),
  staleReason: z.string().optional(),
  evidence: CheckEvidenceSchema.optional(),
  activeCheck: z.object({ runId: z.string(), pid: z.number(), revision: z.number() }).optional(),
  skipped: z.boolean().default(false),
  skipReason: z.string().optional(),
  aiStatus: AiStatusSchema,
  aiCapability: AiCapabilitySchema,
  gate: GateSchema,
  /**
   * Typed artifact produced by the AI action for this stage (Phase 4).
   * Replaces the bare `artifactPath` string. Convenience: `stage.artifact?.path`
   * gives the file path for all kinds.
   */
  artifact: ArtifactSchema.optional(),
  // Timestamped copies of every AI output recorded for this stage, oldest first.
  // Feeds a future snapshot/diff view; writing is cheap, querying comes later.
  artifactHistory: z
    .array(z.object({ path: z.string(), at: z.string(), revision: z.number().optional(), artifact: ArtifactSchema.optional() }))
    .optional(),
  /** Only meaningful for the 'develop' stage; placeholder in v1. */
  subtasks: z.array(SubtaskSchema).optional(),
});
export type Stage = z.infer<typeof StageSchema>;

export const GateHistoryEntrySchema = z.object({
  stageId: StageIdSchema,
  revision: z.number().int().optional(),
  from: GateStatusSchema,
  to: GateStatusSchema,
  comment: z.string().optional(),
  at: z.string(),
  actor: z.enum(['human', 'policy']).optional(),
});
export type GateHistoryEntry = z.infer<typeof GateHistoryEntrySchema>;

export const WorkflowOptionsSchema = z.object({
  description: z.string().max(30000).optional(),
  agentProfileId: z.string().optional(),
  workflowKind: z.enum(['standard', 'bugfix', 'documentation']).default('standard'),
  risk: z.enum(['low', 'normal', 'high']).default('normal'),
  autoChecks: z.boolean().default(false),
  autoRun: z.boolean().default(false),
});
export type WorkflowOptions = z.input<typeof WorkflowOptionsSchema>;

export const SpecFileSchema = z.object({
  schemaVersion: z.number(),
  stateVersion: z.number().int().nonnegative().optional(),
  ticketId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  specPath: z.string(),
  currentStageId: StageIdSchema.default('spec'),
  legacyCompletion: z.object({
    sourceSchemaVersion: z.literal(2), completedAt: z.string(), restoredAt: z.string(),
  }).optional(),
  acceptanceCriteria: z.array(z.object({ id: z.string().min(1), given: z.string().min(1), when: z.string().min(1), then: z.string().min(1) })).default([]),
  workflow: WorkflowOptionsSchema.default({}),
  automation: z.object({
    profile: AgentProfileSchema.optional(), mode: z.enum(['dashboard', 'ide']).optional(),
    enabled: z.boolean(), status: z.enum(['queued', 'running', 'waiting_review', 'failed', 'paused', 'completed']),
    attempt: z.number().int().min(0).default(0), runId: z.string().optional(), ownerPid: z.number().int().optional(),
    runnerPid: z.number().int().optional(), threadId: z.string().optional(), worktreePath: z.string().optional(),
    error: z.string().optional(), startedAt: z.string().optional(), finishedAt: z.string().optional(),
  }).optional(),
  execution: z.object({
    status: z.enum(['ready', 'running', 'waiting_review', 'failed', 'paused', 'completed']).default('ready'),
    retryCount: z.number().int().min(0).default(0), lastSuccessfulStep: z.string().optional(), error: z.string().optional(),
  }).default({}),
  stages: z.array(StageSchema).length(STAGE_IDS.length).refine((stages) => stages.every((stage, index) => stage.id === STAGE_IDS[index]), 'Stages must match the canonical stage order.'),
  gateHistory: z.array(GateHistoryEntrySchema),
  reworkHistory: z.array(z.object({ stageId: StageIdSchema, reason: z.string(), at: z.string() })).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SpecFile = z.infer<typeof SpecFileSchema>;

/* ---- MCP tool input schemas ---- */

export const CreateSpecInputSchema = z.object({
  repoId: z.string(),
  ticketId: z.string().min(1),
  title: z.string().min(1),
});

export const StageTargetInputSchema = z.object({
  repoId: z.string(),
  ticketId: z.string(),
  stageId: StageIdSchema,
});

export const RecordAiOutputInputSchema = StageTargetInputSchema.extend({
  content: z.string(),
  /**
   * For deploy-checklist stages: structured checklist items. When omitted, the
   * artifact is stored as plain markdown.
   */
  checklistItems: z
    .array(
      z.object({
        id: z.string().optional(),
        description: z.string().min(1),
        checked: z.boolean().default(false),
        governanceFlag: z.enum(['pci', 'gdpr', 'none']).default('none'),
      })
    )
    .optional(),
  /** For deploy-checklist stages: rollback criteria prose. */
  rollbackCriteria: z.string().optional(),
  /**
   * For ops-report stages: whether all logs have been sanitized. Required when
   * stageId is 'ops'. If false, the record is accepted but governance surfaced.
   */
  logsSanitized: z.boolean().optional(),
  /** For ops-report stages: path to the RCA document. */
  rcaPath: z.string().optional(),
  /** For ops-report stages: path to the runbook. */
  runbookPath: z.string().optional(),
  /** For ops-report stages: optional metrics snapshot. */
  metrics: z
    .object({
      stageCoverage: z.number().optional(),
      cycleTimeMs: z.number().optional(),
      buildSuccess: z.boolean().optional(),
    })
    .optional(),
  /**
   * For requirements stages: structured data the dashboard renders as a
   * tree-table + four-quadrant grid. Stored in a JSON sidecar. When omitted,
   * the artifact is stored as plain markdown.
   */
  requirementsData: RequirementsDataSchema.optional(),
});

export const SetDevelopSubtasksInputSchema = z.object({
  repoId: z.string(),
  ticketId: z.string(),
  subtasks: z.array(
    z.object({
      description: z.string().min(1),
      prompt: z.string().optional(),
      requirementRef: z.string().optional(),
      leverage: z.array(z.string()).optional(),
    })
  ),
});

export const ToggleSubtaskInputSchema = z.object({
  repoId: z.string(),
  ticketId: z.string(),
  subtaskId: z.string(),
});

export const LogImplementationInputSchema = z.object({
  repoId: z.string(),
  ticketId: z.string(),
  subtaskId: z.string(),
  summary: z.string().min(1),
  filesModified: z.array(z.string()),
  filesCreated: z.array(z.string()),
  statistics: z.object({
    linesAdded: z.number().int().min(0),
    linesRemoved: z.number().int().min(0),
  }),
  artifacts: ImplArtifactsSchema,
});

export const GetImplementationLogsInputSchema = z.object({
  repoId: z.string(),
  ticketId: z.string(),
  subtaskId: z.string().optional(),
});
