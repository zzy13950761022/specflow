# Phase 2 实现纪实:Sub-Agent 仓库提示词生成器

这篇文档记录 Phase 2 的**完整思考过程**——从读需求到写代码，包括遇到的每一个 Bug、
为什么这样设计、以及做了哪些权衡。目标读者是"想把这个项目变成自己的"的你。

姊妹篇：`PHASE1-DEV-JOURNEY.md`（Phase 1 的决策过程）、`LEARN-TYPESCRIPT.md`（TypeScript 语法）。

---

## 第 0 幕：Phase 2 要解决什么问题

Phase 1 里有一个**声明过但故意没实现**的"seam"（接缝）：

```typescript
// src/prompts/templates.ts
async generateCuratedTemplate(_repoPath: string, _stageId: StageId): Promise<never> {
  throw new Error('Sub-agent template generation is not implemented in v1.');
}
```

这个方法的意图是：让一个 AI 子代理检查仓库（build 文件、测试框架、CLAUDE.md）后，
自动为该仓库生成 8 个阶段的提示词模板，取代通用的"[placeholder]"占位符。

**为什么这么重要？** 设计文档里有一句核心原则：
> *"auto-generation is a starting point, not a finish line; high-quality AI config requires curation."*
> （自动生成是起点，不是终点；高质量的 AI 配置需要人工打磨。）

也就是说，Phase 2 要构建的不是"全自动生成"，而是：
1. 机器**侦察**仓库特征，生成一份"简报"（RepoBrief）
2. AI 代理（Claude）根据简报**草拟**模板，写入磁盘
3. 人类**审核并标记**为 curated（已打磨）
4. 工具链只使用 curated 模板

这个流程直接体现了"人在回路"的设计原则。

---

## 第 1 幕：读懂现有代码再动手

动手前做了一件事：**系统性地阅读 Phase 1 的所有核心文件**，弄清楚每一层的职责。

### 已有的分层结构

```
MCP server (stdio)         ← Claude 代理通过这里调用工具
      ↓
  AppCore (单例)            ← 所有业务逻辑汇聚点，唯一的门
      ↓
StageMachine (纯函数)      ← 状态转换，不做 I/O
SpecStore (磁盘 I/O)       ← 原子写入，zod 校验
PromptTemplates            ← 解析/渲染提示词模板
RepoRegistry               ← 仓库索引
      ↓
EventBus (事件总线)         ← 变更通知，fan-out 给 WebSocket
```

**关键不变量**（这是"不能破坏的规则"）：
- **不变量 #1**：stdout 只能有 JSON-RPC 帧。任何 `console.log` 都会破坏 MCP 协议。
- **不变量 #2**：文件是真相来源。所有写操作必须经过 `mutate → persist → emit`。
- **Gating 不变量**：`advance_stage` 在 gate 未 approved 前必须拒绝。

### 找到接缝点

Phase 2 需要改动的地方（按依赖顺序）：

| 顺序 | 文件 | 改什么 |
|------|------|--------|
| 1 | `src/prompts/template-defaults.ts`（新建） | 把 BLUEPRINT_DEFAULTS 提取出来共享 |
| 2 | `src/core/repo-introspector.ts`（新建） | 仓库特征侦察，纯函数 |
| 3 | `src/prompts/templates.ts` | 实现 seam，添加 write/curate/list |
| 4 | `src/core/app-core.ts` | 添加 4 个新方法 |
| 5 | `src/mcp/server.ts` | 添加 2 个新 MCP 工具 |
| 6 | `src/dashboard/server.ts` | 添加模板 REST 端点 |
| 7 | `dashboard_frontend/src/` | 添加 Prompts 面板 |

这个顺序是**由依赖关系决定的**：下层先改，上层后改。

---

## 第 2 幕：TDD —— 先写测试，再写实现

IMPLEMENTATION-PLAN.md 明确要求"TDD, inside-out"：先写测试，再写实现，再接线传输层。

### 为什么要先写测试？

有一个很实际的原因：**测试定义了接口**。在写 `repo-introspector.ts` 之前，先写测试，
就迫使你想清楚这个函数应该返回什么类型、叫什么字段。

