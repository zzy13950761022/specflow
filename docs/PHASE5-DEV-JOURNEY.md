# Phase 5 实现纪实：从"全部自动化"到"真正可用"

这篇文档记录 Phase 5 及后续连续迭代的完整思考过程——不只是"做了什么"，而是"为什么这样做、
发现了什么问题、怎么解决的"。涵盖：Phase 5 核心（AUTO_STAGES 全开）、四个独立功能迭代
（Markdown 渲染确认、needs-revision 三裁决、轮询连续性、develop 阶段改造）。

姊妹篇：`PHASE4-DEV-JOURNEY.md`（结构化 Artifact 模型）。

---

## 第 0 幕：Phase 5 要解决什么问题

Phase 1–4 把基础设施建好了：8 阶段状态机、门控逻辑、结构化 artifact、子任务清单。
但前 4 个阶段只有 `spec` 和 `requirements` 是 `auto`，其余 6 个（design、develop、test、
build、deploy、ops）是 `stub`——占位符，Claude 调 `record_ai_output` 会被接受但不会有
任何 prompt 指导。

Phase 5 的最小定义（来自 IMPLEMENTATION-PLAN.md）：
> *"Minimum: make AUTO_STAGES a single source constant and add a test asserting which stages are auto."*

其余的功能迭代是在实际跑通流程后发现的问题——**真正使用才能发现设计缺口**。

---

## 第 1 幕：Phase 5 核心——AUTO_STAGES 的重构

### 问题：private const 是隐藏的单点

旧代码：

```typescript
// stage-machine.ts
const AUTO_STAGES: ReadonlySet<StageId> = new Set<StageId>(['spec', 'requirements']);
```

`const` 是模块私有的，测试无法直接断言"哪些 stage 是 auto"，只能通过 `createSpec()` 的
副作用来推断。如果有人修改了 `AUTO_STAGES` 但忘了更新注释，没有任何东西能告警。

### 解决：export + 全开 + 测试断言

```typescript
// 改后
export const AUTO_STAGES: ReadonlySet<StageId> = new Set<StageId>([...STAGE_IDS]);
```

三个改动同时发生：
1. `export` 让外部可以读取，测试可以直接断言 `AUTO_STAGES.has('design') === true`
2. `[...STAGE_IDS]` 把全部 8 个 stage 加进去——这就是"Phase 5 全开"
3. 新增测试 `describe('Phase 5 — AUTO_STAGES is the single capability source', ...)` 
   用 `it.each` 参数化测试每个阶段的 gate/record/advance 行为

### 引发的测试级联更新

`AUTO_STAGES` 全开后，所有 `aiCapability: 'stub'` 的 stage 都消失了，
一批测试的断言需要同步更新：

**`stage-machine.test.ts`**

旧断言：
```typescript
it('marks stages 0 & 1 auto and 2-7 stubbed', () => {
  for (let i = 2; i < 8; i++) {
    expect(spec.stages[i].aiCapability).toBe('stub');
    expect(spec.stages[i].aiStatus).toBe('stubbed');
  }
});
```

新断言：
```typescript
it('marks all 8 stages auto (Phase 5)', () => {
  for (const stage of spec.stages) {
    expect(stage.aiCapability).toBe('auto');
    expect(stage.aiStatus).toBe('not_started');
  }
});
```

**`stage-machine.test.ts`——subtask 派生状态测试**

Phase 3 的测试为了测"auto capability 时 aiStatus 能派生"，需要手动把 develop stage 设为 auto：

```typescript
// 旧（Phase 5 之前需要手动覆盖）
const develop = spec.stages.find((s) => s.id === 'develop')!;
develop.aiCapability = 'auto';
develop.aiStatus = 'not_started';
spec = sm.setSubtasks(spec, [...]);
```

Phase 5 之后 develop 默认就是 auto，这些手动覆盖全部可以删掉，测试更简洁。

**`app-core.test.ts`**

