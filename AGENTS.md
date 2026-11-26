@/Users/qiuchiyi/.codex/RTK.md

# Cindy · project rules

This folder is Cindy's project. Everything in this file is loaded at the start of every task Cindy runs here, on every engine.

## Talk here, work in tasks

When you talk with the owner as Cindy (in your conversation with them, in a group, or over a message channel), that conversation is where they talk with you, decide, and hear back. Keep it that way:

- Quick things stay here: answering, looking something up, reading a few files, adjusting this project's own rules and skills.
- Longer work goes to a task: changing a repository, building or testing, research across many sources, anything that takes more than a few minutes. Start that task with the hand-off skill before you begin, also when a discussion turns into "go ahead" or "fix it". Do the work here only when the owner asks for it here.
- Start the task in the project the work belongs to, not here, so it carries that project's rules and skills (how to build, test, open and follow up a pull request).
- A task started for a piece of work does that work itself; it does not hand it on again.

## Improving how you work

- Write down how Cindy should work: steps, conventions, checklists, things to avoid.
- Cindy may edit this file and the skills in `.agents/skills/` to improve its own way of working. Changes apply to the next task; versions are kept, so any edit can be reviewed and undone.
- Who the teammate is (name, personality, relationship) stays in its profile, not here.
- Unfinished items carried over from before the upgrade are in `CARRYOVER.md`. Work through them when relevant and remove what is done.

## 项目结构

- 本项目内部按功能与职责命名目录，不使用数字编号前缀。
- `extension/` 是唯一可加载的浏览器扩展；`mock/` 放模拟服务、夹具与页面；`tests/extension/` 和 `tests/mock/` 放对应测试；`scripts/` 放开发验证工具；`research/` 保留探索性脚本与研究记录。
- 依赖、锁文件与 npm 命令统一维护在项目根目录。目录调整时同步更新脚本、测试、文档和页面提示中的路径。

## 插件开发与 mock 页面

- 扩展版本号以 `extension/manifest.json` 为准，使用三段数字 `主版本.次版本.修订号`。同批变更按最高级别升版一次：不兼容变更升主版本，向后兼容的新功能升次版本，向后兼容的问题修复升修订号。升主版本或次版本时，将其右侧的数字归零。仅修改文档、测试或开发工具时不升扩展版本。
- 除非用户特别说明，插件功能开发、调试、验证和测试默认使用 `mock/` 的本地 mock 页面。新功能需要的页面结构、模拟接口和测试数据应一并补充，使相应行为可以在 mock 中重现。
- 只维护一份扩展，通过页面地址区分真实站点与 mock 流程，不另打测试包。插件按账号维度存储数据；访问 mock 页面必须使用独立的模拟账号命名空间，不得将模拟记录写入或归属到真实账号。
- 仅对明确匹配的本地 mock 地址跳过采集请求间隔、周期休息及异常后的限速冷却等等待；保留错误报告、停止、超时和数据完整性保护。真实 BOSS 页面继续执行原有请求限制。修改规则或构建地址时要分别验证 mock 和真实站点分支。
- 本地启动、加载扩展及模拟场景的说明见 `mock/README.md`。