```typescript
// 测试先写，定义了 RepoBrief 的形状：
it('returns all required fields', async () => {
  const brief: RepoBrief = await introspectRepo(repo);
  expect(brief).toHaveProperty('repoPath');
  expect(brief).toHaveProperty('buildTool');
  expect(brief).toHaveProperty('testFramework');
  expect(brief).toHaveProperty('claudeMd');
  expect(brief).toHaveProperty('sampleFile');
  expect(brief).toHaveProperty('blueprintDefaults');
});
```

这比先写实现、再补测试更清晰，因为你在**使用者视角**而不是**实现者视角**设计接口。

### 测试的组织方式

遵循 Phase 1 的规范：每个 `describe` 测一个独立的行为维度：

```
introspectRepo — build tool detection   (6 个 it)
introspectRepo — test framework detection (5 个 it)
introspectRepo — CLAUDE.md              (2 个 it)
introspectRepo — sample source file     (2 个 it)
introspectRepo — RepoBrief shape        (2 个 it)
```

每个 `it` 只测一件事，失败信息一眼看出哪里出了问题。

---

## 第 3 幕：提取共享常量 —— template-defaults.ts 的由来

一开始，`BLUEPRINT_DEFAULTS`（8 个阶段的默认模板内容）只存在于 `templates.ts`。
但 `repo-introspector.ts` 也需要它（要把默认模板附在 RepoBrief 里，供 Claude 参考）。

**两个选项：**
1. 在 `repo-introspector.ts` 里直接 import `templates.ts`
2. 把常量提取到独立文件 `template-defaults.ts`

选项 1 产生**循环依赖**的风险：`templates.ts` 会 import `repo-introspector.ts`
（`generateCuratedTemplate` 里调用了它），而 `repo-introspector.ts` 再 import
`templates.ts`，就形成了环。

选项 2 干净：常量文件不依赖任何人，任何人都可以 import 它。

**教训：当两个模块都需要同一份数据时，提取到第三个"叶子"模块。**

```
template-defaults.ts  ←── repo-introspector.ts
        ↑
  templates.ts
```

---

## 第 4 幕：source 枚举的演化

### v1 的 source

```typescript
// Phase 1 里只有两种来源
source: 'repo' | 'blueprint-default'
```

### Phase 2 的 source

```typescript
// Phase 2 引入"草稿"状态
source: 'repo-curated' | 'repo-draft' | 'blueprint-default'
```

**为什么需要 `repo-draft`？**

因为 AI 写完模板后，人类还没审核。这时磁盘上有文件，但不能盲目信任它。
用 `repo-draft` 标记"这是 AI 草稿"，和 `repo-curated`（人工确认）区分开来。

### 如何持久化 curated 状态？

模板内容存在 `{stageId}.md`，curated 状态存在**伴生文件** `{stageId}.meta.json`：

```json
{ "curated": true }
```

这比把 metadata 和内容混在一起更干净，也不需要改 spec 文件的 schema。
resolve 时的逻辑：

```typescript
const templateContent = await fs.readFile(templatePath).catch(() => null);
if (templateContent !== null) {
  const meta = await this.readMeta(repoPath, stageId);
  const source = meta?.curated ? 'repo-curated' : 'repo-draft';
  return { stageId, content: templateContent, source };
}
// 没有文件 → blueprint-default
```

---

## 第 5 幕：repo-introspector.ts 的实现细节

### Build tool 检测

优先级顺序很重要（先检查更"具体"的）：

```typescript
if (await exists(join(repoPath, 'pom.xml'))) return 'maven';
if (await exists(join(repoPath, 'build.gradle'))) return 'gradle';
if (await exists(join(repoPath, 'package.json'))) return 'npm';
if (await exists(join(repoPath, 'setup.py'))) return 'python';
return 'unknown';
```

为什么 maven 在 gradle 前面？因为有些项目会同时存在 Maven wrapper 和 Gradle wrapper，
但真正的构建文件 `pom.xml` 比 `build.gradle` 更具决定性。

### Test framework 检测

从 build tool 的结果出发，去对应的配置文件里找关键词：

```typescript
if (buildTool === 'npm') {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps['vitest']) return 'vitest';
  if (deps['jest']) return 'jest';
}
if (buildTool === 'maven') {
  if (pom.includes('junit')) return 'junit';
}
```

**注意顺序**：vitest 优先于 jest，因为很多用 vitest 的项目也会因为兼容性把 jest 列在
devDependencies 里。

### 采样源文件

目的是给 Claude 一段"你们的代码长什么样"的参考：

