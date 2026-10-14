# 用 AI Pilot 学 TypeScript

这份文档面向**没学过 TypeScript** 的人。它不照抄语法手册,而是用我们在 `ai-pilot`
项目里**真实写过的代码**来讲 TS 的核心概念。每一节都对应 `src/` 里的一个真实文件,
你可以边读边打开对应文件对照。

> 代码基准:Phase 1(git commit `ec65ea4`)。文中行号以该版本为准。

---

## 0. TypeScript 是什么(给零基础)

JavaScript 是浏览器/Node 运行的语言,它**不检查类型**:一个变量可以先是数字再变字符串,
函数可以传任何东西,错误只在运行时才爆。

TypeScript = JavaScript + **编译期类型检查**。你多写一些"这个变量是什么类型"的标注,
`tsc`(TypeScript 编译器)在**运行前**就帮你抓出一大类错误(传错参数、拼错字段名、
忘了处理 null)。最后 TS 会被编译成普通 JS 再运行——**浏览器/Node 并不认识 TS**。

我们项目的编译配置在 `tsconfig.json`,最关键的一行是:

```json
"strict": true
```

`strict` 打开一组严格检查。初学建议**一直开着**——它逼你把 null、any 这些坑在编译期处理掉。

运行方式:
- `npx tsc` → 把 `src/*.ts` 编译成 `dist/*.js`
- `npx tsc --noEmit` → 只检查类型、不产出文件(我们每次验证都用这个)
- `npx tsx src/index.ts` → 用 tsx 直接跑 TS,免编译(开发时方便)

---

## 1. 基础类型标注 —— 看 `logger.ts`

打开 `src/core/logger.ts`。这是项目里最简单的文件,适合入门。

```ts
type Level = 'debug' | 'info' | 'warn' | 'error';
```

**第一个概念:联合类型(union)+ 字面量类型(literal)。**
`Level` 不是"字符串",而是"只能是这四个字符串之一"。写 `write('inof', ...)`(拼错)
会被编译器当场拒绝。这比 JS 里用普通字符串安全得多。

```ts
function write(level: Level, args: unknown[]): void {
```

- `level: Level` —— 参数标注,冒号后面是类型。
- `args: unknown[]` —— `unknown` 是"我不知道是什么类型"的**安全版 any**。`[]` 表示数组。
  所以 `unknown[]` = 任意类型的数组。为什么不用 `any[]`?因为 `unknown` 强制你在使用前
  先判断类型,`any` 则彻底关闭检查(TS 里应尽量避免 `any`)。
- `: void` —— 返回值类型。`void` = 不返回有意义的值。

```ts
export const logger = {
  debug: (...args: unknown[]) => write('debug', args),
  info: (...args: unknown[]) => write('info', args),
  ...
};
```

- `export` —— 让别的文件能 `import` 它。没有 `export` 的东西是文件私有的。
- `(...args: unknown[]) => ...` —— **箭头函数**。`...args` 是**剩余参数**(rest),
  把任意多个入参收集成一个数组。
- 对象字面量里直接定义方法,`logger.info("hi")` 就能调。

> **TS 练习**:把 `write('debug', args)` 改成 `write('dbg', args)`,保存后跑 `npx tsc --noEmit`,
> 你会看到编译器报错 —— 这就是字面量联合类型在替你挡错。

---

## 2. 用 zod 把"数据形状"变成单一事实源 —— 看 `schemas.ts`

这是整个项目**最重要的 TS 思想**,务必弄懂。打开 `src/core/schemas.ts`。

### 2.1 问题:类型只存在于编译期

TS 的类型在编译成 JS 后**全部被抹掉**。也就是说,运行时从磁盘读进来一个 JSON,
TS 并不会自动帮你验证"它真的符合 SpecFile 的形状"。类型只是编译期的承诺,不是运行期的保险。

### 2.2 解法:zod —— 运行期也能校验的 schema 库

```ts
import { z } from 'zod';

export const GateStatusSchema = z.enum([
  'not_ready', 'pending_review', 'approved', 'rejected',
]);
export type GateStatus = z.infer<typeof GateStatusSchema>;
```

两行配合是精髓:
1. `GateStatusSchema` 是一个**运行期对象**,能调 `.parse(x)` 真正校验数据。
2. `z.infer<typeof GateStatusSchema>` 从 schema **自动推导**出 TS 类型 `GateStatus`
   (= `'not_ready' | 'pending_review' | 'approved' | 'rejected'`)。

