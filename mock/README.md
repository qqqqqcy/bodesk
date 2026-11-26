# Mock BOSS · 本地沟通实验室

为项目根目录的 `extension/` 提供轻量、可重置的开发环境。页面使用 Vite + React + TypeScript，模拟服务使用 TypeScript 和 Node.js 自带 HTTP 服务，无需登录真实 BOSS。姓名、账号、公司、职位与聊天记录均为虚构数据；消息操作只修改本地服务的内存数据。

## 启动

支持 Node.js 22.22.2+（22.x）、24.15+（24.x）或 26+。以下所有命令均在项目根目录执行：

```bash
npm ci
npm run dev
```

打开 <http://127.0.0.1:4173/web/geek/chat>。开发命令同时启动 Vite 热更新和扩展持续构建；模拟服务与夹具修改会自动重启。生产预览使用 npm start，先类型检查并构建，再提供 mock/dist 中的页面。服务仅监听 `127.0.0.1`，不请求或代理真实网站。重启服务会清空所有网页模拟会话。

页面提供联系人搜索、聊天、加载更早消息、职位详情和模拟消息 / 简历操作。顶部可切换场景与账号；底部可展开请求日志与插件事件。320px 窄屏会改为上下布局。

## 与现有扩展联调

只安装现有的一份扩展：在 Chrome / ego 的扩展管理页开启开发者模式，选择“加载已解压的扩展程序”，加载项目根目录的 `extension/`，然后刷新 mock 聊天页。同一份扩展同时匹配真实 BOSS 与本地 mock，不生成第二个包。页面右下角会出现插件浮窗，通过浮窗修改状态、备注和删除职位；在「JD 看板」中按所选范围采集、导出或导入 JSON。备注保存在插件本地，不由 mock 服务提供。

仅当页面 origin 精确匹配插件配置的本地 mock 地址，插件跳过首次及相邻请求间隔、每 20 次周期休息、异常后的冷却及 Retry-After 等待。模拟接口返回 429、异常数据等时，本次采集仍会停止并报告错误，但可立即手动重试；请求超时、停止、游标和写入确认保护仍然有效。可在采集页测试按账号保存请求间隔。模拟采集跳过等待，真实 BOSS 页面使用设定的最短间隔，并继续执行周期休息和异常冷却。测试接口读历史不会清除未读；点击联系人会模拟网页正常打开会话并清零未读。

切换场景或账号会重建当前浏览器会话的网页数据并刷新页面。**插件已经保存的 IndexedDB 不会随场景重置而清空**。会话与 JD ID 包含账号和场景（例如 `alpha-normal-boss-1`、`alpha-ambiguous_resume-job-fullstack`），不同场景的数字消息 ID 也使用独立区间。切换场景会在插件中新增一套会话 / JD 记录，旧场景记录仍保留；在同一场景内重置与重新采集可验证去重和历史保留。公司名称仍用于插件的公司聚合，因此同名公司下可看到多个场景的独立 JD。两个模拟账号使用不同 ID，并在哈希前加入专用的 `boss:mock:` 命名空间；即使用户 ID 与真实账号相同，插件账号标识也不同。mock 与真实账号共用扩展数据库，但记录按账号隔离，采集页面中切换账号查看，不会混入真实账号的数据。

本地 mock 使用 `http://127.0.0.1:4173` 或 `http://localhost:4173`。需要改端口时，同时修改 `extension/manifest.json`、`extension/src/main.ts` 的 `MOCK_ORIGIN`、`extension/src/background.ts` 的 `SITE_ORIGINS` 和 `extension/src/status.ts` 的本地链接白名单及 `scripts/dev.ts` 的监听端口；仍是同一份扩展，不另建包。

## JD 看板

自己发出的最后一条对话会显示「已送达」或「已读」。可在模拟聊天页发出一条消息，再点「对方已读」，检查浮窗和看板的标识是否跟随更新。

