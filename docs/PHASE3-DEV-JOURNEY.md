# Phase 3 实现纪实：DEVELOP 子任务清单

这篇文档记录 Phase 3 的**完整思考过程**——从读需求到写代码，包括遇到的每一个 Bug、
为什么这样设计、以及做了哪些权衡。目标读者是"想把这个项目变成自己的"的你。

姊妹篇：`PHASE1-DEV-JOURNEY.md`（v1 架构决策）、`PHASE2-DEV-JOURNEY.md`（Phase 2 子代理模板生成）、`LEARN-TYPESCRIPT.md`（TypeScript 语法）。

---

## 第 0 幕：Phase 3 要解决什么问题

Phase 1 给 DEVELOP 阶段留了一个空占位符：

```typescript
// src/core/stage-machine.ts
if (id === 'develop') stage.subtasks = [];
```

```typescript
// src/core/schemas.ts
subtasks: z.array(SubtaskSchema).optional(),
```

数据结构在，但没有任何逻辑——你无法添加任务、勾选任务，`aiStatus` 永远是 `'stubbed'`。

**Phase 3 的目标**：让这个清单"活"起来：
1. 可以批量设置子任务列表（Claude 生成，或人工录入）
2. 可以逐条勾选/取消勾选
3. `aiStatus` 自动推导：全部勾选 → `done`，有未完成 → `in_progress`
4. **Gate 规则不变**：人类在 Dashboard 批准之前，`advance_stage` 依然拒绝——子任务清单影响的是 `aiStatus`，不是 `gate`

这是一个**自洽的领域扩展**：只加新行为，不破坏现有规则。

---

## 第 1 幕：读懂现有代码，找到接缝点

动手前把以下文件**全部读一遍**，弄清每一层的职责（这是 Phase 2 已经总结的习惯，继续保持）：

| 文件 | 关键发现 |
|------|---------|
| `src/core/schemas.ts` | `SubtaskSchema` 已有 `id, description, completed`；Phase 3 要加 `prompt` 和 `requirementRef` |
| `src/core/stage-machine.ts` | 纯函数，不做 I/O；现有方法模板：`mutateStage()` + `structuredClone` |
| `src/core/app-core.ts` | `mutate → persist → emit` 的三步模式；所有 public 方法都遵循此模式 |
| `src/mcp/server.ts` | 薄 transport，只做参数校验和错误包装，不含业务逻辑 |
| `src/dashboard/server.ts` | 同上，REST 端点全部委托给 AppCore |
| `dashboard_frontend/src/App.tsx` | `SpecCard` 组件渲染单张卡片；DEVELOP 列没有任何特殊处理 |

**找到需要改动的接缝（按依赖顺序，下层先改）：**

```
schemas.ts              ← 1. 扩展 SubtaskSchema
stage-machine.ts        ← 2. 添加 setSubtasks, toggleSubtask, deriveAiStatus
app-core.ts             ← 3. 添加 setDevelopSubtasks, toggleSubtask（orchestration）
mcp/server.ts           ← 4. 注册 set_develop_subtasks, toggle_subtask 工具
dashboard/server.ts     ← 5. 添加 PUT /develop/subtasks, PATCH .../toggle
App.tsx + api.ts        ← 6. DevelopSubtasks 组件 + API 方法
```

这个顺序是**由依赖关系决定的**：schema 是基础，StageMachine 用 schema，AppCore 用 StageMachine，transport 层用 AppCore，前端用 HTTP API。

---

## 第 2 幕：先写测试（TDD），再写实现

Phase 3 严格遵循"**inside-out TDD**"：先写测试定义接口，再写实现让测试通过。

### 为什么 TDD 在这里特别有价值？

`aiStatus` 的派生规则有多条，很容易漏掉边界情况：

- 全部完成 → `done`
- 部分完成 → `in_progress`
- 没有任务 → 状态不变
- `aiCapability === 'stub'` 时 → 状态永远不变
- 从 `done` 反勾一个 → 回到 `in_progress`

