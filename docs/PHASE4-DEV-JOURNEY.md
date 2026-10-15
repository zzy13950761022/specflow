# Phase 4 实现纪实：结构化 Artifact 模型

这篇文档记录 Phase 4 的**完整思考过程**——从读需求到写代码，包括遇到的每一个设计决策、
踩过的坑、以及为什么这样解决而不是那样解决。目标读者是"想把这个项目变成自己的"的你。

姊妹篇：`PHASE3-DEV-JOURNEY.md`（Phase 3 子任务清单）。

---

## 第 0 幕：Phase 4 要解决什么问题

v1 里每个 Stage 只有一个 `artifactPath?: string`——一条指向 `.md` 文件的路径。
对 SPEC、REQUIREMENTS、DESIGN 这些"写文档"的阶段，这完全够用。

但 DEPLOY 和 OPS 产出的不是文档，是**行动和外部状态**：

| 阶段 | 实际产出 |
|------|---------|
| DEPLOY | 部署检查清单（每一条要手动确认）、回滚标准、PCI/GDPR 合规项 |
| OPS | 运维报告（日志脱敏状态、故障复盘路径、Runbook 路径、各项指标） |

如果 Phase 5 直接在平面 `.md` 模型上实现 DEPLOY/OPS 自动化，之后改模型就要迁移数据。
**先把形状固定对，再往里填自动化逻辑**——这是 Phase 4 存在的理由。

---

## 第 1 幕：核心设计决策

### 决策 1：判别联合体（Discriminated Union），不是继承

最直觉的做法是给 `Stage` 加一堆可选字段：
```typescript
// 直觉做法（没有采用）
interface Stage {
  artifactPath?: string;
  checklistItems?: ChecklistItem[];   // DEPLOY 专用
  logsSanitized?: boolean;            // OPS 专用
  // ...
}
```

问题：TypeScript 不会帮你检查"当 stageId = 'ops' 时 logsSanitized 必须存在"。
每个读取这些字段的地方都要自己判断，遗漏一处就是运行时错误。

**正确做法**：zod 的 `z.discriminatedUnion`，用 `kind` 字段作为鉴别符：

```typescript
// kind 是 "tag"，TypeScript 用它缩窄类型
const ArtifactSchema = z.discriminatedUnion('kind', [
  MarkdownArtifactSchema,         // { kind: 'markdown', path }
  DeployChecklistArtifactSchema,  // { kind: 'deploy-checklist', path, items, ... }
  OpsReportArtifactSchema,        // { kind: 'ops-report', path, logsSanitized, ... }
]);
```

好处：
- 拿到一个 `Artifact`，在 `if (artifact.kind === 'ops-report')` 分支里，
  TypeScript **自动知道** `artifact.logsSanitized` 一定存在，不需要断言
- 新增 kind（比如 `test-coverage`）只需增加一个分支，不影响其他代码
- zod 的 `parse` 会在读磁盘时验证完整性，损坏的文件立刻报错而不是悄悄传播

---

### 决策 2：path 字段放在每种 Artifact 里，而非外层

最初草案把 `path` 提到联合体外面：
```typescript
// 草案（没有采用）
interface Stage {
  artifact?: {
    kind: 'markdown' | 'deploy-checklist' | 'ops-report';
    path: string;
    // ...其他字段
  };
}
```

但这样 zod 的 discriminatedUnion 就不能工作了（它要求鉴别字段在每个成员的顶层）。
而且"每种 artifact 都有 path"这个不变式最好**在 schema 里声明**，而不是靠调用方记住。

**最终设计**：每个 kind 里都有 `path: z.string()`，统一通过 `artifact.path` 访问文件路径。
这让 `readArtifact` 的实现非常简单：

```typescript
// app-core.ts — 三种 kind 都这样读，一行代码
if (!stage?.artifact?.path) return null;
return readFile(join(repoPath, stage.artifact.path), 'utf-8');
```

---

### 决策 3：ArtifactInput vs Artifact——两个类型，两个职责

`Artifact` 是存到磁盘的完整对象，每个字段都齐全（`id`、`path` 由系统生成）。
但调用 `record_ai_output` 的 Claude 不需要知道 `path`（SpecStore 计算），
也不需要给 checklist 每条提供 `id`（SpecStore 生成）。

