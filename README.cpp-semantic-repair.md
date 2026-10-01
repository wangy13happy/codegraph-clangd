# C/C++ 编译语义修复分支

本分支 `feat/cpp-semantic-repair-v1.6.0` 基于 [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) 的 `v1.6.0`，保留上游历史和 MIT 许可。产品及补充测试快照为 `5c32d24f6fe571947fc1d694e2fc2cc37271f4b5`，后续发布提交补充本说明。

上游 npm 包、安装器和 `codegraph upgrade` 不包含本分支修改。`package.json` 的版本仍为 `1.6.0`，请同时记录 Git commit，避免仅凭版本号判断实现。

## 本分支增加的能力

- 使用真实 `compile_commands.json` 和 clangd 修复受编译条件影响的函数定义、直接调用及调用位置；union 图保留各编译视图的来源。
- 查询项目内宏的完整定义范围；对受支持的宏展开直接调用，用 libclang 导出真实目标身份和展开证据，保留调用点、宏定义、编译视图及来源。
- 为上述真实调用所需的外部目标创建最小 symbol stub；外部和项目内同名符号身份分离，不递归索引依赖源码树。
- 保留条件函数指针 typedef 的结构 alternatives，并将经真实 TU 引用和 clangd definition 确认的 active binding 单独记录。没有有效证据的 alternatives 保持未知，inactive alternative 不作为当前视图的有效绑定。
- 使用 identifier component 等信号进行确定性搜索排序；沿用现有事务、provenance、fingerprint 和 reconciler 更新语义支持，撤销旧视图、调用边及失去引用的外部 stub。

这不是完整 C/C++ 编译器前端、预处理器数据库或任意 alias chain 解析器。clangd、编译数据库和原生补证的覆盖情况决定可用事实；`partial`、`stale` 或 unavailable 表示证据不完整，不能据此断言某符号不存在。

## 从本 fork 安装

已验证的环境是 Linux x86_64、Node **24.15.0**、clangd **19.1.7**、Python 3 和 libclang **19**。源码依赖 `node:sqlite`，不能使用系统 Node 20；当前 CLI 也拒绝 Node 25 及以上。其他平台未在本分支的这轮验证中验收。

从当前 fork 的 **Code** 菜单复制 clone URL，然后执行；将占位符替换为实际 URL：

```bash
git clone --branch feat/cpp-semantic-repair-v1.6.0 '本fork的clone-URL' codegraph
cd codegraph
node --version
npm ci --ignore-scripts
npm run build
node dist/bin/codegraph.js --help
git rev-parse HEAD
```

让 `node` 实际指向 Node 24，并把 checkout 放在稳定目录。`--ignore-scripts` 避免安装生命周期脚本改写 agent 配置；下面直接配置 MCP，不需要执行上游交互安装器。

部署产物必须包含 `dist/`、WASM/schema、`scripts/cpp-native-callees.py` 和生产依赖。`npm pack --ignore-scripts` 会包含必要 helper；当前上游 `build-bundle.sh` 不复制 `scripts/`，不能直接用于打包此原生补证能力。

## 项目配置与可信运行时

先按项目原有构建流程生成真实编译数据库。不要为达到验收结果添加不存在的 `-D` 或伪造编译命令。在项目根的 `codegraph.json` 中合并以下配置，保留已有字段：

```json
{
  "cppSemanticRepair": {
    "enabled": true,
    "mode": "union",
    "compileCommands": "compile_commands.json"
  }
}
```

项目配置的数据库路径必须位于真实项目根目录内。外部数据库由用户通过 `CODEGRAPH_COMPILE_COMMANDS` 或 CLI `--compile-commands` 显式选择。没有 opt-in 时仍走原结构索引路径；编译上下文缺失或依赖不可访问时会公开降级情况。

在用户侧固定可信运行时，以下是已验证 Linux 环境的示例路径，请按实际安装位置调整：

```bash
export CODEGRAPH_CLANGD_PATH=/usr/bin/clangd-19
export CODEGRAPH_NATIVE_PYTHON_PATH=/usr/bin/python3
export CODEGRAPH_LIBCLANG_PATH=/usr/lib/x86_64-linux-gnu/libclang-19.so.19
export CODEGRAPH_NO_DAEMON=1
export CODEGRAPH_TELEMETRY=0

node /absolute/path/codegraph/dist/bin/codegraph.js init /absolute/path/project
node /absolute/path/codegraph/dist/bin/codegraph.js status /absolute/path/project
node /absolute/path/codegraph/dist/bin/codegraph.js explore "目标符号" --path /absolute/path/project
node /absolute/path/codegraph/dist/bin/codegraph.js sync /absolute/path/project
```

clangd 与 libclang 使用匹配的已安装版本。本示例不设置 `CODEGRAPH_CLANGD_QUERY_DRIVERS`，保持空 allowlist；确需交叉编译 driver 时，只在用户侧明确授权可信绝对路径。项目配置不能授权 executable 或 query-driver；编译数据库中的 compiler/command 不由 CodeGraph 直接执行，但原有或显式授权的 clangd query-driver 行为仍受用户 allowlist 控制。

