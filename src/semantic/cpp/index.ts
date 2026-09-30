/** @file 按编译视图独立采集 C/C++ clangd 事实；本模块不修改主图。 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { CppSemanticRuntimeOptions, loadCppSemanticRepairConfig,
  resolveCppSemanticRuntimeOptions } from '../../project-config';
import { CompilationDatabase, loadCompilationDatabase } from './compile-database';
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
  /** 实际编译条目中语义参数集合的稳定哈希，不等于 CMake target 的 key。 */
  flagsHash: string;
  /** 仅整个视图使用同一 compiler 时提供；多编译器视图不猜测代表值。 */
  compiler?: string;
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
  /** 仅定向同步时提供；不能把未采集视图当作缺失证据。 */
  scopeFiles?: string[];
  /** 每个源文件在完整编译数据库中所属的全部视图 ID。 */
  expectedViewsByFile?: Record<string, string[]>;
}

export interface CppSemanticInputs {
  database: CompilationDatabase | null;
  runtime: CppSemanticRuntimeOptions;
  clangdVersion: string | null;
  fingerprint: string | null;
  error?: string;
}

const REPAIR_ALGORITHM_VERSION = 2;

/**
 * @brief 在可信用户侧运行时解析语义输入并散列修复算法、工具、数据库原始字节与配置。
 * @param[in] projectRoot 项目根目录
 * @return 当前修复输入及错误原因；工具或数据库不可用时不生成成功指纹
 */
