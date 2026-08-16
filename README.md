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

本插件新增一个**可搜索、可逐级下钻的文件选择面板**替换默认窄菜单，数据由宿主半部提供：

```
dsh-input-file-ref (node half, lib/index.js — 零外部依赖，仅 node 内置)
  GET /api/input-file-list?sessionId=…&dir=<rel>     — 浏览模式：单层列目录
  GET /api/input-file-list?sessionId=…&query=<text>  — 搜索模式：递归 + 排除忽略目录
    ├─ 定位会话日志（$DSH_HOME/sessions 目录树）
    ├─ 读日志首条 session 记录 → 得到会话 cwd（绝不信任客户端传来的路径）
    └─ 目录/文件相对路径 + 大小 + mtime（不读取文件内容）
          │
          ▼  (浏览器 fetch，同源)
  文件选择面板 (client half, conversation.input.overlay) ── 顶部搜索栏 + 逐级下钻
    ├─ 与输入框同宽；默认只列 50 条，输入更多关键字显示更多
    ├─ 文件夹可一级级进入（含 .git / node_modules / target；搜索会排除它们）
    └─ 选中 → 保留 @ 并回填全路径（末尾一空格）──发送──► 模型读取该文件
```

**只读**：本插件不修改任何文件。宿主半部只**读取**会话日志头部与文件系统元信息（路径/大小/mtime），不读、不写、不删除任何文件内容。

## 2. 功能特性

- ✅ 输入 `@` 弹出**与输入框同宽**的选择面板，顶部带搜索栏。
- ✅ 顶部搜索栏：输入关键字即时**递归搜索**文件（大小写不敏感子串匹配；继续输入显示更多结果）。
- ✅ **逐级下钻**文件夹：点文件夹一层层进入；`.git`、`node_modules`、`target` 等目录**支持一级级往下选**，但**不出现在搜索结果里**（性能更好）。
- ✅ 文件行显示**相对全路径**，过长时**中间用 `…` 省略**。
- ✅ 默认只展示 50 条；输入更多关键字后逐步放宽到 100 / 200 / 500，减轻展示压力。
- ✅ 键盘（↑/↓/Enter/Esc）与鼠标均可选择。
- ✅ 选中后，**保留 `@` 并把文件相对全路径**以普通文本回填到输入框（末尾一个空格，示例 `@src/main.ts `，可直接编辑、删除、连续引用多个文件）。末尾空格让 `@` 不再触发选择，可继续正常输入。
- ✅ 发送后，消息中带有所引用的相对路径文本，模型可用自己的 fs 工具读取（沙箱以会话 cwd 为根）。
- ✅ 未选择工作目录的会话：面板显示提示，不崩溃。
- ✅ 与现有 `@` 技能/子代理引用共存。
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
    ├── index.js              # 宿主半部：/api/input-file-list（浏览 dir / 搜索 query）+ cwd 解析（零依赖）
    └── client.js             # 浏览器 bundle：'@' 文件源 + 自定义文件选择面板（insert + codec 路径）
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
2. 在输入框输入 `@` → 弹出**与输入框同宽**的文件选择面板。
3. **顶层 = 浏览当前目录**：直接看到当前目录的文件与子文件夹；点文件夹可逐级进入（`.git`、`node_modules`、`target` 等也会显示，可一级级往下选）。
4. **顶部搜索栏**（也可直接在输入框 `@` 后继续输入）：输入关键字即时递归搜索整个 cwd；默认只显示 50 条，**多输入几个字符**会显示更多（逐步放宽到 100 / 200 / 500）。
5. **返回上级**：当前进入某文件夹时，列表顶部有"↑ 上级目录"，或按 Backspace 返回。
6. 用 ↑/↓ + Enter（或鼠标点击 `📄` 文件行）选择文件 → **保留 `@` 并把文件相对全路径**以普通文本回填进输入框（末尾一个空格），例如 `@src/main.ts `。
7. 发送后，消息中带有所引用的相对路径，模型可用 fs 工具按该路径读取内容。
8. 删除/修改：回填的是普通文本，直接当作普通文字编辑或删除即可；末尾空格会让 `@` 停止触发选择；可连续引用多个文件（每次输入空格 + `@` 重新打开选择）。

未选择工作目录的会话：输入 `@` 时面板显示"当前会话没有工作目录"提示，不会崩溃。搜索时 `.git`、`node_modules`、`target` 等目录里的文件不会出现（但可以逐级进入选择）。

## 6. API 速查

```text
# 浏览模式：列出 dir（子路径，""=cwd）下的单层目录与文件
GET /api/input-file-list?sessionId=<sessionId>[&dir=<relative-dir>]

# 搜索模式：递归搜索整个 cwd（排除 .git/node_modules/target 等忽略目录）
GET /api/input-file-list?sessionId=<sessionId>...&query=<text>
```