好处:**改一处,编译期类型和运行期校验同时更新**,永远不会漂移。
如果你手写两份(一份 interface、一份校验函数),迟早对不上。

> `typeof GateStatusSchema` 里的 `typeof` 是 **TS 的 typeof**(拿一个值的类型),
> 和 JS 运行时的 `typeof x === 'string'` 是两回事,别混。

### 2.3 对象 schema 与嵌套

```ts
export const StageSchema = z.object({
  id: StageIdSchema,
  aiStatus: AiStatusSchema,
  aiCapability: AiCapabilitySchema,
  gate: GateSchema,
  artifactPath: z.string().optional(),          // ← 可选字段
  subtasks: z.array(SubtaskSchema).optional(),   // ← 可选的数组
});
export type Stage = z.infer<typeof StageSchema>;
```

- `.optional()` → 对应 TS 的 `字段?: 类型`,表示"可能没有"。
- `z.array(X)` → `X[]`。
- schema 可以互相嵌套(`gate: GateSchema`),类型也跟着嵌套推导。

```ts
export const SpecFileSchema = z.object({
  ...
  stages: z.array(StageSchema).length(STAGE_IDS.length),  // 必须正好 8 个
});
```

`.length(8)` 是**运行期约束**:读到一个只有 7 个 stage 的旧文件,`.parse()` 直接抛错。
这种"坏数据早失败"的保险,是纯 TS 类型给不了的(类型不校验数组长度)。

### 2.4 `as const` 的妙用

```ts
export const STAGE_IDS = [
  'spec', 'requirements', 'design', 'develop',
  'test', 'build', 'deploy', 'ops',
] as const;
```

没有 `as const`,TS 推断 `STAGE_IDS` 的类型是 `string[]`(普通字符串数组)。
加上 `as const`,类型变成**只读元组** `readonly ['spec', 'requirements', ...]` ——
每个元素都是精确的字面量。于是 `z.enum(STAGE_IDS)` 才能据此生成精确的联合类型。

---

## 3. 类(class)、泛型、异步 —— 看 `stage-machine.ts`

打开 `src/core/stage-machine.ts`。

### 3.1 自定义错误类 + 继承

```ts
export class GateNotApprovedError extends Error {
  readonly code = 'GATE_NOT_APPROVED';
  constructor(stageId: StageId, actual: GateStatus) {
    super(`Cannot advance stage "${stageId}": gate is "${actual}"...`);
    this.name = 'GateNotApprovedError';
  }
}
```

- `extends Error` —— 继承内置的 Error 类。
- `readonly code = '...'` —— `readonly` 字段,构造后不能改。注意它同时也是**字面量类型**
  `'GATE_NOT_APPROVED'`,后面 transport 层能靠它精确判断。
- `super(...)` —— 调用父类(Error)的构造函数。
- 模板字符串 `` `...${stageId}...` `` —— 反引号里用 `${}` 插值。

为什么要自定义错误类?这样调用方能用 `if (e instanceof GateNotApprovedError)` **精确区分**
"是门没批准" vs "其它错误"(见第 5 节 transport 层)。

### 3.2 类的方法与可见性

```ts
export class StageMachine {
  createSpec(input: { ticketId: string; title: string }): SpecFile { ... }

  private stage(spec: SpecFile, stageId: StageId): Stage { ... }
}
```

- `createSpec(...)` —— 公开方法(默认 public),外部能调。
- `private stage(...)` —— 私有方法,只能类内部调。编译期强制。
- `input: { ticketId: string; title: string }` —— 参数类型直接写成**内联对象类型**
  (不必非得先 `interface`)。

### 3.3 泛型(generics)—— 第一次出现在 `mutateStage`

```ts
private mutateStage(
  spec: SpecFile,
  stageId: StageId,
  fn: (next: SpecFile, stage: Stage) => void
): SpecFile {
  const next = structuredClone(spec);
  const stage = next.stages.find((s) => s.id === stageId);
  if (!stage) throw new Error(`Unknown stage: ${stageId}`);
  fn(next, stage);
  next.updatedAt = now();
  return next;
}
```

这里 `fn` 的类型是 `(next: SpecFile, stage: Stage) => void` —— **函数也是一种类型**,
可以当参数传(高阶函数)。`recordAiOutput`/`approve`/`reject` 都把各自的"改哪里"
作为回调传进来,复用 clone+返回的骨架。

