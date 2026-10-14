import { z } from 'zod';

/**
 * Canonical schemas for the on-disk spec file (.specflow/specs/{TICKET}.json)
 * and the shared enums. zod is the single source of truth; TypeScript types
 * are inferred from these schemas so disk, MCP tools, and the dashboard API
 * all agree on one shape.
 */

export const SCHEMA_VERSION = 1;

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
});
export type Subtask = z.infer<typeof SubtaskSchema>;

export const StageSchema = z.object({
  id: StageIdSchema,
  aiStatus: AiStatusSchema,
  aiCapability: AiCapabilitySchema,
  gate: GateSchema,
  artifactPath: z.string().optional(),
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
});

export const SetDevelopSubtasksInputSchema = z.object({
  repoId: z.string(),
  ticketId: z.string(),
  subtasks: z.array(
    z.object({
      description: z.string().min(1),
      prompt: z.string().optional(),
      requirementRef: z.string().optional(),
    })
  ),
});

export const ToggleSubtaskInputSchema = z.object({
  repoId: z.string(),
  ticketId: z.string(),
  subtaskId: z.string(),
});
