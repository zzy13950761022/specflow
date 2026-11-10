# AI Pilot 工作流演进 Spec

日期：2026-11-09。范围：现有本地 MCP + Dashboard 平台。

## 目标与设计选择

保留 SPEC → REQUIREMENTS → DESIGN → DEVELOP → TEST → BUILD → DEPLOY → OPS 的展示和文件作为事实来源的架构，按下面六个优先级交付可独立验证的增量。用户已要求按此顺序开工。

选择在现有状态机上增加版本、依赖和执行记录。仅修改提示词无法保证一致性；立即替换成通用图引擎会引入迁移和编排复杂度。第一版采用固定流程模板和开发任务依赖，所有合法状态转换由 AppCore/StageMachine 统一执行。

## P1：跨阶段返工与下游失效

- 提供 reopen_stage(repoId, ticketId, stageId, reason)，Dashboard 同样支持。reason 必须非空。
- 只能重开已经产生结果的当前或过去阶段，不能重开尚未到达的阶段。
- 重开目标阶段后，其 gate 返回 needs_revision，AI 返回 in_progress；所有参与流程的下游阶段 gate 返回 not_ready，AI 返回 not_started。
- 保留旧产物、版本、审批和返工历史，标记 stale；旧内容可以查看，但不能作为有效输入或审批依据。
- 目标及下游开发完成标记清除；旧日志保留但不满足新一轮完成条件。测试与构建证据同步失效。
- 重新提交目标产物创建新版本，并清除目标 stale 标记；下游必须依次重做。

验收：Given 已走到 TEST，When 重开 DESIGN，Then DESIGN 待修改、DEVELOP/TEST 失效，旧审批不能推进，历史文件仍可读。未开始阶段、空原因被拒绝。

## P2：状态机约束、版本审批与原子更新

- 持久化当前阶段；新票据只允许 SPEC 操作，推进时才开启下一参与阶段。
- record_ai_output 只允许当前阶段，待审批阶段不能被静默覆盖；过去阶段修改先走 reopen。
- approve/reject/revise 仅允许 pending_review。审批绑定 stage.revision；Dashboard 的批准、拒绝和修改请求均携带 expectedRevision，旧页面审核被拒绝。
- DEVELOP 分离计划审批与实施进度：注册任务/修改计划使计划审批失效；实施需有效计划审批。完成任务必须有当前开发版本的实现日志。
- 增加幂等 set_subtask_completed；保留 toggle_subtask 兼容，但新编排使用幂等接口。
- 重复 advance 不得重置下一阶段；最终阶段审批后票据完成，不再提示调用 advance。
- AppCore 的 read → mutate → write 使用同一个票据事务锁。不同进程共享磁盘锁，防止 MCP/Dashboard 并发覆盖。文件写入保持原子替换。
- 新 schema 兼容读取旧票据；未完成的旧票据无版本证据时要求重新审核。已完成且产物未更新、完整历史审批仍有效的 v2 票据保留历史完成状态，不补造新检查证据；后续修改需显式返工。

验收：越阶段提交、空产物审批、旧版本审批、无日志完成任务均被拒绝；同时修改不会丢失结果；重试推进不破坏下一阶段。

## P3：真实测试与构建执行证据

