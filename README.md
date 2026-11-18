# BOSS 沟通助手

本地 Chrome Manifest V3 扩展，在 BOSS 网页浮窗中整理公司、职位、沟通状态与备注，并提供聊天记录采集和 JSON 导出。数据保存在浏览器本地，按账号隔离；本地 mock 使用独立的模拟账号命名空间。

项目使用 Vite + React + TypeScript。浮窗、采集页和 mock 界面使用 React；后台、页面观察脚本、模拟服务与夹具使用 TypeScript，开启严格类型检查。

## 项目结构

```text
extension/               构建后加载此目录，唯一一份浏览器扩展
  manifest.json          Manifest V3 入口与站点权限
  src/                   React 页面、浮窗、后台和页面观察源码
  dist/                  Vite 生成的扩展脚本与页面，不提交
mock/                    本地模拟服务、场景夹具和网页
  src/                   React 页面与样式
  server.ts              模拟 HTTP 服务及静态资源入口
  fixtures.ts            场景数据
  dist/                  mock 生产构建，不提交
research/
  chat-export/           早期聊天导出研究与有限样本脚本
scripts/                 语法检查和浏览器冒烟工具
tests/
  extension/             扩展状态、存储、页面识别与同步测试
  mock/                  模拟服务与扩展集成测试
vite.config.ts           mock 开发与生产构建
vite.extension.config.ts 扩展多入口构建
tsconfig.json            TypeScript 严格检查
package.json             统一依赖和开发命令
package-lock.json        依赖锁文件
```

目录按职责命名。根目录统一维护依赖、锁文件和命令；Vite 构建产物保存在 extension/dist 和 mock/dist，不提交。`node_modules/`、`artifacts/` 和 `private-exports/` 是忽略提交的本地目录，分别用于依赖、浏览器截图和研究导出数据。

## 本地开发

支持 Node.js 22.22.2+（22.x）、24.15+（24.x）或 26+。以下命令均在项目根目录执行：

```bash
npm ci
npm run dev
```

打开 <http://127.0.0.1:4173/web/geek/chat>。在 Chrome / ego 扩展管理页开启开发者模式，选择“加载已解压的扩展程序”，加载本项目的 `extension/`，再刷新 mock 页面。扩展同时支持真实 BOSS 与明确匹配的本地 mock 地址；默认在 mock 页面开发验证。

本次迁移继续加载原来的 extension/，不要改为加载 extension/dist/。旧安装在首次构建后点击“重新加载”，再刷新 BOSS / mock 标签页；数据库名称与版本保持不变。

如果浏览器之前加载过其他旧目录，必须处理其加载路径。换路径可能改变解压扩展 ID，原扩展的本地数据不会自动迁移；请保留原安装并先导出重要数据，详见[扩展使用说明](extension/README.md)。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm start` | 类型检查并构建后启动生产版 mock，默认监听 `127.0.0.1:4173` |
| `npm run dev` | mock React 热更新、模拟服务自动重启、扩展自动构建并重载 |
| `npm run build` | 严格类型检查并构建扩展与 mock |
| `npm run build:extension` | 仅构建扩展 |
| `npm run typecheck` | TypeScript 严格检查 |
| `npm test` | 自动构建后运行全部扩展、React 界面、mock 和集成测试 |
| `npm run test:extension` | 仅运行扩展测试 |
| `npm run test:mock` | 仅运行 mock 与集成测试 |
| `npm run check` | TypeScript 严格检查与测试、工具、研究脚本语法检查 |
| `npm run test:browser` | 启动独立临时 mock，用 ego-browser 验证构建后的页面，截图写入 `artifacts/` |
| `npm run research:export` | 手动运行有限的真实账号聊天样本导出，结果写入 `private-exports/` |

安装支持自动重载的版本后，扩展会在浏览器运行时检查本地构建产物。构建成功且扩展文件有变化时，扩展会在采集和浮窗编辑结束后自动重载。已打开的本地 mock 页面随扩展重载自动刷新。已打开的真实 BOSS 页面在下次导航或刷新时使用新版。mock 服务或夹具修改会重启服务并重置内存中的模拟会话。

浏览器冒烟需要已安装并运行 ego-browser；默认在临时端口启动独立 mock，避免已安装扩展干扰测试，结束后自动关闭服务。可通过 `MOCK_ORIGIN` 指定已有测试服务；该地址不应有另一份扩展自动注入。研究导出会访问真实 BOSS，使用条件和范围见[聊天导出研究](research/chat-export/README.md)，不属于日常测试。

## 详细说明

- [扩展使用、数据范围与限制](extension/README.md)
- [mock 场景、接口与联调方法](mock/README.md)
- [聊天导出研究与历史验证](research/chat-export/README.md)