- 需要浏览器信任围栏通过（loopback / `trustedHosts` + 同源校验），否则 `403`。
- 非法/未知 `sessionId` 返回 `404`（错误，而非任意路径内容）。
- 缺失 `sessionId` 返回 `400`。
- 非法 `dir`（含 `..`、绝对路径、反斜杠、盘符）返回 `400`；目录不存在返回 `404`。

浏览模式响应示例（`dir=src`）：

```json
{
  "mode": "browse",
  "cwd": "D:/workspace/MyProject",
  "dir": "src",
  "noCwd": false,
  "truncated": false,
  "dirs": ["util"],
  "files": [{ "path": "src/main.ts", "size": 2384, "mtime": 1719300000000 }]
}
```

搜索模式响应示例（`query=main`）：

```json
{
  "mode": "search",
  "cwd": "D:/workspace/MyProject",
  "noCwd": false,
  "truncated": false,
  "files": [{ "path": "src/main.ts", "size": 2384, "mtime": 1719300000000 }]
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
| `ignore` | `.git`、`node_modules`、`target`、`.venv` 等（见下） | 搜索模式下跳过的目录名列表（浏览下钻仍可进入）。默认忽略 `.git`、`node_modules`、`.venv`、`venv`、`__pycache__`、`.next`、`.nuxt`、`dist`、`build`、`target`、`.idea`、`.vscode`、`.DS_Store`。 |

> `ignore` 可在组合层覆盖：在 `cordis.patch.yml` 的 `config` 下追加即可（默认已内置，通常无需改动）。

## 8. 日志与排错

| 现象 | 排查方向 |
|---|---|
| 输入 `@` 无反应或无文件面板 | 确认 `dsh web` 已重启、插件是否加载；技能/子代理的 `@` 分组是否仍在（共存正常）。 |
| 面板一直"正在加载…" | 打开开发者工具 Network，检查 `/api/input-file-list` 状态；`403`=信任围栏拦截、`404`=会话未找到。 |
| 面板提示"当前会话没有工作目录" | 该会话未设置 cwd；请先选择工作目录。 |
| 搜索结果不全 / 找不到某些文件 | 它们可能在 `.git`/`node_modules`/`target` 等忽略目录里；请用浏览模式一级级进入选择。 |
| 只显示了 50 条 | 这是默认上限；输入更多关键字即可显示更多结果。 |

## 9. 安全与合规（务必阅读）

- **只读**：本插件不修改、不删除任何文件；宿主只读取会话日志头部与文件系统元信息，不读取文件内容。
- **路径红线**：cwd **仅**由会话持久化头部解析（会话创建时的绝对路径），**绝不信任客户端传来的任意路径**；`sessionId` 在拼路径前做单段转义，杜绝目录穿越。
- **浏览器信任围栏**：`/api/input-file-list` 仅接受 loopback 或声明 `trustedHosts` 的同源请求，拒绝 `sec-fetch-site: cross-site` 与 Origin 不同的请求，防 DNS 重绑定与跨站。
- **信息最小化**：仅返回相对路径、文件名、大小、mtime；不返回绝对路径，不返回文件内容。
- **会话定位仅限本机**：文件列表只服务本机会话日志，不对外暴露任意目录浏览能力。
- **repo 不携带私密信息**：无密钥、无本机绝对路径（文档用占位符 `<your-project>`）。

## 10. FAQ

- **Q：插件会读取文件内容吗？** A：不会。宿主只列元信息；选中的相对路径以文本回填，模型在收到后用自己的 fs 工具读取内容（沙箱以会话 cwd 为根）。
- **Q：可以引用多个文件吗？** A：可以。重复打开 `@` 面板选择，每次回填一个保留 `@` 的相对路径（末尾一空格），可连续引用多个。
- **Q：搜索时找不到 `.git`、`node_modules`、`target` 里的文件？** A：这些忽略目录默认不进搜索结果（性能考虑）。请在浏览模式下**点击文件夹一层层进入**，即可看到并选中它们里面的文件。

## 11. 开发与构建

纯 JS 无构建步骤（无需 GitHub Actions workflow）。分层：

- `lib/index.js`：宿主半部，**零外部依赖**（仅 `node:` 内置），因此无论以 git / registry / file: / link: 哪种方式安装都不会出现模块解析失败。
- `lib/client.js`：浏览器 bundle（经典脚本，`window.__ModuleLoader__.load`），注册 `@` 文件引用源 + 自定义文件选择面板（`conversation.input.overlay`）。

## 12. 相关文档

- 输入框引用契约：`@deepseek-ai/dsh-client-ui-input-trigger/lib/types/types.d.ts`
- 参照实现：技能 `/` 源 `@deepseek-ai/dsh-client-ui-skill`、子代理 `@` 源 `@deepseek-ai/dsh-client-ui-subagent`、exact 路由范例 [dsh-token-usage](https://github.com/AFAP/dsh-token-usage)。

## 13. License

MIT © AFAP