如果先写实现，很容易觉得"差不多了"就停下。先写测试，每条规则对应一个 `it`，漏掉任何一条你都会看到红灯。

### 测试的组织结构

```
StageMachine subtask methods (Phase 3)
├── setSubtasks
│   ├── 替换列表
│   ├── 分配唯一 id
│   ├── 新任务初始为未完成
│   ├── 保留 prompt 和 requirementRef
│   ├── 保留顺序
│   ├── 非 develop 阶段抛错
│   └── 更新 updatedAt
├── toggleSubtask
│   ├── false → true
│   ├── true → false
│   ├── 只改目标任务，不改其他
│   ├── 未知 id 抛错
│   └── 更新 updatedAt
└── 从 subtasks 派生 aiStatus
    ├── 空列表 → 保持 stubbed
    ├── 有任务但没完成 → in_progress
    ├── 全部完成 → done
    ├── 反勾 → 从 done 回到 in_progress
    └── gate 规则不变：即使 aiStatus=done，advance 仍需 gate=approved
```

**一共 17 个新的 StageMachine 测试**，全部写在 `src/core/stage-machine.test.ts`，
追加在现有 `advance` 测试块之后。

---

## 第 3 幕：StageMachine 的实现细节

### 引入 `randomUUID`

给每个 subtask 分配 UUID，用 Node.js 内置的 `crypto.randomUUID()`，不需要额外依赖：

```typescript
import { randomUUID } from 'crypto';

// 在 setSubtasks 里
stage.subtasks = inputs.map((t) => ({
  id: randomUUID(),
  description: t.description,
  completed: false,
  prompt: t.prompt,
  requirementRef: t.requirementRef,
}));
```

**为什么不用递增的数字 id？** 因为 subtask 可能被前端或 MCP 工具引用（通过 `toggle_subtask` 传 id），
数字 id 在"替换整个列表"操作后会重复，UUID 不会。

### `deriveAiStatus`：私有辅助方法的设计

派生逻辑只有 4 行，但被两个方法调用（`setSubtasks` 和 `toggleSubtask`），提取为私有方法避免重复：

```typescript
private deriveAiStatus(stage: Stage): void {
  if (stage.aiCapability === 'stub') return;  // stub 阶段不推导
  const tasks = stage.subtasks ?? [];
  if (tasks.length === 0) return;             // 没有任务，不改状态
  stage.aiStatus = tasks.every((t) => t.completed) ? 'done' : 'in_progress';
}
```

**关键设计决策——`stub` 阶段不推导：**

Phase 5 之前，`develop` 的 `aiCapability` 是 `'stub'`，意味着这个阶段的 AI 能力还没接好。
此时 `aiStatus = 'stubbed'` 是"已知的未接入"状态，让它响应 subtask 变化没有意义，
反而会引起混乱（`aiStatus` 变成 `done` 但 capability 仍是 stub）。

只有 Phase 5 把 `aiCapability` 切换为 `'auto'` 后，`deriveAiStatus` 才真正生效。

### `mutateStage` 的复用

`setSubtasks` 和 `toggleSubtask` 都利用了现有的 `mutateStage` 私有方法：

```typescript
private mutateStage(
  spec: SpecFile,
  stageId: StageId,
  fn: (next: SpecFile, stage: Stage) => void
): SpecFile {
  const next = structuredClone(spec);    // 深拷贝，保持纯函数语义
  const stage = next.stages.find((s) => s.id === stageId);
  if (!stage) throw new Error(`Unknown stage: ${stageId}`);
  fn(next, stage);
  next.updatedAt = now();
  return next;
}
```

`structuredClone` 是这里的关键——因为 StageMachine 是纯函数（不改入参），
用 `structuredClone` 做深拷贝，改 `next` 不影响原来的 `spec`。

---

## 第 4 幕：AppCore 的 orchestration 层

