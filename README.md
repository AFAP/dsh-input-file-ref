# 输入框文件引用插件 · Input File Reference

<div align="center">
  <b>中文</b> · <a href="README.en.md">English</a>
</div>

> **在会话输入框输入 `@`，像 Claude Code / Cursor 一样弹出当前工作目录的文件列表，选中后插入文件引用，模型即可读取该文件内容。**
> 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 输入框新增一个"文件"`@` 引用源，与自带的技能 / 子代理引用**共存于同一菜单**。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 1. 它解决了什么问题

dsh 输入框已有 `@` 触发管线（`dsh-client-ui-input-trigger`），但只支持技能（skill）和子代理（subagent）两类引用源。想引用工作目录里的某个文件时，没有对应的 `@` 源。

本插件新增一个 **文件引用源**，数据由宿主半部提供：

```
dsh-input-file-ref (node half, lib/index.js — 零外部依赖，仅 node 内置)
  GET /api/input-file-list?sessionId=…&query=…
    ├─ 定位会话日志（$DSH_HOME/sessions 目录树）
    ├─ 读日志首条 session 记录 → 得到会话 cwd（绝不信任客户端传来的路径）
    └─ 递归列出 cwd 下的文件（相对路径 + 大小），忽略 .git/node_modules 等
          │
          ▼  (浏览器 fetch，同源)
  '@' file source (client half) ── 输入 @ → 文件菜单（可搜索、键盘/鼠标可选）
    选中 → 草稿 chip (@src/main.ts) ──发送──► 模型看到 <file>src/main.ts</file>，用 fs 工具读取
```

**只读**：本插件不修改任何文件。宿主半部只**读取**会话日志头部与文件系统元信息（路径/大小/mtime），不读、不写、不删除任何文件内容。

## 2. 功能特性

- ✅ 输入 `@` 弹出当前会话工作目录（cwd）下的**递归**文件列表（相对路径 + 大小）。
- ✅ 继续输入过滤：大小写不敏感子串匹配，**优先文件名匹配**。
- ✅ 键盘（↑/↓/Enter/Esc）与鼠标均可选择，交互与 `/` 命令菜单一致。
- ✅ 选中的文件以 chip 显示（`@src/main.ts`），删除时整块消失。
- ✅ 发送后模型收到 `<file>相对路径</file>` 形式的引用，可用自己的 fs 工具读取（沙箱以会话 cwd 为根）。
- ✅ 未选择工作目录的会话：`@` 菜单显示提示，不崩溃。
- ✅ 与现有 `@` 技能/子代理引用共存，按分组显示。
- ✅ 中英双语界面文案，跟随界面语言。
- ✅ 只读、零外部依赖、浏览器信任围栏（防 DNS 重绑定 / 跨站）。

**MVP 暂不支持**：不内联文件内容到消息；不做文件预览/语法高亮；不做多选批量。

## 3. 目录结构

```
dsh-input-file-ref/           # 仓库根 = npm 包根
├── package.json              # dsh.bundle.patch + dsh.client（浏览器端声明）+ exports["./client"]
├── cordis.patch.yml          # 组合行：inject webRuntime + trustedHosts 配置
├── LICENSE                   # MIT
├── .gitignore
└── lib/
    ├── index.js              # 宿主半部：/api/input-file-list 路由 + cwd 解析 + 递归列文件（零依赖）
    └── client.js             # 浏览器 bundle：注册 '@' 文件引用源（insert + codec 路径）
```

## 4. 快速开始

一键安装（GitHub）：

```powershell
dsh plugin --profile web add github:AFAP/dsh-input-file-ref
```

然后**重启 `dsh web`** 生效。

> 安装后插件位于 `$DSH_HOME\profiles\web\node_modules\dsh-input-file-ref`（pnpm 从 GitHub 克隆），与源码仓库位置无关。

升级：

```powershell
dsh plugin --profile web update dsh-input-file-ref
```

卸载：

```powershell
dsh plugin --profile web remove dsh-input-file-ref
```

### 从源码目录手动安装（等价验证用）

```powershell
dsh plugin --profile web add "D:\path\to\dsh-input-file-ref"
```

### 验证是否加载成功

新建/打开一个已选定工作目录的会话 → 在输入框输入 `@` → 出现"文件"分组的文件列表即可。

## 5. 使用

1. **选定工作目录**：会话需要有工作目录（cwd）。
2. 在输入框输入 `@` → 弹出文件选择菜单（含"文件"分组）。继续输入字符按路径过滤。
3. 用 ↑/↓ + Enter（或鼠标点击）选择文件 → 草稿出现 chip（`@src/main.ts`）。
4. 发送后，消息中的引用以 `<file>src/main.ts</file>` 形式发给模型，模型可用 fs 工具读取内容。
5. 删除：选中 chip 按 Backspace / Delete 整块移除。