```typescript
const SOURCE_DIRS = ['src', 'lib', 'app', 'source'];
const SOURCE_EXTENSIONS = { npm: ['.ts', '.tsx', ...], maven: ['.java', '.kt'], ... };
```

遍历 `src/` 等目录，找到第一个有内容的源文件，截取前 2000 字符。
截取是为了避免把整个大文件塞进 RepoBrief。

---

## 第 6 幕：遇到的 Bug 及解决方式

### Bug 1：`readdir` 的 `recursive` 选项类型错误

**错误信息：**
```
error TS2322: Type 'Dirent<NonSharedBuffer>[]' is not assignable to type 'Dirent<string>[]'
```

**原因：** Node.js 18+ 给 `fs.readdir` 加了 `{ recursive: true }` 选项，但 TypeScript
的类型定义和 Node.js 实际返回值之间有出入（`Dirent` 的泛型参数类型不匹配）。

**尝试的方案（失败）：**
```typescript
// 强制转型，但 TypeScript 仍然不满意
entries = await fs.readdir(dirPath, { withFileTypes: true, recursive: true } as Parameters<...>[1]);
```

**最终解决方案：** 改用手写递归，绕开这个 API：

```typescript
async function collectFiles(dirPath: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectFiles(fullPath).catch(() => []);
      results.push(...sub);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}
```

**教训：** 当一个 API 的类型定义和实际行为不对齐时，不要死磕强制转型，
换一个等价实现往往更清晰。而且手写递归在这里反而更好控制（可以 `.catch(() => [])` 容错）。

---

### Bug 2：MCP server.ts 工具名丢失

**背景：** 用 Edit 工具在 `record_ai_output` 注册代码之前插入两个新工具。

**错误信息：**
```
error TS2554: Expected 3 arguments, but got 2.
error TS7031: Binding element 'repoId' implicitly has an 'any' type.
```

**原因：** Edit 工具的"在 X 之前插入"操作，把 `record_ai_output` 的工具名字符串
`'record_ai_output'` 误删了，导致 `server.registerTool` 少了第一个参数（工具名）：

```typescript
// 插入后变成这样（错误）：
server.registerTool(
  {              // ← 这里应该先有 'record_ai_output' 字符串，但被删掉了
    description: "Persist Claude's artifact...",
    inputSchema: { ... },
  },
  async ({ repoId, ticketId, stageId, content }) => { ... }
);
```

**修复：** 手动加回工具名：

```typescript
server.registerTool(
  'record_ai_output',   // ← 加回来
  { description: ..., inputSchema: ... },
  async ({ repoId, ... }) => { ... }
);
```

**教训：** 在已有代码块之前插入新代码时，要仔细检查插入边界。
Edit 工具的替换是基于字符串匹配的，如果匹配的字符串恰好是另一块代码的开头，
很容易出现"合并到一起"的情况。**插入后一定要 `tsc --noEmit` 验证。**

---

### Bug 3：dashboard/server.ts 代码结构被破坏

**背景：** 试图在 `/* ---- gates ---- */` 注释处插入模板端点。

**操作：**
1. 第一次 Edit：把注释改成只有注释行（去掉后面的 `fastify.post<{`）
2. 第二次 Edit：在注释后添加模板代码，然后再加 `fastify.post<{`

**结果：** 两次操作之间发生了干扰，导致 `/* ---- gates ---- */` 下面的
`fastify.post<{` 行消失了，gates 路由的开头变成了：

```typescript
/* ---- gates: the human actions ---- */
    Params: { repoId: string; ticketId: string };  // ← 孤立的类型片段！
    Body: { stageId?: string };
```

**根本原因：** 连续的 Edit 操作在"替换字符串"层面产生了意外的交互。

**解决方式：** 直接用 Write 工具重写整个文件。当一个文件被 Edit 搞乱时，
最可靠的方法是**读出当前内容、在脑子里修正、然后 Write 覆盖**，不要再叠加 Edit。

**教训：**
- 多次 Edit 同一个文件时，操作之间要有"读-确认-编辑"的节奏，而不是连续操作。
- 如果一个文件已经结构混乱，不要继续 Edit，直接 Write 重来。
- 操作完之后立刻 `tsc --noEmit`，不要等到最后才发现。

---

### Bug 4：pytest 检测漏洞

**测试失败信息：**
```
AssertionError: expected 'unknown' to contain 'pytest'
Received: "unknown"
```