AppCore 的两个新方法完全遵循已有的 `mutate → persist → emit` 模式，
和现有的 `approve`、`reject` 方法结构一模一样：

```typescript
async setDevelopSubtasks(
  repoId: string,
  ticketId: string,
  subtasks: Array<{ description: string; prompt?: string; requirementRef?: string }>
): Promise<SpecFile> {
  const path = await this.repoPath(repoId);
  const spec = await this.requireSpec(path, ticketId);
  return this.persist(repoId, path, this.stageMachine.setSubtasks(spec, subtasks));
  //                                ↑ mutate（纯函数） ↑
  // ↑ persist（写盘 + emit 事件）
}
```

`persist` 私有方法负责：
1. 用 `SpecStore.write` 原子写入磁盘
2. 发出 `spec.updated` 事件
3. EventBus 把这个事件广播给所有 WebSocket 连接

这意味着：每次 toggle 一个 subtask，浏览器里的所有标签页**自动刷新**，不需要前端轮询。

---

## 第 5 幕：遇到的 Bug 及解决方式

### Bug 1：Edit 工具写入了 Unicode 弯引号

**错误信息：**
```
[vite:esbuild] Transform failed with 1 error:
/Users/.../App.tsx:333:19: ERROR: Expected "{" but found """
```

**表面现象：** esbuild 报 JSX 语法错误，但是肉眼看代码完全正常。

**排查过程：**

第一反应是找"特殊字符"。在终端用 Python 扫描文件里的非 ASCII 字节：

```python
with open('App.tsx', 'rb') as f:
    content = f.read()
for i, line in enumerate(f, 1):
    for j, b in enumerate(line):
        if b > 127:
            print(f'Line {i}, col {j+1}: byte 0x{b:02x}')
```

发现了大量 `0xe2 0x80 0x9d`——这是 UTF-8 编码的 Unicode **右双引号**（`"`，U+201D），
不是 ASCII 直双引号（`"`，U+0022）。

**原因：** Edit 工具在把新代码块写入 App.tsx 时，将代码里的直引号替换成了弯引号
（这是编辑器或工具的"智能引号"功能导致的）。JSX 的 `className=""` 需要 ASCII 直引号，
弯引号对 JSX 解析器来说是陌生字符，所以 esbuild 崩了。

这类问题的特点是：
- 肉眼看不出来（弯引号和直引号在字体里极其相似）
- `tsc --noEmit` **不会报错**（TypeScript 编译器对部分 Unicode 字符是容忍的）
- 只有 esbuild 在把 JSX 转译为 JS 时才会崩

**解决方法：** 用 Python 把文件里所有弯引号批量替换回 ASCII 直引号：

```python
with open('App.tsx', 'rb') as f:
    content = f.read()

content = content.replace(b'\xe2\x80\x9c', b'"')  # 左弯双引号 "
content = content.replace(b'\xe2\x80\x9d', b'"')  # 右弯双引号 "
content = content.replace(b'\xe2\x80\x98', b"'")  # 左弯单引号 '
content = content.replace(b'\xe2\x80\x99', b"'")  # 右弯单引号 '

with open('App.tsx', 'wb') as f:
    f.write(content)
```

