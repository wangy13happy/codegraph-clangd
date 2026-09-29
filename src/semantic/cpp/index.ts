/** @file 按编译视图独立采集 C/C++ clangd 事实；本模块不修改主图。 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CppSemanticRuntimeOptions } from '../../project-config';
import { CompilationDatabase } from './compile-database';
import { ClangdClient } from './clangd-client';
import { buildCompileViews, CompileView, materializeCompileView } from './compile-views';
import { documentSymbolFacts, incomingCallFacts, SemanticCallFact, SemanticSymbolFact,
  SemanticSourceLines, symbolIdentity } from './facts';

export { buildCompileViews, materializeCompileView } from './compile-views';
export { projectFileFromUri } from './facts';
export type { CompileView } from './compile-views';
export type { SemanticCallFact, SemanticSymbolFact, SemanticSymbolIdentity } from './facts';

export interface SemanticViewResult {
  id: string;
  key: string;
  inventory: 'authoritative' | 'advisory';
  grouping: 'cmake-target' | 'semantic-flags';
  success: boolean;
  coveredFiles: string[];
  failedFiles: string[];
  analyzedTuCount: number;
  failedTuCount: number;
  durationMs: number;
  error?: string;
}

export interface SemanticFactCollection {
  inventory: 'authoritative' | 'advisory';
  grouping: 'cmake-target' | 'semantic-flags';
  symbols: SemanticSymbolFact[];
  calls: SemanticCallFact[];
  views: SemanticViewResult[];
}

/**
 * @brief 从单个视图读取所有 TU，建立独立会话并采集不写图的语义事实。
 * @param[in] root 项目真实根目录
 * @param[in] view 已分组的编译视图
 * @param[in] runtime 仅用户侧授权的 clangd 路径和 query-driver 白名单
 * @param[in] signal 索引取消信号
 * @param[in] requestTimeoutMs 每请求超时毫秒数
 * @return 此视图的正向事实、精确覆盖范围与失败诊断
 */
async function collectView(root: string, view: CompileView, runtime: CppSemanticRuntimeOptions,
  signal?: AbortSignal, requestTimeoutMs?: number): Promise<{
    status: SemanticViewResult; symbols: SemanticSymbolFact[]; calls: SemanticCallFact[];
  }> {
  const started = Date.now();
  const files = [...new Set(view.entries.map(e => e.file))].sort();
  const failed = new Set<string>();
  const covered: string[] = [];
  const symbols: SemanticSymbolFact[] = [];
  const calls: SemanticCallFact[] = [];
  const sourceLines: SemanticSourceLines = new Map();
  let error: string | undefined;
  let client: ClangdClient | undefined;
  try {
    if (signal?.aborted) throw new Error('clangd collection cancelled');
    const compileDirectory = materializeCompileView(root, view);
    client = new ClangdClient(root, compileDirectory, runtime, signal, requestTimeoutMs);
    await client.start();
    const open: Array<{ file: string; uri: string }> = [];
    for (const file of files) {
      try {
        const absolute = path.join(root, file);
        const text = fs.readFileSync(absolute, 'utf8');
        const uri = pathToFileURL(absolute).href;
        sourceLines.set(file, text.split('\n'));
        client.didOpen(uri, /\.(?:c|h|i)$/i.test(file) ? 'c' : 'cpp', text);
        open.push({ file, uri });
      } catch (failure) {
        failed.add(file);
        error ??= String(failure);
      }
    }
    let indexReady = false;
    try {
      // clangd 的 sync 扩展等待已打开 TU、CDB 与后台索引空闲；普通请求的空结果不提供该证据。
      await client.waitForIndex();
      indexReady = true;
    } catch (failure) { error ??= `clangd index readiness unavailable: ${String(failure)}`; }
    for (const { file, uri } of open) {
      if (signal?.aborted) throw new Error('clangd collection cancelled');
      try {
        const discovered = documentSymbolFacts(root, uri, view.id, await client.documentSymbols(uri), sourceLines);
        let complete = indexReady;
        for (const { fact, position } of discovered) {
          symbols.push(fact);
          try {
            const items = await client.prepareCallHierarchy(uri, position);
            // 无 call-hierarchy 身份不能证明该函数没有 incoming 调用。
            if (!items.length) complete = false;
            for (const item of items) {
              const prepared = symbolIdentity(root, item.uri, item.kind, item.name, item.range, sourceLines);
              if (!prepared || prepared.filePath !== fact.filePath || prepared.kind !== fact.kind ||
                  prepared.name !== fact.name || prepared.endLine < fact.startLine ||
                  prepared.startLine > fact.endLine) {
                complete = false;
                continue;
              }
              calls.push(...incomingCallFacts(root, view.id, item, await client.incomingCalls(item), sourceLines));
            }
          } catch (failure) {
            complete = false;
            error ??= String(failure);
          }
        }
        if (!client.hasCleanDiagnostics(uri)) {
          complete = false;
          error ??= `clangd diagnostics missing or erroneous: ${file}`;
        }
        if (complete) covered.push(file);
        else failed.add(file);
      } catch (failure) {
        failed.add(file);
        error ??= String(failure);
      }
    }
  } catch (failure) {
    error ??= String(failure);
  } finally {
    if (client) {
      try { await client.close(); }
      catch (failure) {
        error ??= String(failure);
        covered.length = 0;
      }
    }
  }
  for (const file of files) if (!covered.includes(file)) failed.add(file);
  return { status: { id: view.id, key: view.key, inventory: view.inventory, grouping: view.grouping,
    success: failed.size === 0 && !error && !signal?.aborted,
    coveredFiles: covered, failedFiles: [...failed].sort(), analyzedTuCount: covered.length,
    failedTuCount: failed.size, durationMs: Date.now() - started, ...(error ? { error } : {}) }, symbols, calls };
}

/**
 * @brief 独立运行每个 clangd 编译视图并汇总只读、可按配置区分的事实。
 * @param[in] projectRoot 项目根目录
 * @param[in] database PR1 共享编译数据库模型
 * @param[in] runtime 已从可信用户输入解析的运行选项，不能来自仓库配置
 * @param[in] options 可选索引取消信号与每请求超时
 * @return 每视图覆盖状态和项目内语义事实；失败视图不提供负面证据
 */
export async function collectCppSemanticFacts(projectRoot: string, database: CompilationDatabase,
  runtime: CppSemanticRuntimeOptions, options: { signal?: AbortSignal; requestTimeoutMs?: number } = {}):
  Promise<SemanticFactCollection> {
  const root = fs.realpathSync(projectRoot);
  const symbols: SemanticSymbolFact[] = [];
  const calls: SemanticCallFact[] = [];
  const views: SemanticViewResult[] = [];
  for (const view of buildCompileViews(database)) {
    const result = await collectView(root, view, runtime, options.signal, options.requestTimeoutMs);
    views.push(result.status);
    symbols.push(...result.symbols);
    calls.push(...result.calls);
  }
  return { inventory: database.inventory, grouping: database.grouping, symbols, calls, views };
}