一个测试专门验证"stub capability 时 aiStatus 保持 stubbed 不变"：

```typescript
// 旧期望
expect(spec.stages.find(s => s.id === 'develop').aiStatus).toBe('stubbed');
```

Phase 5 后 develop 是 auto，subtask 全完成后 aiStatus 应该是 `done`。
测试语义完全翻转，不是修复，而是更新：

```typescript
// 新期望（Phase 5 后的正确行为）
expect(spec.stages.find(s => s.id === 'develop').aiStatus).toBe('done');
```

**教训**：全局常量的变更会引发测试级联。`export` 它让级联可见，而不是藏在实现里。
测试语义的翻转（从"应该是 stubbed"到"应该是 done"）不是测试坏掉了，
而是行为本身改变了，测试忠实地反映了这一点。

---

## 第 2 幕：Markdown 富文本渲染——"已经做好了"

Phase 5 计划里有一条 cross-cutting 项：Markdown 富文本渲染（🟢 小）。
计划描述是"swap the preview `<pre>` in ArtifactPreview for `react-markdown`"。

但检查前端代码时发现：

```typescript
// App.tsx:3
import ReactMarkdown from 'react-markdown';

// App.tsx:583
<div className="md-body">
  <ReactMarkdown>{content}</ReactMarkdown>
</div>
```

```css
/* index.css:48 */
.md-body { ... }
.md-body h1, h2, h3 { ... }
.md-body p { ... }
.md-body ul, ol { ... }
.md-body code { ... }
```

`react-markdown` 已安装、已引入、已有完整样式——Phase 4 的 artifact viewer 工作中顺带实现了。
唯一还用 `<pre>` 的地方是模板内容预览（prompt 模板原文展示），那是刻意为之，不是问题。

**这是一个"计划先于实现"导致的信息偏差**：计划文档写在前，实现追上来后计划没有更新。
在开始做一个功能前，先检查它是否已经实现，可以节省大量时间。

---

## 第 3 幕：needs-revision 三裁决

### 背景：二元审批的局限

v1 的审批只有两种结果：
- `approve` → 继续下一阶段
- `reject` → Claude 重新生成

但实际工作流中还有第三种常见情况：方向对，但需要小修。用 `reject` 表达这个意图语义太重，
容易让协作者误解。

### Hook A：设计阶段的预留

Phase 4 时在 `GateStatusSchema` 里预留了 `needs_revision` 枚举值：

```typescript
export const GateStatusSchema = z.enum([
  'not_ready',
  'pending_review',
  'approved',
  'rejected',
  // Reserved for a future three-verdict review (approve / reject / needs-revision).
  'needs_revision',
]);
```

同时在前端 `GATE_STYLES` 里预留了样式 key：

```typescript
const GATE_STYLES: Record<string, string> = {
  // ...
  needs_revision: 'bg-orange-400/20 text-orange-200',
};
```

Phase 5 时把这两个预留点连起来，就是完整的 needs-revision 实现。

### 实现：和 reject 几乎相同，但语义不同

`StageMachine.requestRevision` 和 `reject` 的机制完全相同：

```typescript
requestRevision(spec: SpecFile, stageId: StageId, comment: string): SpecFile {
  return this.mutateStage(spec, stageId, (next, stage) => {
    stage.gate.comment = comment;
    stage.gate.reviewedAt = now();
    stage.aiStatus = 'in_progress';
    this.transitionGate(next, stage, 'needs_revision');  // ← 唯一区别
  });
}
```

两者的机制相同（aiStatus → in_progress，Claude 看 comment 重新生成），
但语义不同（minor tweak vs 方向错误）。保持两个独立的方法而不是合并成一个带
`severity` 参数的方法，原因是：
1. 未来可能对 `needs_revision` 和 `rejected` 有不同的处理逻辑（如 UI 展示、指标统计）
2. 调用方代码更清晰：`app.requestRevision(...)` vs `app.reject(...)`

### 前端：三态 mode 替换 boolean flag