**教训：**
1. 当 esbuild/Vite 报"Expected `{` but found `"`"时，不要只看行号——很可能是 Unicode 引号问题。
2. `tsc --noEmit` 通过**不代表**前端能构建成功，JSX 需要 `npm run build` 才能完整验证。
3. 对于前端文件，每次 Edit 后要跑 `npm run build`，不只是 `tsc`。
4. 排查非 ASCII 字符，Python 的二进制读取比任何编辑器都可靠。

---

### Bug 2（潜在）：AppCore 测试访问私有成员

在写 AppCore 的 `aiStatus=done` 测试时，有一个初稿想直接操作私有字段来构造测试场景：

```typescript
// 初稿（不好）：直接修改内部状态，绕过业务规则
spec!.stages.find((s) => s.id === 'develop')!.aiCapability = 'auto';
await app['store'].write(await app['repoPath'](repoId), spec!);
```

这样写的问题：
1. 用 `app['store']`、`app['repoPath']` 访问私有成员——TypeScript 通过，但语义上违反了封装原则
2. 直接写磁盘绕过了 `EventBus`，破坏了不变量 #2
3. 测试依赖了实现细节，未来重构会导致测试碎掉

**修正思路：** 测试要通过**公开 API** 来构造场景，不能触碰私有成员。

对于"当 aiCapability=stub 时，toggle 不改变 aiStatus"这条规则，直接测 stub 路径就够了：

```typescript
it('aiStatus stays stubbed when capability is stub', async () => {
  // 默认的 develop 阶段就是 stub，不需要任何特殊准备
  let spec = await app.setDevelopSubtasks(repoId, 'TASK-1', [{ description: 'Only one' }]);
  const id = spec.stages.find((s) => s.id === 'develop')!.subtasks![0].id;
  spec = await app.toggleSubtask(repoId, 'TASK-1', id);
  // stub 时 aiStatus 不变，仍是 'stubbed'
  expect(spec.stages.find((s) => s.id === 'develop')!.aiStatus).toBe('stubbed');
});
```

**教训：** 好的测试只测行为，不测实现细节。如果你发现自己需要 `app['privateField']`，
通常意味着测试场景设计有问题——找一个能通过公开 API 复现同样场景的方式。

---

## 第 6 幕：MCP 工具的设计

### 为什么 `set_develop_subtasks` 用"替换整个列表"而不是"追加/删除单个"

两种设计对比：

**方案 A：细粒度 CRUD（add_subtask, remove_subtask, toggle_subtask）**
```
add_subtask(repoId, ticketId, description, prompt?)
remove_subtask(repoId, ticketId, subtaskId)
toggle_subtask(repoId, ticketId, subtaskId)
```

**方案 B：批量替换 + 单条 toggle（set_develop_subtasks, toggle_subtask）**
```
set_develop_subtasks(repoId, ticketId, subtasks[])   ← 替换整个列表
toggle_subtask(repoId, ticketId, subtaskId)           ← 单条状态切换
```

**选方案 B 的理由：**

- Claude 生成子任务列表时，一次性给出所有任务是自然的——它不会"一条一条地思考"。
  方案 A 意味着 Claude 要调用 N 次工具，N 次 MCP 往返。
- 批量替换在语义上更清晰：旧列表作废，新列表取代它。不存在"插入顺序"的歧义。
- `toggle` 是**人类操作**，一次只改一条，细粒度是合理的。
- 这个模式和 HTTP 的 PUT（替换资源）+ PATCH（局部更新）语义一致。

**实现细节——为什么 toggle 不接受 `completed: boolean` 参数**

两种设计：

```typescript
toggleSubtask(subtaskId)              // 永远取反
setSubtaskCompleted(subtaskId, bool)  // 显式设置
```

选"取反"的理由：
- 消除了"前端状态和服务端状态不一致"的竞争条件——你不需要知道当前是什么状态，
  直接说"切换"，服务端计算结果。
- 更少的参数，更少的犯错机会。

**代价**：如果两个人同时点同一个 checkbox，状态会 toggle 两次（回到原样）。
对这个工具的使用场景（单人工作台），这个问题不存在。

---

## 第 7 幕：Dashboard HTTP 端点的 URL 设计

Phase 3 新增了两个端点：

```
PUT   /api/repos/:repoId/specs/:ticketId/develop/subtasks
PATCH /api/repos/:repoId/specs/:ticketId/develop/subtasks/:subtaskId/toggle
```

**为什么 URL 里有 `/develop/`？**

`subtasks` 是 `develop` 阶段特有的，其他 7 个阶段没有。
把 `/develop/` 放进路径：
1. 明确表达"这个操作属于 develop 阶段"
2. 如果未来其他阶段也需要类似的子结构，可以加 `/test/subtasks` 而不冲突
3. 防止误操作——试图给 `spec` 阶段设置 subtasks 会 404，不会悄悄通过

**为什么用 `PATCH .../toggle` 而不是 `PATCH .../subtasks/:id`？**

`/toggle` 是一个动词端点——它执行一个动作（切换），而不是更新资源的某个字段。
这在 REST 纯粹主义者眼里不够"RESTful"，但在实践中更清晰：

```http
PATCH /develop/subtasks/:id/toggle    ← 清楚：这是"切换"
PATCH /develop/subtasks/:id  body: { completed: true }  ← 隐式前提：客户端知道当前状态
```

在这个场景下，语义清晰 > RESTful 纯粹性。

---

## 第 8 幕：前端 DevelopSubtasks 组件的设计选择

### 只在 DEVELOP 列展开

`DevelopSubtasks` 只在 `stageId === 'develop'` 时渲染，其他列的 `SpecCard` 不受影响：

```tsx
{stageId === 'develop' && (
  <DevelopSubtasks repoId={repoId} spec={spec} />
)}
```

**为什么不抽象成"任何阶段都可以有 subtasks"？**

过度抽象的陷阱：现在只有 `develop` 用 subtasks，其他阶段没有对应的数据字段。
如果做成通用组件，要加很多"如果这个阶段没有 subtasks 就不渲染"的保护代码，反而复杂。

等未来其他阶段真的需要 subtasks，再重构也不迟。YAGNI（You Ain't Gonna Need It）原则。

### "添加任务"的交互设计

添加新任务的操作是：**把现有任务 + 新任务**拼合成一个新列表，调用 `setSubtasks` 替换整个列表。

```tsx
await api.setSubtasks(repoId, spec.ticketId, [
  ...subtasks.map((t) => ({
    description: t.description,
    prompt: t.prompt,
    requirementRef: t.requirementRef,
  })),
  { description: desc },  // 新任务追加到末尾
]);
```

注意：这里只传 `description, prompt, requirementRef`，不传 `id` 和 `completed`——
因为 `setSubtasks` 会给所有任务重新分配 UUID，并把 `completed` 初始化为 `false`。

**潜在问题：** 如果用户在填写新任务的过程中，后端通过 WebSocket 更新了 `spec`（比如有人 toggle 了另一条任务），那么前端的 `spec.stages.find('develop').subtasks` 就是新的，添加操作不会丢失已有的 toggle 状态——因为前端展示的始终是 WebSocket 推送来的最新 `spec`，`setSubtasks` 发出后，WS 会再推一次最新状态。

### 进度条颜色继承自主题

子任务列表上方有一条迷你进度条（高度 `h-1`，比 spec 卡片的 `h-1.5` 更细），
使用 `joule-gradient` 类，和全局进度条保持视觉一致性：

```tsx
<div
  className="h-full joule-gradient transition-all"
  style={{ width: `${Math.round((doneCount / subtasks.length) * 100)}%` }}