在「日常沟通」场景采集后，点浮窗的「JD 看板」直接打开当前模拟账号的看板。每个 JD 在一行内显示公司、薪资、地点、经验和学历等信息，「简历已查看」组排在「简历已发送」组上方，两组都排在待回复的组上方。给一个 JD 发送模拟面试邀请，或用浮窗手动设置为「面试通过」，检查该 JD 是否移到对应组。切换账号，确认看板只显示所选账号的职位。

点击任一状态组名称，确认该组可独立收起和展开。查看已发送简历、已查看简历等组的「状态时间」和「最后一条对话」，与对应模拟消息的时间比较。再次采集相同消息后，时间应保持一致。追加一条当天的模拟对话，确认结束日期选为当天时对应职位可见。把结束日期移到前一天，确认该对话从结果中排除。重新打开看板，核对两个滑块和各组展开状态是否保留。 调整活动日期后点「采集所选范围」，在请求日志确认过早的会话被跳过。导出再导入同一份备份，确认重复记录被跳过。

## 职位详情浮窗

打开本地 `/gongsi/job/mock-company~.html?ka=company-jobs`，检查浮窗显示公司和当前职位。切换职位时，确认浮窗高亮跟随，浏览本身不会写入 JD。

从顶部“职位列表”进入 /web/geek/jobs。先在聊天页加载模拟记录，再返回职位列表，依次选择已沟通职位、同公司“尚未沟通的新职位”和“未沟通示例公司”。切换后应高亮当前职位，新职位先显示为临时行。浏览未收藏岗位不增加公司、JD、对话或事件。打开独立详情页，验证可以保存公司备注、JD 备注及状态。再从浮窗进入「JD 看板」，确认可读取并修改相同记录。列表场景使用模拟账号，和真实账号隔离。

职位列表数据由 /__mock/jobs 提供，按 2026-11-17 在真实页面核对的组件结构生成，所有账号、公司和 ID 均为模拟值。外层 .job-detail-container 不带 Vue 实例；内层 .job-detail-box 的 JodCardDetail 通过 props.data 传入 jobInfo 和 brandComInfo，公司名位于独立的 brandComInfo.brandName。选中卡片为 .job-card-wrap.active，JodCard 的 props.data 保存 encryptJobId、jobName 和 brandName，卡片 DOM 使用 .job-name 与 .boss-name。PageJobs 同时保留 jobList、currentJob、jobDetail 与 jobDetailLoading。

夹具包含已存 JD、同公司未存 JD、未存公司，以及同公司同标题但不同 ID 的 JD。后一种应同时显示旧记录和当前临时行，仅高亮当前行。将“详情加载”切换为“延迟 1.5 秒”后点选另一家公司，浮窗应跟随当前卡片。连续快速点选时，过期详情响应不能覆盖最后选中的职位。

扩展重新加载后，已经打开的页面可能保留失效连接；必须刷新用户原来的职位标签再验证，不能只在新标签验证。真实页验收需同时核对选中的公司 / JD、浮窗中的已存记录和高亮、浏览前后的本地记录是否一致。功能约束不显示为浮窗说明文案。

## 收藏岗位与详情链接

收藏列表中的「已下架的收藏职位」和对应详情页都提供关闭标记。切换到不限范围后，看板应显示该职位和星标及「职位已关闭」标记。

在「公司收藏」中可测试同时有职位的公司和仅收藏的公司。回到公司在招页和 JD 看板核对公司的楼宇图标和职位的星标。无状态时间的收藏职位需将开始设为「不限」、结束设为当天才会显示。取消公司收藏后，职位的星标和沟通记录仍在。

从顶部“收藏职位”进入 /web/geek/recommend?tab=4&sub=1&tag=4。夹具包含聊天中已有的前端 JD、仅收藏的全栈 JD，以及已下架的收藏 JD。页面结构来自真实个人中心：只有 personal_top_interest.current 与 personal_sub_position_focus.current 同时激活时读取 .user-jobs-ul .item-boss；公司名来自 .company-info 中的 personal_interest_brand 标记，JD 名来自 .job-name-text，ID 来自 .job-info a.name 的详情链接。旁边的推荐链接不得入库。