- 新 run_stage_check 工具由平台执行仓库配置的 test/build 命令，AI 无法通过 record_ai_output 写入可信证据。
- 配置存放 .specflow/checks.json：test/build 各包含 command、args，可设置 test.coverageReport（Istanbul coverage-summary JSON）。运行 cwd 固定为仓库目录，使用 spawn(command, args)，不拼 shell 命令。
- 记录运行 ID、命令、退出码、开始/结束时间、代码指纹、输出文件、工具解析的覆盖率和是否超时。
- 代码指纹覆盖仓库源文件，排除 .git、.specflow、node_modules 和标准生成目录 dist/build/coverage；符号链接不跟随。排除项在 README 明示。运行前后代码指纹不一致则证据无效。
- TEST 需退出码 0 且报告实际行覆盖率 ≥ 80%；BUILD 需退出码 0。缺配置、缺报告、失败、超时、代码已变更均阻止审批和推进。
- 每次测试运行前清除配置的旧覆盖率报告，防止读取前次结果。报告必须是仓库 coverage/ 内的 JSON 文件，不能穿越符号链接；该限制防止测试前清理报告时删除源文件。
- AI metrics 保留为说明性数据，不能满足检查门槛。
- 输出只写专用证据文件，MCP stdout 保持 JSON-RPC；运行有输出上限和时间上限。
- 仓库级磁盘锁拒绝不同票据/进程重叠执行检查，防止共用覆盖率报告。显式恢复仅回收已结束的进程；创建锁期间崩溃、缺失或截断元数据使用 30 秒保护期，再次 resume 可回收。

验收：AI 声称 buildSuccess=true 仍无法推进；真实通过命令可产生证据；失败、旧覆盖率报告、修改代码和超时均被拦截。

## P4：按任务提供上下文与需求追踪

- get_stage_context 返回该阶段所需的已批准、未失效产物，携带阶段、版本和路径。
- SPEC 无上游；REQUIREMENTS 使用 SPEC；DESIGN 使用 SPEC/REQUIREMENTS；DEVELOP 使用 SPEC/REQUIREMENTS/DESIGN；TEST/BUILD/DEPLOY/OPS 使用所有已参与的上游，以及有效实现日志。
- get_stage_prompt 保留 upstreamArtifact 兼容变量，同时追加统一上下文段，使自定义模板也能接收上下文。
- 缺失的必要已批准输入明确报错，禁止静默返回空文本；跳过的阶段不视为缺失。
- 结构化 acceptanceCriteria 保存稳定 ID 和 Given/When/Then。子任务 requirementRef 关联 ID，testRefs 记录测试文件/用例。
- get_traceability 返回验收标准 → 子任务 → 日志中的文件 → 测试引用，并列出未关联标准、未知标准引用和未关联测试，供审核发现遗漏。

验收：TEST 上下文含验收标准、设计和有效实施日志；返工后旧产物不进入上下文；无效需求引用被拒绝，追踪报告能识别遗漏。

## P5：固定流程模板与审批策略

- create_spec 接受 workflowKind（standard / bugfix / documentation）、risk（low / normal / high）、autoChecks（默认 false）。
- standard 参与全部阶段；bugfix 参与 SPEC/DEVELOP/TEST/BUILD/DEPLOY/OPS；documentation 参与 SPEC/DEVELOP/OPS。
- 未参与阶段仍展示，标记 skipped 并记录模板给出的原因。跳过不能伪装成人工批准。
- 流程创建后固定；不允许 AI 自由跳过阶段。documentation 在 SPEC 中说明仅文档变更。
- 默认所有参与阶段人工审批；显式启用 autoChecks 且 risk=low 时，仅 TEST/BUILD 在可信证据通过且产物提交后支持策略审批。
- SPEC、设计、开发计划、DEPLOY 和 OPS 保持人工审批，高风险全部人工。策略审批记录 actor=policy 和策略原因。

验收：缺省行为仍为八阶段人工门禁；bugfix 不需伪造设计审批；文档流程清晰展示跳过原因；高风险不自动审批。

## P6：执行状态、恢复与开发任务依赖