`CODEGRAPH_NO_DAEMON=1` 避免本修改版复用同版本号的上游 daemon。索引范围应为实际项目工作树，不能指向整个 home、SDK 或依赖仓库。

## 在 Codex 中使用

在用户 `~/.codex/config.toml` 中配置唯一的 CodeGraph MCP；合并已有配置并替换以下绝对路径，不要重复声明同名表：

```toml
[mcp_servers.codegraph]
command = "/absolute/path/node24/bin/node"
args = ["/absolute/path/codegraph/dist/bin/codegraph.js", "serve", "--mcp"]
startup_timeout_sec = 60
tool_timeout_sec = 120

[mcp_servers.codegraph.env]
CODEGRAPH_MCP_TOOLS = "explore,node,search"
CODEGRAPH_CLANGD_PATH = "/usr/bin/clangd-19"
CODEGRAPH_NATIVE_PYTHON_PATH = "/usr/bin/python3"
CODEGRAPH_LIBCLANG_PATH = "/usr/lib/x86_64-linux-gnu/libclang-19.so.19"
CODEGRAPH_NO_DAEMON = "1"
CODEGRAPH_TELEMETRY = "0"
```

重新打开 Codex 会话以加载连接，并核对 `codex mcp list` 的真实 command/args。项目 `.codex/config.toml` 可能覆盖全局配置，也需要核验。

可在用户或项目 `AGENTS.md` 中加入简洁路由：

> 已有 `.codegraph/` 索引的项目，查符号、调用链、模块结构或修改影响时，优先用 `codegraph_explore`，传真实工作树的绝对 `projectPath`；需要定位或消歧时再用 `codegraph_search` / `codegraph_node`。精确文本、配置、文档和已知文件直接读取。未索引项目跳过图工具；过期或 partial 时核对原文件，源码补查不算图证据。C/C++ 编译语义必须项目显式 opt-in 并提供真实编译数据库。

## 增量同步与成本边界

源码、条件声明、编译参数或编译数据库改变后使用同一 `sync` 入口更新。宏目标改变会撤销旧调用支持；移除一个 compile view 只撤销该 view 的支持；最后一条真实项目引用消失后回收无引用 external stub。依赖信息无法重新确认时，保留已知证据并公开 stale/不完整状态，不能把采集失败当成证明目标已经消失。

原生补证由真实项目 TU 内的宏调用候选触发，候选文本仅用于限定采集范围，语义目标必须由 compiler 信息证明。采集有请求、时间、字节和 AST/调用数量预算，超限按不完整处理；不会因为一个外部调用就把 libc、SDK 或整棵依赖树纳入普通项目图。项目根内自带的第三方文件仍可能影响普通结构索引成本，可以用现有 `codegraph.json` 的 `exclude` 收窄结构范围；本分支没有新增按库名判断的排除特例。

编译语义比原结构索引更昂贵。不能把单个 synthetic fixture 的时间外推到任意项目，也不能将不同环境或不同采样过程的性能数字混算。

## 已完成的验证与限制

以下是此前固定快照的验证记录，README 发布只修改文档，没有重新运行这些验收或完整套件：

| 验证范围 | 已记录结果 |
|---|---|
| PR6 冻结验收，独立验收快照 `179e399` | pure-graph 33/33；fallback 33/33；31/31 audited 调用点；5/5 条件回调 |
| 补充复杂测试首次统一运行，`9a978e2` | 9 文件 139/139，通过，零跳过 |
| 独立审查收紧断言后的新增测试，`5c32d24` | 6/6，通过，零跳过；并未重跑上行全部 139 项 |
| `5c32d24` 部署产物 | 重新构建、CLI 原生宏外部调用及 sync、三种 MCP 根选择和正常退出通过 |
| 实际 Codex 提示词路由 | 四个具体样本通过；不代表所有未来措辞或项目均覆盖 |

补充测试覆盖多 TU × 多视图条件宏、外部/本地同名身份、同物理声明不同 USR、三分支 typedef 和 `-D/-U`、依赖访问失败与恢复，以及大量候选的稳定排序。均为公开可发布的合成 fixture，不需要业务源码。

在已安装 Node 24、clangd/libclang 19 的环境中，可复验相关测试和完整套件：

```bash
npm test -- --maxWorkers=1 --minWorkers=1 \
  __tests__/cpp-semantic-complex.test.ts \
  __tests__/cpp-native-callees.test.ts \
  __tests__/cpp-semantic-repair.test.ts \
  __tests__/cpp-semantic-facts.test.ts \
  __tests__/cpp-semantic-inputs.test.ts \
  __tests__/segment-vocab.test.ts

npm test
```

完整 `npm test` 历史运行有失败，包括超时及部分尚未确定根因的失败；不能宣称全套全绿，也不能因 baseline 同样失败而删测试。冻结业务验收材料留在本地，不随本 fork 发布。上述局部和部署验证不替代完整回归。
