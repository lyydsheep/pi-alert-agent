# 使用自部署 Phoenix 记录完整执行过程

首版接入自部署 Phoenix，观察 Agent 执行过程，包括模型与工具调用、耗时、错误和 token 用量。告警看板保持只读，展示业务任务状态并关联执行追踪；Phoenix 不承担任务状态或授权判定。

采用全量输入输出记录，不做过滤、脱敏、摘要或长内容截断，亦不额外过滤被采集输入输出中出现的鉴权凭据；这不要求主动采集与执行追踪无关的秘密。追踪数据保留 7 天。

Phoenix 内容允许公开查看，不要求访问者登录或进行查看权限校验；此决定替代此前仅限已授权团队成员访问的方案。公开入口仅允许读取，追踪上报、删除和管理操作只开放给内部服务。部署需区分公开读取入口与内部写入、管理入口，不能仅关闭 Phoenix 认证并暴露完整服务；具体实现仍待设计和验证。

Phoenix 不可用时任务继续，追踪上报失败不阻塞告警处理；任务状态、Owner 指令和关键操作记录由告警应用独立持久保存。中断期间追踪数据的缓存和补传策略尚未确定。

参考：[Phoenix](https://github.com/Arize-ai/phoenix)、[OpenTelemetry 接入](https://arize.com/docs/phoenix/tracing/how-to-tracing/setup-tracing/setup-using-phoenix-otel)。