> 真正的泛型 `<T>` 在 `spec-store.ts` 的 `withLock<T>` 里,见第 4 节。

### 3.4 不可变更新 + 一个真实 bug

`structuredClone(spec)` 深拷贝整个对象,**绝不改原始 spec**。为什么坚持不可变?
因为纯函数更好测、不会有"改了一个对象结果别处也变了"的诡异 bug。

> **踩坑复盘**:最初 `transitionGate(spec, ...)` 往 `gateHistory` push 时,传的是闭包里的
> **原始 spec**,而不是克隆出来的 `next`。结果 history 落到了被丢弃的对象上,测试里
> `gateHistory` 永远是空数组。修复:把 `next` 作为参数显式传进回调
> (`fn: (next, stage) => void`),push 到 `next`。
> **教训:做不可变更新时,时刻确认你操作的是副本那一份,而不是闭包捕获的原值。**

### 3.5 可选链与空值处理

TS strict 下,`find` 可能返回 `undefined`,所以必须先判:

```ts
const stage = next.stages.find((s) => s.id === stageId);
if (!stage) throw new Error(...);   // 收窄类型:这行之后 stage 一定是 Stage,不是 undefined
```

这叫**类型收窄(narrowing)**:`if (!stage) throw` 之后,编译器知道 `stage` 不可能是
`undefined` 了,后面就能安全用 `stage.gate`。

---

## 4. 泛型、Promise、异步锁 —— 看 `spec-store.ts`

打开 `src/core/spec-store.ts`。

### 4.1 真正的泛型函数

```ts
private withLock<T>(repoPath: string, ticketId: string, op: () => Promise<T>): Promise<T> {
  ...
  return next;
}
```

`<T>` 是**类型参数**。意思是"这个函数能处理任意返回类型 `T` 的操作,并原样把 `T` 带出来"。
调用 `withLock(..., async () => validated)`(`op` 返回 `SpecFile`)时,`T` 自动被推断为
`SpecFile`,返回类型就是 `Promise<SpecFile>`。泛型让一个函数能复用在不同返回类型上,
又不丢类型信息(不像 `any` 那样全丢)。

### 4.2 Promise 与 async/await

```ts
async read(repoPath: string, ticketId: string): Promise<SpecFile | null> {
  try {
    const raw = await fs.readFile(this.specJsonPath(repoPath, ticketId), 'utf-8');
    return SpecFileSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}
```

- `async` 函数的返回值一定是 `Promise<...>`。这里是 `Promise<SpecFile | null>`
  (联合类型:要么拿到 spec,要么 null)。
- `await` —— 等异步操作完成再往下走。只能在 `async` 函数里用。
- `catch (err: unknown)` —— strict 下 catch 的错误是 `unknown`,**用之前必须断言/判断**。
- `(err as NodeJS.ErrnoException)` —— **类型断言**(`as`):告诉编译器"把它当成这个类型"。
  谨慎用,因为它是你向编译器打包票,不校验。这里只是为了读 `.code`。
- `?.code` —— **可选链**:如果左边是 null/undefined,整个表达式返回 undefined 而不是报错。

### 4.3 用 Promise 链实现异步互斥锁(进阶但很实用)

```ts
private locks = new Map<string, Promise<unknown>>();

private withLock<T>(repoPath, ticketId, op): Promise<T> {
  const key = this.lockKey(repoPath, ticketId);
  const prev = this.locks.get(key) ?? Promise.resolve();   // 上一次的尾巴,没有就用已完成的空 Promise
  const next = prev.then(op, op);                           // 把本次接在上次之后(成功/失败都执行 op)
  this.locks.set(key, next.catch(() => undefined));         // 存回,catch 防止一次失败卡死整条链
  return next;
}
```

- `Map<string, Promise<unknown>>` —— **泛型容器**:键是 string,值是 Promise。
- `?? Promise.resolve()` —— **空值合并**:左边是 null/undefined 时取右边。
- 核心思想:同一个 ticket 的多次写,被串成一条 Promise 链依次执行,**天然互斥**,
  避免并发写把 JSON 写花。这是不用任何锁库、纯用 Promise 实现并发控制的经典模式。

### 4.4 原子写(这是设计思想,不是 TS 语法)

```ts
const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
await fs.writeFile(tmp, JSON.stringify(validated, null, 2), 'utf-8');
await fs.rename(tmp, target);   // 同一文件系统内 rename 是原子的
```