/>
```

`transition-all` 让宽度变化有动画效果，勾选任务时进度条平滑地向右延伸。

---

## 第 9 幕：验证流程

Phase 3 的验证顺序和 Phase 2 相同，但重点提醒：

```bash
npx tsc --noEmit    # 后端类型检查
npm test            # 116 个测试全绿
npm run build       # 含前端构建（这步才能发现 JSX/esbuild 问题！）
npm run test:e2e    # 端到端（在 build 产物上跑）
```

**重要提醒（来自本次的 Bug 1）：**

`tsc --noEmit` 只检查 `.ts` 文件的类型。前端 JSX 的非 ASCII 字符问题，
只有 `npm run build`（触发 Vite/esbuild 的 JSX 转译）才能发现。

所以验证流程里**不能跳过 `npm run build`**，即使后端改动看起来和前端无关。

---

## 第 10 幕：Phase 3 完成后的代码地图

**修改的文件（无新建文件）：**

```
src/
├── core/
│   ├── schemas.ts          ← SubtaskSchema 加了 prompt?, requirementRef?
│   │                          新增 SetDevelopSubtasksInputSchema, ToggleSubtaskInputSchema
│   ├── stage-machine.ts    ← setSubtasks(), toggleSubtask(), deriveAiStatus()（私有）
│   └── app-core.ts         ← setDevelopSubtasks(), toggleSubtask()
├── mcp/
│   └── server.ts           ← 工具 set_develop_subtasks, toggle_subtask
└── dashboard/
    └── server.ts           ← PUT .../develop/subtasks, PATCH .../toggle

