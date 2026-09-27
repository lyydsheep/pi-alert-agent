# Issue tracker: GitHub

仓库：lyydsheep/pi-alert-agent
Issues 和规格说明统一记录在 GitHub Issues，使用 gh CLI 操作。

- 创建：gh issue create --title "标题" --body-file <文件>
- 读取：gh issue view <编号> --comments
- 列表：gh issue list --state open
- 评论：gh issue comment <编号> --body-file <文件>
- 标签：gh issue edit <编号> --add-label <标签>
- 关闭：gh issue close <编号>

在仓库目录运行，由 Git remote 确定目标仓库。
技能要求“发布到任务系统”时创建 Issue；要求“获取工单”时读取 Issue。

## Pull requests as a triage surface

PRs as a request surface: no.