- 持久化 execution：ready/running/waiting_review/failed/paused/completed，最近成功步骤、错误、重试次数、活动运行。
- get_execution_status/get_next_actions 返回结构化下一操作；字符串 nextSteps 从同一状态推导，正确区分开发计划审批后实施和最终阶段结束。
- pause_execution/resume_execution 显式暂停/继续。暂停时禁止新写入或执行，允许只读和审批；恢复不重复已完成步骤。
- check 运行持久化 runId，防止重复启动。重启后未完成运行由 resume 明确标记失败，不自动重复外部操作。
- get_approval_status 支持有限 waitMs（0 为快照，最大 60 秒），订阅后重新读取避免漏事件；会话断开清理监听。
- 子任务具有稳定 ID、dependsOn、files（计划修改文件）、status（pending/running/done）、claimId。检查未知依赖、重复 ID、自依赖和循环。
- claim_subtask 为 ready 任务获取令牌；依赖未完成或与运行任务 files 重叠时拒绝。互不冲突的 ready 任务可由外部 agent 并行领取。
- 完成运行任务需要当前 claimId 和当前版本日志；重试同一完成请求幂等。失败任务可 release_subtask 后重领；重置上游任务清除所有依赖任务的完成状态。
- 若依赖任务仍在执行，拒绝重置上游任务；先显式释放依赖领取，避免文件冲突保护被静默解除。
- 本地平台提供调度接口，不自动启动远程 agent、不自动发布、推送或部署。开发结束仍经过集成 TEST/BUILD 和人工发布审核。

验收：会话恢复返回正确下一步，不重复已完成任务；依赖与文件冲突拦截生效，独立任务可同时领取；开发计划获批后提示实施；OPS 获批后明确完成。

## 界面、兼容与错误约定

Dashboard 展示流程类型、跳过原因、失效原因、产物版本、真实证据摘要、执行状态；提供返工、暂停/恢复入口，表单错误可见。新建票据可选模板与风险。

保留现有 MCP 工具，新接口统一调用 AppCore；REST 请求通过 Zod 验证。旧模板可以继续使用。旧数据只读迁移并在首次变更时写入新 schema，源文件不删除。审批历史不覆盖。

错误消息明确说明被阻止的操作和下一步，异常通过 MCP isError 或 REST 400/409 返回。日志存储仍在 .specflow，不污染 stdout。

## 验证与完成标准

每个优先级先编写失败用例，再实现并运行对应检查。最终通过后端、前端单元测试、两端 TypeScript 检查、生产构建和 Playwright 流程测试；更新 README 的配置与工具参考。基线已有不一致用例修正为实际接口契约。文档逐项记录实现状态和限制。

## 实施进度

- [x] P1 跨阶段返工
- [x] P2 状态机约束
- [x] P3 真实执行证据
- [x] P4 上下文与追踪
- [x] P5 流程与策略
- [x] P6 恢复与依赖调度

## 最终验收结果

六项按 P1 → P6 顺序实现，MCP、REST 与 Dashboard 共用同一核心契约。

- `npm test`：17 个测试文件、223 个测试通过。
- `npm run test:frontend`：17 个测试通过。
- 后端和前端 TypeScript 检查均通过。
- `npm run build`：生产构建通过。
- `npm run test:e2e`：浏览器流程通过，覆盖创建 bugfix、MCP 提交、人工审核、显式推进、跨阶段返工、暂停/恢复与跳过阶段展示。截图已检查。
- 独立 spec 审查与代码质量审查完成；审查发现的过期审核、运行中返工、上游证据恢复目标、跨票据覆盖率共用、运行依赖重置与崩溃锁恢复问题均已修复并验证。
- `git diff --check` 通过。

使用限制：每个项目需自行配置 `.specflow/checks.json`；TEST 需生成 coverage/ 内的 Istanbul JSON 报告。文件声明用于调度冲突检测，不能约束外部 agent 的实际编辑行为。指纹不跟随符号链接，排除的生成路径在 README 中列明。锁元数据不完整时恢复有 30 秒保护期。平台不自动启动 agent 或发布部署。

### 2026-11-10：已完成旧票据兼容修正

已完成 v2 票据保留 OPS/completed、历史批准和开发完成标记，记录原完成时间。已被旧迁移清除状态的票据可使用备份式修复脚本恢复；检测到新产物、返工、运行任务或历史审批不完整时拒绝修复。恢复后仍可显式返工，新一轮执行遵守新规则。未完成票据继续采用保守迁移。新增 4 项回归测试，完整后端 227 项与生产构建通过。