GET /__mock/favorites 返回当前模拟收藏；POST /__mock/favorite 接收 jobId 与 favorite，切换收藏但不改聊天记录。职位列表和详情页的收藏按钮使用同一个模拟状态；职位数据中的 relationInfo.interestJob 对应真实页面的收藏布尔值。首次收藏可新增公司 / JD，重复读取按账号与 JD 去重。验证浮窗显示“已收藏”，同时保留原沟通状态与备注；点击其中 JD 标题应在新标签打开相同账号环境的详情页。取消仅收藏、无对话的 JD 时，浮窗应隐藏该 JD；已有对话的 JD 继续显示其沟通状态。重新收藏或后续产生对话时，原有记录和备注应恢复展示。

## 删除指定 JD

模拟职位列表提供“卡片删除演示职位”。先在模拟职位页收藏它，使其进入浮窗；然后直接点击对应浮窗卡片上的“删除”。可先取消确认，再确认删除；应保留其他职位和聊天。返回模拟收藏页或重新采集后，已删除的 JD 不应重新出现。

每个模拟会话及场景重置都会生成新的演示职位 ID，方便重复测试，仍使用模拟账号命名空间，不影响真实账号。

## 场景

| 场景 key | 行为 |
| --- | --- |
| `normal` | 16 位联系人；星河科技 4 个 JD、前端 JD 两位联系人、质量 JD 无消息；其他会话各 4 条消息，包含多种简历标签、后续普通消息、审核中、撤回、纯系统消息、dialog 卡片、缺少 JD、未知未读和长 HTML 文本 |
| `unknown_direction` | 林沐、周然、何悦的消息方向均不可判定；三个演示会话各自独占 JD，列表方向依次为 true / false / null，对应待 Boss 回复 / 待自己回复 / 待确认 |
| `ambiguous_resume` | 不同简历标签时间相同、时间均缺失，以及单条无时间标签对照 |
| `multipage` | 每人 45 条消息，按 20 / 20 / 5 分页 |
| `empty` | 已加载且到尾的空列表 |
| `partial` | 起初只加载 3 位，列表未到尾，可手动加载剩余联系人 |
| `stalled` | 第二页继续报告 hasMore，但返回重复游标 |
| `rate_limit` | 第一页正常，第二页 HTTP 429，Retry-After 为 600 秒 |
| `unauthorized` / `forbidden` | API 返回 HTTP 401 / 403 |
| `server_error` | 历史 API 返回 HTTP 500 |
| `invalid_json` | 历史 API 返回 HTML |
| `malformed` | 历史 messages 字段类型错误 |
| `business_error` | 历史 API 返回 code=37 |
| `slow` | API 延迟 16 秒，供验证原插件 15 秒超时及停止 |

HTTP 异常也会影响网页自身读取，页面会显示错误提示；插件仍能通过已加载的联系人尝试采集。修复场景后刷新页面会重新建立插件页面上下文。简历按钮生成系统消息标记与标签（type=1 / body.type=4），索要简历生成只有 `dialog.content` 的请求卡片（body.type=7，text 为空）；不模拟真实附件上传。

## 操作与插件覆盖

| 操作 kind | 页面按钮与效果 |
| --- | --- |
| `text` / `read` | 发送普通消息 / 将自己发送的消息标为已读 |
| `apply_resume` / `resume` / `view_resume` | 附件简历请求已发送 / 简历已发送 / 对方已查看的系统标签 |
| `request_resume` | 对方索要附件简历的 dialog 卡片 |
| `withdraw` | 追加对方撤回消息占位，供验证回退上一条真人消息 |
| `unknown_resume` | 追加“对方正在审核您的附件简历”系统提示 |
| `resume_failed` | 追加简历发送失败与被拒绝系统提示 |
| `switch_job` | 选中同公司另一 JD 并更新列表和详情；星河科技提供多个目标，其他公司无目标时显示错误 |
| `open` | 点击联系人时清除其模拟未读；不属于只读采集 |