旧的 `GateActions` 用一个 boolean `rejecting` 来切换输入框：

```typescript
const [rejecting, setRejecting] = useState(false);
```

三裁决后需要区分"正在 reject"和"正在 revise"：

```typescript
const [mode, setMode] = useState<'normal' | 'rejecting' | 'revising'>('normal');
```

主界面三个按钮：Approve（渐变蓝）、Revise（橙色）、Reject（白色/中性）。
颜色含义：
- Approve = 正向行动，用 joule-gradient 突出
- Revise = 需要注意，橙色警示但不严重
- Reject = 否定，中性白（不用红色是因为"reject 不是报错，是工作流的一部分"）

输入框的 placeholder 也根据 mode 不同：
- rejecting: "Why reject?"
- revising: "What needs revision?"

---

## 第 4 幕：轮询连续性——和 spec-workflow-mcp 对比

### 问题发现：Claude 提交后就停了

用户反馈：Claude 跑到 `pending_review` 后，如果不手动在对话里说话，流程就不会继续。
预期是：Claude 自动轮询，等 Dashboard approve 后自动继续。

### 溯源 spec-workflow-mcp 的解法

查看 spec-workflow-mcp 的 `approvals.ts`：

```typescript
// 当 status === 'pending' 时返回：
nextSteps.push('Continue polling with approvals action:"status"');
```

同时在 `spec-workflow-guide.ts` prompt injection 里注入全局行为规范（mermaid 流程图），
让 Claude 在任何阶段都知道"收到 pending 就轮询"。

**核心洞察**：MCP 是请求-响应协议，没有服务端主动推送。
让 Claude 自驱的唯一方式是：**在工具的返回值里明确告诉 Claude 下一步做什么**。

### ai-pilot 的修复

把 `get_approval_status` 的返回从：

```typescript
return ok({ stageId, gate: stage?.gate });
```

改为：

```typescript
const nextSteps: string[] = [];
if (gate?.status === 'pending_review') {
  nextSteps.push('Gate is pending human review. Wait ~10 seconds then call get_approval_status again. Do NOT stop.');
} else if (gate?.status === 'needs_revision') {
  nextSteps.push(`Comment: "${gate.comment}". Call get_stage_prompt, regenerate, then call record_ai_output.`);
} else if (gate?.status === 'approved') {
  nextSteps.push('Gate is approved. Call advance_stage to move to the next stage.');
}
return ok({ stageId, gate, nextSteps });
```

同时把工具的 description 写清楚：

> "IMPORTANT: always act on the nextSteps field in the response. When status is pending_review: wait ~10 seconds, then call this tool again — do NOT ask the user, do NOT stop."

**效果**：Claude 收到 `pending_review` 后会自动等待并轮询，不需要用户开口。

### `create_spec` 的类似改造

同样模式用在了 `create_spec`：

```typescript
const templateStatus = hasRepoTemplates ? 'ready' : 'none';
const nextSteps = hasRepoTemplates
  ? ['Repo templates exist. Proceed to get_stage_prompt.']
  : ['No repo-specific templates found. Call propose_repo_templates first, then write_repo_template for all 8 stages.'];
return ok({ spec, templateStatus, nextSteps });
```

第一次在新 repo 跑 `create_spec`，Claude 会自动先生成 per-repo 模板再继续——
不需要用户提醒，也不需要在 CLAUDE.md 里写额外说明。

**设计原则**：*工具的返回值是 Claude 的行为指南，description 是全局规范，两者叠加。*

---

## 第 5 幕：develop 阶段改造——对比 spec-workflow-mcp

### 用户发现的问题

用户在实际跑流程时，看到 Claude 在 `develop` 阶段弹出"要创建 inventory.ts 吗"——
这意味着 Claude 用自己的 `Write` 工具直接写文件，绕过了 ai-pilot 的 `record_ai_output`。

期望的流程是：
```
Claude → record_ai_output（提交实现计划）→ 人工审批 → Claude 写代码
```

