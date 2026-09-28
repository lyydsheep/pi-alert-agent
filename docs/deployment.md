# 单机部署与验收

## 前提

- 使用独立 Node.js 24 运行时，不替换旧系统 Node 或其他全局工具。已观察到旧 AnyDev 的 Node 22.15 低于当前 Pi 最低要求 22.19；本项目选择 Node 24。
- 独立应用目录、数据目录、服务名称、测试群与测试业务仓库。目标业务仓库需有 remote master、可用构建工具和 Git 身份；同机共用环境不等于沙箱。
- 模型、WSS 机器人、群 webhook、Owner、业务 API 和查询 CLI 由私有配置提供。示例中的名称是占位符，不能用于真实验收。
- 先运行类型检查和测试，后启动测试群服务。看板默认仅监听本机；按部署需要配置反向代理。Phoenix 内部服务及公开只读网关见观测文档。

## 进程管理

使用服务管理器启动 `node src/main.ts /absolute/private/config.json`，工作目录为应用目录，自动重启，仅向服务注入私有环境。服务通过数据目录锁避免重复主进程。SIGTERM 停止收消息、停止调度，取消并回收执行器后退出。

重启恢复依赖旧 Pi 进程已停止。Pi 的 IPC 监督进程在主进程断连后终止整个执行进程组。硬退出后的启动应等待该清理完成，不能在旧执行器仍写入时重新领取任务。此项需要真实宿主故障注入验收。

## 备份恢复

首版提供同机、同路径恢复。先停止主服务，执行 `node scripts/backup.ts backup DATA_DIR BACKUP_DIR`。备份包含 SQLite 一致性快照、会话、工作区和证据；目标业务仓库与其中的任务分支引用仍需单独保留。

恢复前归档现有数据目录，执行 `node scripts/backup.ts restore BACKUP_DIR ORIGINAL_DATA_DIR`。脚本拒绝覆盖已有目录或向不同路径恢复；校验原业务仓库仍存在，必要时执行 Git worktree repair，再启动。不要将此机制宣称为丢失整台主机后的完整灾备。

根据运行频率由部署人员安排停机备份周期，先在测试数据上演练。运行中的任务、暂停和阻塞状态均应保留，不能将恢复视为重新授权。

## 切换清单

1. 测试群验证接收、同事件去重、方案通知、真实 @、延期、暂停及超时执行。
2. 真实 Pi 使用测试仓库完成修复、测试、提交 MR；检查当前 HEAD 的 Agent review 及必需检查。
3. 验证 4 个独立任务及资源限制，重叠代码修改不建立隐式任务依赖。
4. 中断主服务和执行器，确认恢复不双写、不重复 MR，计时和暂停有效。
5. 演练备份恢复、工作区清理后续跑、Phoenix 故障降级与公开只读规则。
6. 按群切换新任务入口；旧系统完成原有任务，不迁移执行中的会话。

这些是未完成的真实验收要求；本地替身测试通过不等于已经部署或切换。

## AnyDev 验证目录（2026-09-27）

独立目录 `/data/workspace/pi-alert-agent-validation` 已创建；`runtime/node_modules/node/bin/node` 为 Node 24.21.0，`app/` 使用锁文件安装依赖。旧系统 Node 22.15 和应用目录没有变更。此目录目前用于验收，不代表服务已启用。

`deploy/pi-alert-agent.service` 是该路径对应的 systemd 单元。准备仅包含测试群和测试仓库的 `private/config.json`、`private/runtime.env`（权限 0600）后，再安装并启动单元。未取得这些配置前，不启动企微连接，也不启用开机启动。主服务可以直接用绝对 Node 路径执行；Pi 子进程解析项目内固定版本，不依赖全局 `pi` 命令。

主机验证已通过：`npm run check`、52 项行为测试（含实际 Pi CLI + 本地模拟模型接口、Git worktree、SQLite 备份恢复）及 `systemd-analyze verify deploy/pi-alert-agent.service`。尚未启用该 systemd 单元；测试不包含真实企微、模型供应商或托管 MR 平台。业务大仓的四任务实际资源容量仍待测量。

## Phoenix 独立部署文件