| 插件功能 | mock 验证方式 |
| --- | --- |
| 自动状态 | normal 覆盖 `resume_event` 多种标签、`resume_requested`、`awaiting_self`、`awaiting_boss`、`unknown`；简历标签后有普通聊天、审核中保留证据、撤回回退、仅系统消息待确认、dialog 卡片 |
| 歧义 | `unknown_direction` 验证列表回退或待确认；`ambiguous_resume` 验证同时间 / 缺失时间冲突和单标签对照 |
| 公司 / JD、时间排序 | 星河四个 JD 的有消息会话起始时间不同，质量 JD 无消息；前端多联系人；`switch_job` 可制造同一会话先后关联多个 JD。无时间排最后由插件决定 |
| 面试卡片 | 在聊天页使用“对方发面试邀请”“接受面试邀请”和“对方取消面试”，验证浮窗自动显示“面试中”以及取消后恢复其他沟通状态 |
| 最新人工消息 | 追加“竞争情况卡片”或“微信交换卡片”，浮窗应继续显示上一条普通聊天。手动发送同样的文字时，该条消息应正常显示 |
| 手动状态与备注 | 手动选择“面试通过”“面试失败”或“对方拒绝沟通”，再追加消息或重新采集。手动状态应保留，选“跟随自动判断”后恢复最新自动状态 |
| 失败与保护 | 异常、慢接口、多页、游标停滞、停止、部分加载场景；插件不应把不完整采集标为完成 |
| 账号隔离 | alpha / beta 切换、独立 mock 命名空间；同浏览器会话切换后插件已保存数据保留 |
| 职位页 | 点击有 JD 的职位条，检查职位 / 公司上下文；无 JD 联系人不提供职位链接 |
| 只读采集 | 接口 GET 不清未读；用户点击联系人会模拟网页打开并清未读 |
| 长文本与 HTML | 姓名和职位含 `<script>` 与长文本，供页面和插件文本渲染安全验证 |

## 方向缺失场景的页面复现

在「日常沟通」场景中打开唐溪的空会话，点击「竞争情况卡片」。即使聊天区显示这张系统卡片，职位仍应显示「待沟通」。发送一条模拟文本后，浮窗应切换到「待 Boss 回复」。

启动本地服务并加载现有扩展后，打开聊天页，在顶部选择 `unknown_direction`（任一模拟账号均可）。依次点击以下联系人，查看插件浮窗中高亮的当前 JD；如曾手动修改该 JD 的状态，先选“跟随自动判断”。

| 点击联系人 | 当前 JD | 列表 lastIsSelf | 浮窗结果 |
| --- | --- | --- | --- |
| 林沐 · 星河科技 | 前端工程师（独占演示 JD） | true | 待 Boss 回复 |
| 周然 · 星河科技 | 全栈工程师（独占演示 JD） | false | 待自己回复 |
| 何悦 · 云帆数据 | 数据平台工程师（独占演示 JD） | null | 待确认 |

三个会话的消息都缺少或无法识别 from/to。林沐、周然从列表方向回退；何悦连列表方向也为空。演示会话与 JD ID 以 `-direction` 结尾，避免同 JD 其他联系人或以前采集的夹具证据影响当前结果；姓名和职位标题保持原样。切换后可在采集页面更新全部已加载会话，再点击上述联系人，结果应保持一致。公司下其他历史 JD 仍可能显示在浮窗中，以高亮的当前 JD 为准。

## 验证

```bash
npm run test:mock
npm run check
```

运行全部测试使用 `npm test`；仅运行扩展测试使用 `npm run test:extension`。