未选择工作目录的会话：输入 `@` 时菜单显示"当前会话没有工作目录"提示，不会崩溃。

## 6. API 速查

```
GET /api/input-file-list?sessionId=<sessionId>[&query=<substring>]
```

- 需要浏览器信任围栏通过（loopback / `trustedHosts` + 同源校验），否则 `403`。
- 非法/未知 `sessionId` 返回 `404`（错误，而非任意路径内容）。
- 缺失 `sessionId` 返回 `400`。

响应示例（`sessionId` 有工作目录）：

```json
{
  "cwd": "D:/workspace/MyProject",
  "noCwd": false,
  "truncated": true,
  "files": [
    { "path": "src/main.ts", "size": 2384, "mtime": 1719300000000 },
    { "path": "README.md", "size": 512, "mtime": 1719200000000 }
  ]
}
```

无工作目录的会话：

```json
{ "noCwd": true, "files": [] }
```

## 7. 配置项

| 键 | 默认值 | 说明 |
|---|---|---|
| `trustedHosts` | 来自 `webRuntime`（loopback + LAN + `--trusted-host`） | 浏览器信任围栏的非回环授权主机列表。 |
| `ignore` | `.git`、`node_modules`、`.venv` 等（见下） | 递归列出时跳过的目录名列表。默认忽略 `.git`、`node_modules`、`.venv`、`venv`、`__pycache__`、`.next`、`.nuxt`、`dist`、`build`、`.idea`、`.vscode`、`.DS_Store`。 |

> `ignore` 可在组合层覆盖：在 `cordis.patch.yml` 的 `config` 下追加即可（默认已内置，通常无需改动）。

## 8. 日志与排错

| 现象 | 排查方向 |
|---|---|
| 输入 `@` 无反应或无"文件"分组 | 确认 `dsh web` 已重启、插件是否加载；`@` 菜单里技能/子代理是否仍在（共存正常）。 |
| "文件"分组一直"正在加载…" | 打开开发者工具 Network，检查 `/api/input-file-list` 状态；`403`=信任围栏拦截、`404`=会话未找到。 |
| 菜单提示"当前会话没有工作目录" | 该会话未设置 cwd；请先选择工作目录。 |
| 结果过多提示 | 文件数超过上限（默认 500）；继续输入过滤后更精确。 |

## 9. 安全与合规（务必阅读）

- **只读**：本插件不修改、不删除任何文件；宿主只读取会话日志头部与文件系统元信息，不读取文件内容。
- **路径红线**：cwd **仅**由会话持久化头部解析（会话创建时的绝对路径），**绝不信任客户端传来的任意路径**；`sessionId` 在拼路径前做单段转义，杜绝目录穿越。
- **浏览器信任围栏**：`/api/input-file-list` 仅接受 loopback 或声明 `trustedHosts` 的同源请求，拒绝 `sec-fetch-site: cross-site` 与 Origin 不同的请求，防 DNS 重绑定与跨站。
- **信息最小化**：仅返回相对路径、文件名、大小、mtime；不返回绝对路径，不返回文件内容。
- **会话定位仅限本机**：文件列表只服务本机会话日志，不对外暴露任意目录浏览能力。
- **repo 不携带私密信息**：无密钥、无本机绝对路径（文档用占位符 `<your-project>`）。

## 10. FAQ

- **Q：插件会读取文件内容吗？** A：不会。宿主只列元信息；模型在收到 `<file>…</file>` 引用后，用**自己的 fs 工具**读取内容（沙箱以会话 cwd 为根）。
- **Q：多份文件引用可以吗？** A：可以连续插入多个 `@` 文件 chip，发送时逐一序列化为 `<file>…</file>`。
- **Q：为什么菜单分组标题显示 "file" 而不是"文件"？** A：`@` 菜单的分组标题由 dsh 内置的 `slash.menu` 词表决定（单持有者命名空间，第三方无法追加键），本插件无法注入本地化分组名；插件自身的提示/错误文案均中英双语。

## 11. 开发与构建

纯 JS 无构建步骤（无需 GitHub Actions workflow）。分层：

- `lib/index.js`：宿主半部，**零外部依赖**（仅 `node:` 内置），因此无论以 git / registry / file: / link: 哪种方式安装都不会出现模块解析失败。
- `lib/client.js`：浏览器 bundle（经典脚本，`window.__ModuleLoader__.load`），只注册一个 `@` 引用源，无 UI 组件。

## 12. 相关文档

- 输入框引用契约：`@deepseek-ai/dsh-client-ui-input-trigger/lib/types/types.d.ts`
- 参照实现：技能 `/` 源 `@deepseek-ai/dsh-client-ui-skill`、子代理 `@` 源 `@deepseek-ai/dsh-client-ui-subagent`、exact 路由范例 [dsh-token-usage](https://github.com/AFAP/dsh-token-usage)。

## 13. License

MIT © AFAP