如果只暴露 `Artifact` 类型给调用方，就得让 Claude 传 `path` 进来——但 path 是
服务端决定的，不该让客户端操心。

**解决方案**：单独定义 `ArtifactInput`（`src/core/schemas.ts`）：

```typescript
export type ArtifactInput =
  | { kind: 'markdown' }
  | {
      kind: 'deploy-checklist';
      items?: Array<{ id?: string; description: string; ... }>;
      rollbackCriteria?: string;
    }
  | {
      kind: 'ops-report';
      logsSanitized: boolean;   // 注意：这里是必填，不是 optional
      rcaPath?: string;
      // ...
    };
```

`SpecStore.writeArtifact` 接收 `ArtifactInput`，输出完整的 `Artifact`（补充 `path`、
为 checklist 条目生成 UUID）。这是标准的**Command / Domain Object 分离**模式。

---

### 决策 4：所有 kind 都写 .md 文件，不额外写 JSON sidecar

Phase 4 设计文档里提到"结构化 kind 可以写 JSON sidecar"。最终没有这样做，原因：

1. **调试友好**：运维人员打开 `.specflow/artifacts/` 目录，看到的是可读的 `.md` 文件，
   不是 JSON 二进制。
2. **git diff 友好**：deploy-checklist 的 content（markdown 渲染的检查清单）本来就是
   人工可读的文本，不需要 JSON。
3. **结构化字段已经在 spec.json 里了**：`Stage.artifact` 整个对象序列化进
   `.specflow/specs/{TICKET}.json`，包含所有结构化字段。`.md` 文件只是供
   人类肉眼读的副本。

结论：`.md` 文件是"人类界面"，`spec.json` 里的 `artifact` 对象是"机器界面"，
两者共存，不重复。

---

## 第 2 幕：文件顺序 Bug——TypeScript 编译前的陷阱

### 问题现象

第一次 `npm run build` 报错：

```
src/core/schemas.ts(82,13): error TS2448: Block-scoped variable 'ArtifactSchema'
used before its declaration.
```

### 根本原因

我把 `ArtifactSchema` 的定义放在了 `StageSchema` **之后**，
但 `StageSchema` 引用了 `ArtifactSchema`：

```typescript
// schemas.ts（错误顺序）
export const StageSchema = z.object({
  // ...
  artifact: ArtifactSchema.optional(),  // ← 此时 ArtifactSchema 还没定义！
});

// ... 几十行后 ...
export const ArtifactSchema = z.discriminatedUnion(...);
```

JavaScript/TypeScript 的 `const` 声明不会像 `function` 那样被提升（hoisting），
`const` 从声明处才开始存在，在这之前引用它是 "temporal dead zone"（暂时性死区）错误。

### 解决方案

把所有 Artifact 相关 schema 移到 `StageSchema` **之前**：

```
SubtaskSchema
↓
MarkdownArtifactSchema
DeployChecklistItemSchema
DeployChecklistArtifactSchema
OpsReportArtifactSchema
ArtifactSchema          ← 必须在这里
↓
StageSchema             ← 才能引用 ArtifactSchema
↓
GateHistoryEntrySchema
↓
SpecFileSchema
```

**教训**：在 TypeScript 里，`const` 之间的顺序很重要。
zod schema 是运行时构建的对象（不是类型），必须遵守 JavaScript 的执行顺序。

---

## 第 3 幕：TypeScript 类型推断的陷阱——Omit on Union

### 问题现象

MCP server 里写了：

```typescript
let artifactInput: Parameters<typeof app.recordAiOutput>[4] | undefined;
```

`app.recordAiOutput` 的第 5 个参数类型是 `Omit<Artifact, 'path' | 'kind'> & { kind: Artifact['kind'] }`。

TypeScript 立刻报错：

```
error TS2353: Object literal may only specify known properties,
and 'items' does not exist in type 'Omit<...>'
```

### 根本原因

`Omit<Artifact, 'path'>` 在联合类型上的行为是**分布式的**：

```typescript
type Artifact = MarkdownArtifact | DeployChecklistArtifact | OpsReportArtifact;

// TypeScript 展开后：
type Omit<Artifact, 'path'> =
  | Omit<MarkdownArtifact, 'path'>        // { kind: 'markdown' }
  | Omit<DeployChecklistArtifact, 'path'> // { kind: 'deploy-checklist'; items; ... }
  | Omit<OpsReportArtifact, 'path'>       // { kind: 'ops-report'; logsSanitized; ... }
```