实际发生的是：
```
Claude → 直接 Write 文件（跳过 record_ai_output 和人工审批）
```

### spec-workflow-mcp 的实现解析

深入阅读 spec-workflow-mcp 的 `implement-task.ts` 后发现它的设计：

1. **审批门在 tasks 文档上，不在每个子任务上**：
   requirements.md / design.md / tasks.md 都需要人工审批，但具体实现任务**不需要**。
   Claude 直接用 Write/Edit 写代码，不需要每条代码都经过审批。

2. **`log-implementation` 是实现知识库的核心**：
   每个子任务写完代码后，必须调 `log-implementation` 记录：
   - 创建/修改了哪些文件
   - 实现了哪些 API endpoint / component / function
   这份日志的主要价值是**给后续子任务（甚至后续 feature）作为上下文**，
   避免重复实现已有的东西。

3. **任务状态通过 tasks.md 里的 checkbox 标记**：
   `[ ]` → `[-]`（进行中）→ `[x]`（完成，但必须先调 `log-implementation`）

### ai-pilot 的 develop 两阶段设计

在用户确认"任务清单生成后审批，审批通过再写代码"后，设计了两阶段流程：

**Phase A（有人工门）**：
```
set_develop_subtasks  ← 注册任务清单（含 prompt/leverage/requirementRef）
record_ai_output      ← 提交任务计划文档（markdown 描述）
→ Dashboard 人工审批
```

**Phase B（无人工门，审批后自动执行）**：
```
get_implementation_logs  ← 先搜索已有实现（避免重复）
Write/Edit 工具          ← 直接写代码
log_implementation       ← MANDATORY：记录实现元数据
toggle_subtask           ← 标记完成
→ 下一个子任务
```

### 新增的 Schema 设计

#### ImplArtifactsSchema——结构化元数据

```typescript
export const ImplArtifactsSchema = z.object({
  apiEndpoints: z.array(z.object({
    method: z.string(),
    path: z.string(),
    purpose: z.string(),
    location: z.string(),
    requestFormat: z.string().optional(),
    responseFormat: z.string().optional(),
  })).optional(),
  components: z.array(...).optional(),
  functions: z.array(...).optional(),
  classes: z.array(...).optional(),
  integrations: z.array(...).optional(),
});
```

这个 schema 直接对应 spec-workflow-mcp 的 `artifacts` 字段，
让日志可以结构化搜索（"这个 ticket 有哪些 API endpoint？"）。

#### ImplLogStore——独立于 SpecStore 的存储

实现日志和 spec 状态机是两个不同关注点：
- SpecStore 管理 spec 的状态（gate、aiStatus、artifact）
- ImplLogStore 管理实现知识（谁创建了什么文件、有哪些对外接口）

分开存储的理由：
1. 实现日志是 append-only（只追加，不修改），适合独立文件
2. 日志文件是 markdown 格式，便于开发者直接阅读（同 spec-workflow-mcp）
3. spec.json 专注于状态机，不应该膨胀为日志数据库

存储路径：`.specflow/impl-logs/{ticketId}/task-{sanitizedId}_{timestamp}_{uuid}.md`

#### SubtaskSchema 扩展——加 leverage 字段

```typescript
export const SubtaskSchema = z.object({
  // ...已有字段
  leverage: z.array(z.string()).optional(),  // 新增：建议复用的已有文件
});
```

对应 spec-workflow-mcp 的 `_Leverage` 字段，明确告诉 Claude
"在实现这个子任务前，先看这些已有文件"，减少重复实现。

### log_implementation 工具的 nextSteps 设计

```typescript
return ok({
  ok: true,
  logId: log.id,
  nextSteps: [
    `Implementation logged. Now call toggle_subtask to mark subtask "${subtaskId}" completed, then move to the next subtask.`,
  ],
});
```