**测试的场景：** 仓库里只有 `requirements.txt`（包含 `pytest==7.4.0`），
没有 `setup.py` / `pyproject.toml`，所以 `detectBuildTool` 返回 `'unknown'`。

**原来的代码：**
```typescript
if (buildTool === 'python') {   // 只在 python 时检查
  const req = await readOptional(join(repoPath, 'requirements.txt'));
  if (req?.includes('pytest')) return 'pytest';
}
```

**问题：** `buildTool === 'python'` 这个分支需要 `setup.py` 或 `pyproject.toml` 才会触发，
但 `requirements.txt` 是比这些更常见的 Python 项目标志。

**修复：** 把 `requirements.txt` 检查也在 `unknown` 时执行：

```typescript
if (buildTool === 'python' || buildTool === 'unknown') {
  const req = await readOptional(join(repoPath, 'requirements.txt'));
  if (req?.includes('pytest')) return 'pytest';
  // ...
}
```

**教训：** 检测逻辑要从"用户最常遇到的场景"出发，而不是从"最严格的定义"出发。
`requirements.txt` 是 Python 项目最普遍的标志，比 `setup.py` 出现得更早、更频繁。

---

### Bug 5：templates.test.ts 中旧测试期待已过时的值

**失败信息：**
```
AssertionError: expected 'repo-draft' to be 'repo'
```

**原因：** Phase 1 的测试写的是 `expect(resolved.source).toBe('repo')`，
但 Phase 2 把 `'repo'` 拆成了 `'repo-draft'` 和 `'repo-curated'`。

旧测试的场景是：手动在磁盘上写了一个 `.md` 文件，没有 meta 文件。
Phase 2 规则下，这就是 `'repo-draft'`。

**修复：** 把旧测试的期望值从 `'repo'` 改成 `'repo-draft'`，测试描述也同步更新：

```typescript
// 之前
it('prefers a curated <repo>/.specflow/templates/{stage}.md over the default', ...)
expect(resolved.source).toBe('repo');

// 之后
it('prefers a <repo>/.specflow/templates/{stage}.md over the default (repo-draft)', ...)
expect(resolved.source).toBe('repo-draft');
```

**教训：** 更改已有行为时，要主动搜索所有依赖这个行为的测试。
`source: 'repo'` 是一个公开的 API 值，任何使用它的测试都需要更新。
用 `grep` 搜索旧值是个好习惯。

---

### Bug 6：server.test.ts 多出一个多余的 `}`

**错误信息：**
```
ERROR: Unexpected "}"
File: /Users/I605217/ai-pilot/src/mcp/server.test.ts:185:0
```

**原因：** 新测试块插入在 `describe('MCP get_stage_prompt', () => {` 的**开头处**，
相当于把原来的 `describe` 开头吞掉了：

```
// 插入前
describe('MCP get_stage_prompt', () => {
  it('returns ...', ...)
});

// 插入后（错误）：新块内容 + 原来那个 describe 的内容被合并，缺了 describe(
...新测试内容...
});          ← 这个 }) 是原来 describe 的结束，但 describe 开头没了
  it('returns ...')
});           ← 多出来的 }
```

**修复：** 在原来 `it('returns...')` 前补上 `describe('MCP get_stage_prompt', () => {`。

**教训：** 每次在现有 `describe` 块前插入新代码后，检查原来的 `describe` 开头是否还在。
这类"多余括号"错误在 esbuild 转译时报错信息很清晰（会指出行号），但原因不直观。

---

## 第 7 幕：设计决策的权衡

### 决策 1：Node 进程不直接调用 LLM

Phase 2 的设计是：`propose_repo_templates` 只返回**侦察结果**，由 Claude 代理
（已连接的那个）自行草拟，然后用 `write_repo_template` 写回。

**备选方案：** Node 进程里直接调用 Anthropic SDK 生成模板。

**为什么不选备选方案：**
1. **不变量 #1**：Node 进程只能往 stdout 写 JSON-RPC。调用 LLM 的过程中产生的进度日志
   很难完全禁止，有污染 MCP 协议的风险。
2. **责任分离**：Node 进程是状态管理层，不应该知道"怎么写好提示词"。
   Claude 代理层才是生成文字的地方。
3. **可测试性**：一个返回结构化数据的函数比一个调用远程 API 的函数容易测试得多。