export function resolveCppSemanticInputs(projectRoot: string): CppSemanticInputs | null {
  const config = loadCppSemanticRepairConfig(projectRoot);
  if (!config) return null;
  const runtime = resolveCppSemanticRuntimeOptions({}, process.env, projectRoot);
  const databaseStarted = Date.now();
  const database = loadCompilationDatabase(projectRoot,
    runtime.compileCommands ?? config.compileCommands, !!runtime.compileCommands);
  if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(
    `[semantic-timing] compile-db: ${Date.now() - databaseStarted}ms entries=${database?.entries.length ?? 0}`);
  if (!database?.entries.length) return { database, runtime, clangdVersion: null, fingerprint: null,
    error: 'no compilation database with project C/C++ translation units' };
  if (!runtime.clangdPath) return { database, runtime, clangdVersion: null, fingerprint: null,
    error: 'trusted clangd executable unavailable' };
  try {
    // 仅调用已验证的用户侧 clangd；绝不执行编译数据库内的 compiler/command。
    const versionLine = execFileSync(runtime.clangdPath, ['--version'],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024 }).split(/\r?\n/, 1)[0]!.trim();
    if (!versionLine) throw new Error('empty clangd version');
    const clangdVersion = versionLine.match(/\bclangd version\s+(\S+)/i)?.[1] ?? versionLine;
    const hash = createHash('sha256');
    hash.update(JSON.stringify([REPAIR_ALGORITHM_VERSION, clangdVersion, config,
      runtime.clangdPath, runtime.queryDrivers, database.path]));
    // 与条目解析共享同一次原始字节读取，避免原子替换把旧条目标记成新 DB 的成功指纹。
    hash.update(database.contentHash);
    return { database, runtime, clangdVersion, fingerprint: hash.digest('hex') };
  } catch (error) {
    return { database, runtime, clangdVersion: null, fingerprint: null,
      error: `clangd version or compilation database unavailable: ${String(error)}` };
  }
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
  let materializeMs = 0;
  let startupMs = 0;
  let factsMs = 0;
  let shutdownMs = 0;
  let factsStarted: number | undefined;
  let error: string | undefined;
  let client: ClangdClient | undefined;
  try {
    if (signal?.aborted) throw new Error('clangd collection cancelled');
    const materializeStarted = Date.now();
    const compileDirectory = materializeCompileView(root, view);
    materializeMs = Date.now() - materializeStarted;
    client = new ClangdClient(root, compileDirectory, runtime, signal, requestTimeoutMs);
    const startupStarted = Date.now();
    try { await client.start(); }
    finally { startupMs = Date.now() - startupStarted; }
    factsStarted = Date.now();
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
    const discoveredByFile = new Map<string, ReturnType<typeof documentSymbolFacts>>();
    for (const { file, uri } of open) {
      if (signal?.aborted) throw new Error('clangd collection cancelled');
      try {
        const discovered = documentSymbolFacts(root, uri, view.id, await client.documentSymbols(uri), sourceLines);
        discoveredByFile.set(file, discovered);
        symbols.push(...discovered.map(item => item.fact));
      } catch (failure) {
        failed.add(file);
        error ??= String(failure);
      }
    }
    // 跨 TU 的 incoming 调用可先于 caller 文件遍历到达；所有定义须先完成采集。
    const definitions = new Map<string, SemanticSymbolFact[]>();
    for (const fact of symbols) {
      const key = `${fact.filePath}\0${fact.kind}\0${fact.name}`;
      const existing = definitions.get(key) ?? [];
      existing.push(fact);
      definitions.set(key, existing);
    }
    for (const { file, uri } of open) {
      if (signal?.aborted) throw new Error('clangd collection cancelled');
      const discovered = discoveredByFile.get(file);
      if (!discovered) continue;
      try {
        let complete = indexReady;
        for (const { fact, position } of discovered) {
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
              calls.push(...incomingCallFacts(root, view.id, item, await client.incomingCalls(item),
                sourceLines, definitions, () => { complete = false; }));
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
    // 将 clangd 关闭耗时单列，避免误记为 LSP 事实采集。
    if (factsStarted !== undefined) factsMs = Date.now() - factsStarted;
    if (client) {
      const shutdownStarted = Date.now();
      try { await client.close(); }
      catch (failure) {
        error ??= String(failure);
        covered.length = 0;
      }
      finally { shutdownMs = Date.now() - shutdownStarted; }
    }
  }
  for (const file of files) if (!covered.includes(file)) failed.add(file);
  // 同一视图可含多 TU/重复命令；参数按原次序表达语义，集合去重再排序避免枚举次序影响哈希。
  const flagSets = [...new Set(view.entries.map(entry => JSON.stringify(entry.semanticFlags)))].sort();
  const flagsHash = createHash('sha256').update(JSON.stringify(flagSets)).digest('hex');
  const compilers = new Set(view.entries.map(entry => entry.compiler));
  const compiler = compilers.size === 1 ? [...compilers][0] : undefined;
  if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(
    `[semantic-timing] view=${view.id} materialize=${materializeMs}ms clangd-start=${startupMs}ms ` +
    `facts=${factsMs}ms shutdown=${shutdownMs}ms total=${Date.now() - started}ms ` +
    `covered=${covered.length}/${files.length}`);
  return { status: { id: view.id, key: view.key, flagsHash, ...(compiler ? { compiler } : {}),
    inventory: view.inventory, grouping: view.grouping,
    success: failed.size === 0 && !error && !signal?.aborted,
    coveredFiles: covered, failedFiles: [...failed].sort(), analyzedTuCount: covered.length,
    failedTuCount: failed.size, durationMs: Date.now() - started, ...(error ? { error } : {}) }, symbols, calls };
}

/**
 * @brief 独立运行每个 clangd 编译视图并汇总只读、可按配置区分的事实。
 * @param[in] projectRoot 项目根目录
 * @param[in] database PR1 共享编译数据库模型
 * @param[in] runtime 已从可信用户输入解析的运行选项，不能来自仓库配置
 * @param[in] options 可选取消信号、每请求超时和定向同步的实现文件范围
 * @return 每视图覆盖状态和项目内语义事实；失败视图不提供负面证据
 */
export async function collectCppSemanticFacts(projectRoot: string, database: CompilationDatabase,
  runtime: CppSemanticRuntimeOptions, options: { signal?: AbortSignal; requestTimeoutMs?: number;
    scopeFiles?: string[] } = {}):
  Promise<SemanticFactCollection> {
  const root = fs.realpathSync(projectRoot);
  const symbols: SemanticSymbolFact[] = [];
  const calls: SemanticCallFact[] = [];
  const views: SemanticViewResult[] = [];
  const viewBuildStarted = Date.now();
  const compileViews = buildCompileViews(database);
  if (process.env.CODEGRAPH_SYNTH_TIMINGS) console.error(
    `[semantic-timing] build-views: ${Date.now() - viewBuildStarted}ms views=${compileViews.length}`);
  const selected = options.scopeFiles && new Set(options.scopeFiles);
  const expectedViewsByFile: Record<string, string[]> = Object.create(null);
  for (const view of compileViews) {
    for (const entry of view.entries) (expectedViewsByFile[entry.file] ??= []).push(view.id);
  }
  for (const view of compileViews) {
    if (selected && !view.entries.some(entry => selected.has(entry.file))) continue;
    const result = await collectView(root, view, runtime, options.signal, options.requestTimeoutMs);
    views.push(result.status);
    symbols.push(...result.symbols);
    calls.push(...result.calls);
  }
  return { inventory: database.inventory, grouping: database.grouping, symbols, calls, views,
    ...(selected ? { scopeFiles: [...selected], expectedViewsByFile } : {}) };
}