但再做 `& { kind: Artifact['kind'] }` 时，`kind` 变成了三种值的联合：
`'markdown' | 'deploy-checklist' | 'ops-report'`，这把联合体"压扁"了——
TypeScript 不再知道"当 kind 是 `deploy-checklist` 时，items 字段存在"。
结果整个类型变成了三个 Omit 结果的交叉集，实际上几乎没有公共属性。

### 解决方案

不要用 `Omit`，直接定义一个专门的 `ArtifactInput` 类型：

```typescript
// schemas.ts
export type ArtifactInput =
  | { kind: 'markdown' }
  | { kind: 'deploy-checklist'; items?: [...]; rollbackCriteria?: string }
  | { kind: 'ops-report'; logsSanitized: boolean; ... };
```

这是一个干净的、有独立语义的类型，不依赖对 `Artifact` 的变换推导。
TypeScript 的 discriminated union narrowing 在赋值时也能正常工作：

```typescript
// server.ts — 类型安全，不需要任何断言
let artifactInput: ArtifactInput | undefined;
if (stageId === 'deploy' && checklistItems) {
  artifactInput = { kind: 'deploy-checklist', items: checklistItems };  // ✓
} else if (stageId === 'ops') {
  artifactInput = { kind: 'ops-report', logsSanitized: logsSanitized ?? false };  // ✓
}
```

**教训**：不要对 Union type 做 `Omit`，结果往往不是你期望的。
需要"去掉某些字段的 Union"时，最好手写新的 Union type。

---

## 第 4 幕：spec-store.ts 的 kind 判断——narrow 失效

### 问题现象

第一版 `writeArtifact` 的实现里：

```typescript
async writeArtifact(
  // ...
  artifactInput?: Omit<Artifact, 'path' | 'kind'> & { kind: Artifact['kind'] }
) {
  const kind = artifactInput?.kind ?? 'markdown';
  // ...
  if (kind === 'deploy-checklist') {
    const input = artifactInput as { kind: 'deploy-checklist'; items?: [...] };
    // 用了类型断言 ← 代码味道
  }
}
```

到处是 `as` 断言，说明类型系统帮不上忙。

### 解决方案

切换到 `ArtifactInput` 后，用双重条件守卫（type guard）：

```typescript
async writeArtifact(
  // ...
  artifactInput?: ArtifactInput
) {
  if (kind === 'deploy-checklist' && artifactInput?.kind === 'deploy-checklist') {
    // TypeScript 自动缩窄：artifactInput 是 { kind: 'deploy-checklist'; items?: ... }
    artifact = {
      kind: 'deploy-checklist',
      path: rel,
      items: (artifactInput.items ?? []).map(...),  // ✓ 不需要断言
    };
  }
}
```

**模式**：`kind === X && input?.kind === X` 双重检查让 TypeScript narrow 两个变量，
是 discriminated union 的标准用法。

---

## 第 5 幕：测试升级——改接口时保持测试语义不变

### 挑战

`stage-machine.test.ts` 里所有的 `sm.recordAiOutput(spec, 'spec', 'p')` 调用
（`'p'` 是一个占位路径字符串）都要改成传 `Artifact` 对象。

一口气改 10 个地方，容易"改着改着丢了语义"。

### 策略：机械替换 + 新增覆盖

对已有的通过测试（测 gate 逻辑、advance 等），只做**机械替换**，
不改测试语义：

```typescript
// 旧
sm.recordAiOutput(spec, 'spec', 'p')

// 新（等价替换，语义不变）
sm.recordAiOutput(spec, 'spec', { kind: 'markdown', path: 'p' })
```

用 vim 的全局替换（`replace_all: true`）一次性改完，然后在新增的
`StageMachine.recordAiOutput` 描述块里专门测试新增的 kind：