dashboard_frontend/src/
├── types.ts                ← Stage.subtasks 的元素类型加了 prompt?, requirementRef?
├── api.ts                  ← setSubtasks(), toggleSubtask() API 方法
└── App.tsx                 ← DevelopSubtasks 组件，SpecCard 里条件渲染
```

**典型用法（通过 MCP 工具）：**

```
1. Claude 对 DEVELOP 阶段有了理解后，调用：
   set_develop_subtasks(repoId, 'TICKET-123', [
     { description: '添加 ProductController CRUD 端点', prompt: '参考 CategoryController 的实现风格' },
     { description: '补充 ProductService 的单元测试', requirementRef: 'REQ-4.2' },
     { description: '更新 API 文档' },
   ])

2. 开发者在浏览器看板的 DEVELOP 列里，逐条勾选完成的子任务
   → 每次勾选，DashBoard 调用 PATCH .../toggle
   → AppCore 更新磁盘、触发 EventBus
   → 所有连接的浏览器收到 spec.updated 事件，实时刷新

3. 全部勾选后，aiStatus 变为 done（仅当 aiCapability=auto 时）
   Gate 状态此时仍是 not_ready；人类需要在 Dashboard 点 Approve 才能推进阶段
```

**测试统计：**
- Phase 1: 63 tests
- Phase 2: ~90 tests（+新增了 introspector、templates、MCP 模板工具测试）
- Phase 3: **116 tests**（新增 17 个 StageMachine 测试 + 4 个 AppCore 测试 + 3 个 MCP 测试 + 5 个 Dashboard 测试）

---

## 总结：对未来你自己最有用的几条

1. **"接缝点"比代码更重要。** Phase 3 没有新建任何文件，全部是在已有接缝处扩展。
   读代码的目的就是找到这些接缝：哪里是占位符、哪里是扩展点。

2. **`stub` 阶段的 aiCapability 不是摆设，是架构契约。**
   `deriveAiStatus` 检查 `aiCapability !== 'stub'` 是有意为之——让 Phase 3 的逻辑
   在 Phase 5 把 `aiCapability` 切换为 `'auto'` 之前完全静默，不干扰现有行为。

3. **`structuredClone` 是纯函数的守门人。**
   StageMachine 的每个方法都从 `structuredClone(spec)` 开始，永远不改入参。
   这使得测试可以在同一个 `spec` 上尝试多个操作而不互相干扰。

4. **Unicode 弯引号是 JSX 的隐形杀手。** `tsc` 不报错，但 esbuild 会崩。
   发现原因的工具是二进制扫描（Python `rb` 读取），不是编辑器。
   修复工具是批量字节替换，不是手动编辑。

5. **好测试通过公开 API 构造场景，不碰私有成员。** 如果你需要 `app['privateField']`，
   那是测试场景设计有问题的信号，不是 TypeScript 访问控制该绕过的。

6. **"替换整个列表"有时比"细粒度 CRUD"更简单、更安全。**
   Claude 生成任务列表是批量操作，用一次 `set_develop_subtasks` 比
   N 次 `add_subtask` 调用更自然，也避免了部分成功/部分失败的中间状态问题。