自动化测试覆盖固定夹具、消息操作、状态规则、真实 HTTP 分页、未读副作用、cookie 会话隔离、异常响应，以及单一扩展的双站点声明和 mock 账号命名空间。所有场景的会话 / JD / 数字消息 ID 均检查跨场景无重叠；HTTP 回归测试模拟插件按会话保存旧记录，验证 normal 切换到 ambiguous_resume / unknown_direction 后仍能分别得到缺失时间 / 方向缺失的待确认状态。集成测试在 VM 中执行**源扩展的 MAIN 脚本**，请求真实本地 HTTP 接口，验证多页采集、429 后保留已确认页并可立即重试、游标停滞、停止和账号切换。测试模拟持久化确认；不会代替浏览器 IndexedDB 或完整扩展安装的验证。扩展测试位于 `tests/extension/`，mock 与集成测试位于 `tests/mock/`，其中同步与后台测试同时覆盖真实地址和 mock 分支。

安装并运行 ego-browser 后，可以运行浏览器冒烟测试。命令自动构建，并在临时端口启动独立 mock，避免已安装扩展与注入测试浮窗重叠；完成后关闭临时服务和测试空间：

```bash
npm run test:browser
```

它验证发送、姓名和职位的文本转义、dialog 卡片、系统消息及切换 JD 的插件页面快照、简历、已读、搜索、加载联系人、空账号、切换账号、45 条分页、职位页及构建后的扩展 MAIN 脚本的页面观察和 mock 账号标识，并检查 `window.__xss` 未被设置和 320px 宽度无水平溢出。它还通过页面切换 normal → ambiguous_resume / unknown_direction，验证会话 / JD / 消息 ID 不重叠，以及源插件 `inferStatus` 的待确认结果。方向场景还用源插件 `mergeJob` 聚合全部会话贡献，再运行构建后的 content 脚本，逐一点击上述三位联系人，验证浮窗当前 JD 的三种结果。截图写入 `artifacts/desktop.png` 与 `artifacts/mobile.png`，完成后关闭测试空间。安全渲染检查运行未修改的构建后的 MAIN 与 content 脚本，并使用本地替身提供 content 的后台响应；它不验证真实 IndexedDB 持久化。此命令不自动安装浏览器扩展；需要完整浮窗与采集页面联调时按前述步骤加载现有扩展。可用 `MOCK_ORIGIN` 指定已有测试地址，该地址不应有其他扩展自动注入。mock 样式同时包含浮窗样式，供独立端口的浏览器测试使用。

## 开发接口与结构约定

| 接口 | 用途 |
| --- | --- |
| `GET /__mock/state` | 当前场景、账号、场景目录 |
| `POST /__mock/state` | `{scenario, account}`，重置当前 cookie 会话；省略字段沿用当前值 |
| `GET /__mock/list` | 当前加载的联系人；`?all=1` 获取全部 |
| `POST /__mock/action` | `{bossId, kind, text?}`；kind 为 text / open / read / apply_resume / resume / request_resume / view_resume / withdraw / unknown_resume / resume_failed / switch_job |
| `GET /__mock/requests` | 当前会话最近 300 条插件兼容接口请求 |
| `GET /wapi/zpchat/geek/getBossData?bossId=…` | 原插件兼容的 `{code, zpData:{data,job}}` |
| `GET /wapi/zpchat/geek/historyMsg?bossId=…&maxMsgId=0&c=20&page=1` | `{code,zpData:{messages,hasMore,minMsgId}}`；后续页以 minMsgId 作为 maxMsgId |

`mock/fixtures.ts` 导出 `createWorld`、`listRows`、`historyPage`、`appendMessage`，可直接用于后续单测。数据通过浏览器 HttpOnly cookie 隔离，同一浏览器空间的标签共享模拟账号与场景，重置后其他已打开标签需刷新；不同客户端的 cookie 会话互不影响。

页面保留原插件读取的 `window._PAGE.uid`、App `__vue__.$store.state.userInfo`、`boss-list.fullList / bottomText / isLoading`、`.chat-record.__vue__.boss`、`.message-item.__vue__.$props.message` 及职位页选择器。React 组件通过 DOM ref 暴露这些兼容对象，不引入 Vue 运行时。页面结构或源扩展约定变更后，应同步修改适配对象、夹具及集成测试。