```typescript
// 新增：专门测试 deploy-checklist artifact
it('stores a deploy-checklist artifact with items', () => {
  spec = sm.recordAiOutput(spec, 'deploy', {
    kind: 'deploy-checklist',
    path: '...',
    items: [{ id: 'i1', description: 'Step 1', checked: false, governanceFlag: 'pci' }],
    status: 'pending',
  });
  expect(stage.artifact?.kind).toBe('deploy-checklist');
  if (stage.artifact?.kind === 'deploy-checklist') {
    expect(stage.artifact.items[0].governanceFlag).toBe('pci');
  }
});
```

`if` 守卫是必要的——`stage.artifact` 是 `Artifact | undefined`，
在 `if` 之外访问 `.items` 会编译报错。测试里也用 narrowing，让类型系统辅助验证。

---

## 第 6 幕：Dashboard 测试——响应多了字段就报错

### 问题现象

`server.test.ts` 里有一个精确匹配：

```typescript
expect(res.json()).toEqual({ stageId: 'spec', content: '# generated spec body' });
```

Phase 4 之后，`GET /artifact` 响应里多了 `artifact` 字段：

```json
{
  "stageId": "spec",
  "content": "# generated spec body",
  "artifact": { "kind": "markdown", "path": "specs/ABC-1.md" }
}
```

Vitest 的 `toEqual` 是**深度精确匹配**，额外字段会导致失败。

### 解决方案

改成 property-by-property 验证：

```typescript
const body = res.json();
expect(body.stageId).toBe('spec');
expect(body.content).toBe('# generated spec body');
expect(body.artifact?.kind).toBe('markdown');
```

同时把测试名改成 "returns the recorded stage content and artifact metadata"——
名字应该反映测试的新语义，而不是继续叫 "returns the recorded stage content"。

**教训**：`toEqual` 对于 API 响应测试往往过于严格。当接口"只增不减"时，
用 property 断言更能承受未来的字段添加。

---

## 第 7 幕：E2E 测试的历史 Bug

### 问题现象

`npm run test:e2e` 早在 Phase 4 之前就已经失败——Phase 4 没有引入这个 Bug，
但 Phase 4 验收标准要求 e2e 绿色，所以需要修。

错误信息：
```
expect(locator).toHaveCount(expected)
- Expected: 0
+ Received: 2
page.getByRole('button', { name: 'Approve' })
```

### 根本原因溯源

Phase 3（review-before-approve feature）改变了 UI 流程：
- 以前：`pending_review` 状态直接显示 `Approve` 按钮
- 现在：显示 "Review & approve" 按钮，点击后打开 Modal，Modal 里有 `Approve` 按钮

e2e 测试没有跟进这个变化。原来的测试：

```typescript
// 旧 e2e（有 Bug）
const approve = page.getByRole('button', { name: 'Approve' }).first();
await expect(approve).toBeVisible();
await approve.click();
// 期望 Approve 按钮消失
await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
```

Playwright 的 `getByRole` 默认做**大小写不敏感的子串匹配**。
"Review & **approve**" 中包含 "approve"，所以它也被 `name: 'Approve'` 匹配到了。

实际执行顺序：
1. `.first()` 找到 "Review & approve" 按钮（它在 DOM 里在 Modal 的 Approve 之前）
2. `.click()` 打开了 Modal
3. Modal 里有 Approve 按钮，加上 "Review & approve" 本身，共 2 个匹配
4. `toHaveCount(0)` 失败

### 解决方案

用 `exact: true` 区分精确匹配，并补全 Modal 内的操作步骤：

```typescript
// 修复后的 e2e
const reviewApprove = page.getByRole('button', {
  name: 'Review & approve', exact: true
}).first();
await expect(reviewApprove).toBeVisible({ timeout: 10000 });

await reviewApprove.click();  // 打开 Modal

const approveInModal = page.getByRole('button', {
  name: 'Approve', exact: true
}).first();
await expect(approveInModal).toBeVisible({ timeout: 5000 });
await approveInModal.click();  // Modal 内确认

// 此后 "Review & approve" 应该消失（gate 已 approved）
await expect(page.getByRole('button', {
  name: 'Review & approve', exact: true
})).toHaveCount(0, { timeout: 10000 });
```

**教训**：Playwright 的按钮查询默认是模糊匹配。
当页面里有含义相关的多个按钮（Review / Approve / Review & approve）时，
一定要用 `{ exact: true }` 或更精确的 `data-testid` 定位。

---

## 第 8 幕：前端渲染——类型系统如何指导组件设计

### 设计思路