先写临时文件再 `rename`。读者永远看到完整的旧文件或完整的新文件,绝不会读到写一半的残文件。
这是文件存储的通用安全模式,值得记住。

---

## 5. 把类型"卡在边界上" —— 看 transport 层

类型检查最大的价值在**系统边界**(用户输入、外部 API、磁盘)。

### 5.1 MCP 工具:zod schema 直接当入参校验(`src/mcp/server.ts`)

```ts
server.registerTool(
  'create_spec',
  {
    description: '...',
    inputSchema: { repoId: z.string(), ticketId: z.string(), title: z.string() },
  },
  async ({ repoId, ticketId, title }) => {   // ← 这三个参数的类型由上面的 zod 自动推导
    try {
      return ok(await app.createSpec(repoId, ticketId, title));
    } catch (e) {
      return fail(String((e as Error).message));
    }
  }
);
```

- `inputSchema` 用 zod 描述工具入参;SDK 会**在调用前校验**,并把类型喂给回调。
  所以回调里的 `{ repoId, ticketId, title }` 全是 `string`,不用自己断言。
- `async ({ ... }) =>` —— **解构 + 箭头函数**:直接把对象字段拆成参数。

### 5.2 用自定义错误类做精确分流

```ts
async ({ repoId, ticketId, stageId }) => {
  try {
    return ok(await app.advance(repoId, ticketId, stageId));
  } catch (e) {
    if (e instanceof GateNotApprovedError) return fail(e.message, e.code);  // ← 精确识别
    return fail(String((e as Error).message));
  }
}
```

`instanceof GateNotApprovedError` 让"门没批准"这种业务错误,被翻译成带 `code` 的结构化响应
回给 Claude,而其它错误走通用分支。第 3.1 节自定义错误类的价值在这里兑现。

### 5.3 Fastify 路由上的泛型(`src/dashboard/server.ts`)

```ts
fastify.post<{ Body: { path?: string } }>('/api/repos', async (req, reply) => {
  const path = req.body?.path;         // req.body.path 的类型就是 string | undefined
  if (!path) return reply.code(400).send({ error: 'path is required' });
  ...
});
```

`fastify.post<{ Body: {...} }>` 用泛型告诉 Fastify "这个请求体长什么样",于是 `req.body`
就有了类型。`path?: string` + `if (!path)` 又是一次空值收窄。

---

## 6. ESM 模块与那个 `.js` 之谜

你会注意到所有 import 都带 `.js`,即使文件是 `.ts`:

```ts
import { AppCore } from './core/app-core.js';   // 文件其实是 app-core.ts !
```

这不是笔误。我们用的是 **ESM + Node16 模块解析**(见 `tsconfig.json` 的
`"module": "node16"`)。规则是:**import 路径写编译后的 `.js` 名字**,因为运行时执行的是
编译产物 JS。TS 编译时能理解这个映射。

初学最容易在这里栽:漏写 `.js` 或写成 `.ts`,运行时会报 "Cannot find module"。
**铁律:相对 import 一律带 `.js` 后缀。**

---

## 7. 一个贯穿全局的架构思想:类型 + 分层

TS 的类型系统鼓励你**把职责切成层,层与层之间用类型约定接口**:

```
schemas.ts   ──定义形状──▶  所有层共用 SpecFile / Stage / StageId
stage-machine ──纯函数──▶  (SpecFile) => SpecFile    无 I/O,好测
spec-store   ──存储──▶     Promise<SpecFile>          只管读写盘
app-core     ──编排──▶     调上面三层,串成 mutate→persist→emit
mcp / dashboard ─transport→ 薄壳,把外部请求翻译成 AppCore 调用
```

每一层的函数签名(入参/返回类型)就是它和外界的**契约**。改一层的内部实现,只要签名不变,
别的层不受影响,编译器会在你违约时报错。这就是"类型驱动的分层设计"。

---

## 下一步学习建议

1. 打开每个文件,对照本文的小节读一遍,把不懂的 TS 语法在这里查。
2. 做个破坏实验:故意把某处类型写错(改字段名、漏 await、去掉 `.js`),跑 `npx tsc --noEmit`,
   看编译器怎么报错——**错误信息本身是最好的老师**。
3. 读测试文件(`*.test.ts`)。测试是理解一段代码"该怎么用"的最快入口。
4. 读姊妹篇 `docs/DEV-JOURNEY.md`:它讲这个项目**为什么**这样设计、我们怎么一步步决策、
   踩了哪些坑——那是比语法更重要的"工程思维"。