和 `get_approval_status` 一样，通过 `nextSteps` 驱动 Claude 的下一步行动——
记录完日志后立刻告诉 Claude"接下来 toggle_subtask，然后继续下一个"。

---

## 第 6 幕：设计模式总结——nextSteps 驱动架构

贯穿 Phase 5 全部迭代，形成了一个一致的设计模式：

**每个关键工具的返回值都带 `nextSteps` 字段，明确告诉 Claude 下一步做什么。**

| 工具 | 触发条件 | nextSteps 内容 |
|------|---------|---------------|
| `create_spec` | templateStatus = 'none' | "先调 propose_repo_templates" |
| `create_spec` | templateStatus = 'ready' | "直接调 get_stage_prompt" |
| `get_approval_status` | pending_review | "等 10 秒，再次轮询" |
| `get_approval_status` | needs_revision | "读 comment，重新生成" |
| `get_approval_status` | approved | "调 advance_stage" |
| `log_implementation` | 成功 | "调 toggle_subtask，继续下一个" |

这个模式来自 spec-workflow-mcp 的验证——它让 Claude 在不需要用户开口的情况下
自驱完成整个流程，人工介入点只有一个：Dashboard 里的审批操作。

---

## 第 7 幕：遗留问题和后续方向

### 遗留：develop 模板约束不够强

当前 blueprint 默认模板写了"Do NOT use Write/Edit tools directly"，
但用户选择不修改 blueprint 默认值（保留原有实现），这意味着这条约束
**只会出现在 per-repo 的定制模板里**，而不是全局默认。

后续如果发现 Claude 频繁跳过计划阶段直接写代码，可以考虑在 blueprint 模板里
加入更强的约束，或者在 `record_ai_output` 的 description 里加提示。

### 遗留：MCP 重启问题

用户发现修改代码后 Claude 还在用旧版工具——因为 `dist/index.js` 没有重新编译。
目前需要手动 `npm run build` 后重启 MCP 进程。

改善方向：watch mode（`tsc --watch`）+ 自动重启（nodemon），
或者在开发模式下用 `tsx` 直接运行 TypeScript 源码。

### 遗留：implement log 的 fromMarkdown 只解析部分字段

`ImplLogStore.fromMarkdown` 解析 markdown 时只提取了基础字段（summary、statistics、
files），没有解析 artifacts（apiEndpoints、components 等结构化内容）。

后续如果 `get_implementation_logs` 需要被用于精确查询（"给我这个 ticket 的所有 API endpoint"），
需要补全解析逻辑，或者改为在写入时同时保存一份 JSON sidecar。

---

## 总结：Phase 5 的核心收获

### 架构层面

1. **`nextSteps` 是 MCP 工具的"控制流返回值"**：MCP 是无状态的请求-响应协议，
   无法主动推送。通过在返回值里嵌入下一步指令，实现了工作流的自驱动，
   用户只需要在 Dashboard 点审批，无需在对话里手动推进流程。

2. **工具 description 是全局规范，返回值 nextSteps 是上下文指令**：
   前者设定 Claude 的行为模式，后者给出当前状态的具体指引，两者叠加。

3. **develop 阶段的两阶段设计对齐了 spec-workflow-mcp 的实践**：
   审批门在"计划"而不在"每条代码"，实现日志（artifacts）是跨任务的知识库，
   不是单纯的进度标记。

### 工程层面

4. **export 常量而不是把它藏在实现里**：`AUTO_STAGES` 从 private const 变为 exported，
   让测试可以直接断言哪些 stage 是 auto，避免通过副作用来验证配置。

5. **计划文档可能过时，实现前先检查**：Markdown 富文本渲染在 Phase 4 就做好了，
   如果没有检查直接开始实现，会做重复工作。

6. **全局常量变更会引发测试级联**：Phase 5 把 `AUTO_STAGES` 全开后，
   多个测试里手动设置 `aiCapability = 'auto'` 的代码变成了冗余，
   测试语义也需要随之翻转。这不是坏事，这是测试在忠实反映行为变化。