ReviewModal 原来只有一种渲染路径：把内容当 markdown 渲染。

Phase 4 之后有三种：

```
artifact.kind === 'deploy-checklist'  →  DeployChecklistView
artifact.kind === 'ops-report'        →  OpsReportView
其他（markdown 或 null）              →  ReactMarkdown
```

这个三路分支直接对应了 `Artifact` 的判别联合体——**后端的 kind 字段成了前端的
分支判断依据**，类型对齐不需要额外协议约定。

### 治理字段的 UI 映射

`DeployChecklistItem.governanceFlag` 有三种值：`'pci'`、`'gdpr'`、`'none'`。
PCI/GDPR 在 SAP 蓝图里是必须醒目显示的合规标记，用不同颜色的徽章：

```tsx
const GOVERNANCE_BADGE: Record<string, string> = {
  pci:  'bg-yellow-400/20 text-yellow-200',  // 黄色 = 支付合规
  gdpr: 'bg-purple-400/20 text-purple-200',  // 紫色 = 数据隐私
  none: '',
};
```

`OpsReportArtifact.logsSanitized` 是 OPS 的核心治理门控。
`false` 的情况用红色警告框，让审批者在点击 Approve 之前一定会注意到：

```tsx
{!artifact.logsSanitized && (
  <p className="text-xs text-red-300 bg-red-400/10 rounded-lg px-3 py-2">
    Governance: 日志必须脱敏后才能将此 artifact 标为完成。
  </p>
)}
```

注意：Phase 4 **不阻止** `logsSanitized: false` 的 artifact 被记录，
只是在 Dashboard 上醒目展示。阻止逻辑（hard gate）留给 Phase 5 实现，
因为那时 OPS 才会真正被自动化——提前加强制检查会让 Phase 4 的测试更复杂，
收益不成比例。

### api.ts 的类型补全

`getArtifact` 的返回类型从：
```typescript
json<{ stageId: StageId; content: string }>
```
改为：
```typescript
json<{ stageId: StageId; content: string; artifact: Artifact | null }>
```

这让 TypeScript 在整个前端代码里都能推断 `artifact.kind`，
而不是在每处访问时都做 `(artifact as any).kind` 断言。

---

## 总结：Phase 4 的核心收获

### 架构层面

1. **判别联合体是结构化扩展的最优解**：新增 artifact kind 只需增加一个 zod schema，
   所有 `switch/if` 分支处的类型缺失会在编译期报错，不会遗漏。

2. **Input type 和 Domain type 要分开**：`ArtifactInput`（调用方视角，省略系统生成的字段）
   和 `Artifact`（完整存储对象）是两个独立的类型，不要用 `Omit` 从一个推导另一个。

3. **SCHEMA_VERSION 是迁移安全网**：版本从 1 升到 2，任何读取旧格式文件的代码
   在 zod 验证时都会明确报错，而不是静默地用旧格式行事。

### 工程层面

4. **const 声明顺序很重要**：zod schema 之间的相互引用必须遵守 JavaScript 的执行顺序，
   违反时会遇到 temporal dead zone 错误。在 TypeScript 里 `function` 可以前向引用，
   但 `const` 不行。

5. **`Omit` on Union 类型几乎总是错误的**：它不会按你期望的方式分布，
   结果往往是一个几乎没有属性的交叉类型。需要"去掉某些字段"时，直接写新 type。

6. **E2E 测试的按钮定位要用 `exact: true`**：Playwright 的默认子串匹配在
   页面含多个语义相关按钮时很危险，`exact: true` 是防御性最佳实践。

7. **API 测试避免用 `toEqual` 匹配整个响应体**：接口响应可能增加字段，
   用 property-by-property 断言更稳健。

### 设计原则体现

Phase 4 的每一处实现都在贯彻同一条原则：
**让类型系统承担尽可能多的约束，而不是靠人记住运行时规则。**

- `ArtifactSchema` 的 discriminated union 让 TypeScript 替你检查 kind
- `ArtifactInput` 让 SpecStore 负责路径/ID 生成，调用方无需关心
- `OpsReportArtifact.logsSanitized` 是 `boolean`（必填），而不是 `boolean | undefined`，
  意味着 Claude 在调用 `record_ai_output` 时必须显式声明这个治理状态，不能忘记