### 决策 2：用伴生 meta 文件而不是扩展 spec JSON

存储 curated 状态有两个地方：
1. 每个模板文件旁边放一个 `{stageId}.meta.json`
2. 在 `~/.specflow/registry.json` 或某个仓库级配置文件里统一存

选了方案 1。理由：
- 模板文件和它的 meta 文件在同一目录，一目了然
- 不需要修改已有的 SpecFile schema（不改 `SCHEMA_VERSION`）
- 删除模板文件时，meta 文件自然跟着没意义，不会有孤儿数据

### 决策 3：source 枚举是三态而不是两态

从用户体验角度：看到 `repo-draft` 就知道"这是 AI 写的，还没人审"；
看到 `repo-curated` 就知道"这已经经过人工确认"。
如果只有 `'repo'`，就分不清。

前端的 badge 直接反映了这个状态：
- `blueprint` → 灰色（默认占位符）
- `draft` → 橙色（AI 草稿，待审）
- `curated` → 绿色（已审核，权威）

---

## 第 8 幕：验证流程

每次修改后按固定顺序验证：

```bash
npx tsc --noEmit   # 类型检查（最快，先跑）
npm test           # 单元 + 集成测试
npm run build      # 完整构建（含前端）
npm run test:e2e   # 端到端（依赖 dist/，所以在 build 后）
```

**为什么 tsc 要最先跑？**
因为它最快（不需要启动 Vitest），而且很多逻辑错误在类型层面就能发现，
不用等运行时失败。

**为什么 e2e 要最后跑？**
e2e 测试会 `spawn` 真实的 `dist/index.js`，依赖 `npm run build` 的产物。
如果先跑 e2e 但 build 还是旧版本，会得到假阴性结果。

---

## 第 9 幕：Phase 2 完成后的代码地图

```
src/
├── core/
│   ├── repo-introspector.ts   ← 新建：仓库特征侦察（纯 async，无 I/O 副作用）
│   └── app-core.ts            ← 新增 4 个方法：propose/write/curate/list
├── prompts/
│   ├── template-defaults.ts   ← 新建：BLUEPRINT_DEFAULTS 的独立家
│   └── templates.ts           ← seam 已实现，source 枚举扩展，新增 3 个方法
├── mcp/
│   └── server.ts              ← 新增工具：propose_repo_templates, write_repo_template
└── dashboard/
    └── server.ts              ← 新增端点：GET /templates, POST /templates/:id/curate

dashboard_frontend/src/
├── types.ts                   ← 新增：TemplateSummary, TemplateSource
├── api.ts                     ← 新增：listTemplates, markTemplateCurated
└── App.tsx                    ← 新增：PromptsPanel, TabButton（Board/Prompts 切换）
```

**Phase 2 的典型用法（通过 MCP 工具）：**

```
1. Claude 调用 propose_repo_templates(repoId)
   → 得到 RepoBrief（buildTool: 'maven', testFramework: 'junit', ...）

2. Claude 根据 brief 为每个阶段起草模板，然后调用：
   write_repo_template(repoId, 'test', '# Stage 4 — Testing...\n用 JUnit 5 写...')

3. 人类在 Dashboard 的 Prompts 面板查看草稿，点击"Mark curated"

4. 之后调用 get_stage_prompt 会返回 source: 'repo-curated'，优先于通用默认值
```

---

## 总结：对未来你自己最有用的几条

1. **先画依赖图，再写代码。** 新功能会触及多少层？每层改什么？写出来，从下往上改。

2. **测试先写的真正好处不是"测试覆盖率"，而是"接口设计"。** 从使用者视角写测试，
   你会自然地设计出更好用的 API。

3. **连续 Edit 同一文件时，每次操作后都要确认文件没被破坏。** Edit 是字符串替换，
   不理解代码语义，很容易误操作。有疑问时直接 Write 重来。

4. **当类型系统和标准库的实际行为冲突时，绕开 API 而不是强制转型。**
   `fs.readdir` 的 `recursive` 选项就是个例子，手写递归反而更健壮。

5. **检测逻辑要从"用户最常遇到的场景"出发，而不是"最严格的定义"。**
   Python 项目可能只有 `requirements.txt` 没有 `setup.py`，检测器必须覆盖这种情况。

6. **`tsc --noEmit` 是最快的"有没有拼错"检查。** 养成每改完一个文件就跑一次的习惯。