- `deploy/phoenix-requirements.txt` 固定已验收的 Phoenix 20.16.0；使用独立 Python 3.12 venv `/data/workspace/pi-alert-agent-validation/phoenix-runtime` 安装，不改变旧服务依赖。
- 将 `deploy/phoenix.env.example` 复制至独立目录的 `private/phoenix.env`，生成并替换三项 secret/password，占位符不能直接使用；文件权限0600。采集器仅绑定127.0.0.1。
- `deploy/pi-alert-phoenix.service` 管理内部Phoenix；启动后在私有环境中注入同一个 `PHOENIX_ADMIN_SECRET`，运行 `python3 scripts/provision-phoenix.py --url http://127.0.0.1:6006 --output-dir /data/workspace/pi-alert-agent-validation/private`。
- 脚本新建Viewer、完成首次密码重置、重新登录后创建只读key；输出的 `phoenix-viewer.env` 给网关单元使用，`phoenix-keys.json` 中的systemKey给Agent采集器使用。脚本拒绝覆盖已有key文件；不要将这些文件提交到仓库。
- `deploy/pi-alert-phoenix-viewer.service` 启动127.0.0.1:8081网关。只反向代理网关对外开放，6006采集器和任何管理入口保持内部。systemd模板默认本机反向代理；AnyDev使用平台提供的HTTPS端口代理，Supervisor模板让只读网关监听0.0.0.0。

以上文件提供可复用安装入口，不表示这些单元已安装、启用或完成公网验收。

### AnyDev 无 systemd 的实际运行方式

该宿主 `systemctl is-system-running` 返回 `offline`，因此不能把单元静态校验等同于可运行的systemd部署。`deploy/supervisord.conf` 提供独立Supervisor实例，socket、日志、PID均限制在验证目录。Supervisor固定4.3.0，和Phoenix一起安装在独立Python环境中。systemd单元保留给有systemd的宿主。

使用 `phoenix-runtime/bin/supervisord -c app/deploy/supervisord.conf` 启动管理器，再通过相同配置的 `supervisorctl` 查询/启停。三个服务均为 `autostart=false`；完成各自私有配置后才能显式启动。停止时回收进程组，避免残留Pi执行器。这个管理器仅管理本目录声明的三个进程，不接管旧系统。

本地与AnyDev均已通过真实服务子进程SIGKILL恢复检查：旧Pi监督进程终止、独占锁接管、原任务/会话/workspace关联保留、新run围栏递增。该检查通过IPC向真实AlertService输入，未覆盖真实企微WebSocket。

### Phoenix gRPC 监听补丁

20.16.0忽略HTTP host设置，在gRPC端固定绑定所有网卡。安装依赖后、启动Phoenix前必须执行 `phoenix-runtime/bin/python app/scripts/patch-phoenix-bind.py`，将TLS和明文gRPC监听均限制到127.0.0.1。脚本验证精确版本和源码片段，可重复执行，遇到版本漂移会拒绝修改。该补丁不改变API-key认证。启动后用 `ss -ltnp` 同时核实6006与4317，仅公开Viewer网关。上游候选已记录。

## AnyDev 部署进展

已在独立Python3.12.14环境安装Phoenix20.16.0与Supervisor4.3.0，并实际运行独立Supervisor实例。远端直接下载较慢，最终使用本地准备、远端离线解析通过的157个Linuxwheel安装；旧下载在替代包就绪后显式停止，未并行写同一环境。

内部Phoenix和Viewer已经运行，实际采集一条合成追踪并经Viewer GraphQL读回；公开写入/认证/管理探针返回403。HTTP6006、gRPC4317仅绑定127.0.0.1；AnyDev Supervisor下Viewer8081绑定0.0.0.0供平台端口代理访问。私有key文件位于独立private目录，未进入代码仓库。两个进程用于验证，告警主进程仍STOPPED。Supervisor和systemd启动文件都会自动检查/应用gRPC本机绑定补丁。

尚未配置公开域名/TLS及宿主启动时恢复Supervisor，也未接入真实企微或业务MR；不能把本机可用称为完成公开部署或按群切换。

2026-09-28：AnyDev外部端口代理无法访问仅监听127.0.0.1的Viewer，调整Supervisor的HOST为0.0.0.0后，平台cloudide入口匿名GET首页和GraphQL查询均返回200；GraphQL mutation、OTLP写入和/auth/login均返回403。内部采集和管理服务继续仅绑定本机。实际域名保存在部署私有配置。
