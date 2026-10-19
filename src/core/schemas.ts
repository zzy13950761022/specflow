import { z } from 'zod';

/**
 * Canonical schemas for the on-disk spec file (.specflow/specs/{TICKET}.json)
 * and the shared enums. zod is the single source of truth; TypeScript types
 * are inferred from these schemas so disk, MCP tools, and the dashboard API
 * all agree on one shape.
 */

export const SCHEMA_VERSION = 2;

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
});
export type Gate = z.infer<typeof GateSchema>;

/** DEVELOP sub-task. Phase 3 makes this real: ordered checklist, individually checkable. */
export const SubtaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  completed: z.boolean().default(false),
  /** Per-subtask AI guidance shown when Claude works on this item. */
  prompt: z.string().optional(),
  /** Traceability back to a requirement artifact reference. */
  requirementRef: z.string().optional(),
  /** Existing files/utilities Claude should reuse when implementing this task. */
  leverage: z.array(z.string()).optional(),
});
export type Subtask = z.infer<typeof SubtaskSchema>;

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

export const ArtifactSchema = z.discriminatedUnion('kind', [
  MarkdownArtifactSchema,
  DeployChecklistArtifactSchema,
  OpsReportArtifactSchema,
]);
export type Artifact = z.infer<typeof ArtifactSchema>;
export type MarkdownArtifact = z.infer<typeof MarkdownArtifactSchema>;
export type DeployChecklistArtifact = z.infer<typeof DeployChecklistArtifactSchema>;
export type DeployChecklistItem = z.infer<typeof DeployChecklistItemSchema>;
export type OpsReportArtifact = z.infer<typeof OpsReportArtifactSchema>;

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
    };

export const StageSchema = z.object({
  id: StageIdSchema,
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
    .array(z.object({ path: z.string(), at: z.string() }))
    .optional(),
  /** Only meaningful for the 'develop' stage; placeholder in v1. */
  subtasks: z.array(SubtaskSchema).optional(),
});
export type Stage = z.infer<typeof StageSchema>;

export const GateHistoryEntrySchema = z.object({
  stageId: StageIdSchema,
  from: GateStatusSchema,
  to: GateStatusSchema,
  comment: z.string().optional(),
  at: z.string(),
});
export type GateHistoryEntry = z.infer<typeof GateHistoryEntrySchema>;

export const SpecFileSchema = z.object({
  schemaVersion: z.number(),
  ticketId: z.string(),
  title: z.string(),
  specPath: z.string(),
  stages: z.array(StageSchema).length(STAGE_IDS.length),
  gateHistory: z.array(GateHistoryEntrySchema),
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
