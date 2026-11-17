# BOSS 沟通助手

本地 Chrome Manifest V3 扩展，在 BOSS 网页浮窗中整理公司、职位、沟通状态与备注，并提供聊天记录采集和 JSON 导出。数据保存在浏览器本地，按账号隔离；本地 mock 使用独立的模拟账号命名空间。

## 项目结构

```text
extension/               可直接加载的浏览器扩展（唯一一份）
mock/                    本地模拟服务、场景夹具和网页
  public/                模拟 BOSS 页面
research/
  chat-export/           早期聊天导出研究与有限样本脚本
scripts/                 语法检查和浏览器冒烟工具
tests/
  extension/             扩展状态、存储、页面识别与同步测试
  mock/                  模拟服务与扩展集成测试
package.json             统一依赖和开发命令
package-lock.json        依赖锁文件
```

目录按职责命名。扩展无需打包，mock 无运行时 npm 依赖；根目录只维护一份依赖和锁文件。`node_modules/`、`artifacts/` 和 `private-exports/` 是忽略提交的本地目录，分别用于依赖、浏览器截图和研究导出数据。

## 本地开发

需要 Node.js 20 或更新版本。以下命令均在项目根目录执行：

```bash
npm ci
npm start
```

打开 <http://127.0.0.1:4173/web/geek/chat>。在 Chrome / ego 扩展管理页开启开发者模式，选择“加载已解压的扩展程序”，加载本项目的 `extension/`，再刷新 mock 页面。扩展同时支持真实 BOSS 与明确匹配的本地 mock 地址；默认在 mock 页面开发验证。

如果浏览器之前加载过旧目录，必须处理其加载路径。换路径可能改变解压扩展 ID，原扩展的本地数据不会自动迁移；请保留原安装并先导出重要数据，详见[扩展使用说明](extension/README.md)。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm start` | 启动本地 mock，默认监听 `127.0.0.1:4173` |
| `npm run dev` | 启动 mock 并监听文件变化 |
| `npm test` | 运行全部扩展、mock 和集成测试 |
| `npm run test:extension` | 仅运行扩展测试 |
| `npm run test:mock` | 仅运行 mock 与集成测试 |
| `npm run check` | 检查扩展、mock、测试、工具和研究脚本的 JavaScript 语法 |
| `npm run test:browser` | 使用 ego-browser 验证已启动的 mock 页面，截图写入 `artifacts/` |
| `npm run research:export` | 手动运行有限的真实账号聊天样本导出，结果写入 `private-exports/` |

浏览器冒烟需要已安装并运行 ego-browser；可通过 `MOCK_ORIGIN` 指定测试服务地址。研究导出会访问真实 BOSS，使用条件和范围见[聊天导出研究](research/chat-export/README.md)，不属于日常测试。

## 详细说明

- [扩展使用、数据范围与限制](extension/README.md)
- [mock 场景、接口与联调方法](mock/README.md)
- [聊天导出研究与历史验证](research/chat-export/README.md)
