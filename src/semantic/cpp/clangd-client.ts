/** @file 只处理语义事实所需方法的 clangd stdio LSP 会话。 */
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { pathToFileURL } from 'url';
import { createHash, randomBytes } from 'crypto';
import * as path from 'path';
import type { MessageConnection } from 'vscode-jsonrpc/lib/node/main';
// 旧式 TS moduleResolution 不读取包的 ./node 条件导出；运行时仍使用官方 Node 入口。
const { createMessageConnection, CancellationTokenSource } = require('vscode-jsonrpc/node') as typeof import('vscode-jsonrpc/lib/node/main');
import { CppSemanticRuntimeOptions } from '../../project-config';

export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}
export interface LspSymbolInformation {
  name: string;
  kind: number;
  location: { uri: string; range: LspRange };
}
export interface LspCallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
  detail?: string;
}
export interface LspIncomingCall { from: LspCallHierarchyItem; fromRanges: LspRange[] }
export interface LspDefinition { uri: string; range: LspRange }

export interface EffectiveCompileContext {
  directory: string;
  argv: string[];
  triple: string;
  clangdVersion: string;
  documentVersion: number;
  sessionId: string;
  hash: string;
}

/**
 * @brief 只解码已核验的 clangd 19 printArgv 简单 token 子集，不把日志当 shell。
 * @param[in] value 原生日志中的参数行
 * @return 无引号、控制符或 C 转义歧义时返回参数；否则返回 null 并降级
 */
export function decodeSimpleClangdArgv(value: string): string[] | null {
  if (!value || /[^\x20-\x7e]|["'\\]/.test(value) || value.trim() !== value || value.includes('  ')) return null;
  return value.split(' ');
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SYNC_TIMEOUT_MS = 10 * 60_000;
const EXIT_WAIT_MS = 500;

/**
 * @brief 在截止时间或取消信号到达时拒绝操作，并调用会话的取消处理。
 * @param[in] action 正在等待的 LSP 请求
 * @param[in] timeoutMs 请求最大等待毫秒数
 * @param[in] signal 索引取消信号
 * @param[in] onCancel 发送协议取消并停止会话的回调
 * @return 请求的响应；超时或取消时抛出异常
 */
async function bounded<T>(action: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, onCancel: () => void): Promise<T> {
  if (signal?.aborted) { onCancel(); throw new Error('clangd request cancelled'); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interruption = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { onCancel(); reject(new Error(`clangd request timed out after ${timeoutMs}ms`)); }, timeoutMs);
    if (signal) {
      abort = () => { onCancel(); reject(new Error('clangd request cancelled')); };
      signal.addEventListener('abort', abort, { once: true });
    }
  });
  try { return await Promise.race([action, interruption]); }
  finally {
    if (timer) clearTimeout(timer);
    if (signal && abort) signal.removeEventListener('abort', abort);
  }
}

export class ClangdClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private childClosed: Promise<void> | undefined;
  private connection: MessageConnection | undefined;
  private initialized = false;
  private stopped = false;
  private readonly timeoutMs: number;
  private readonly syncTimeoutMs: number;
  private readonly documentErrors = new Map<string, boolean>();
  private readonly sessionId = randomBytes(16).toString('hex');
  private readonly openedFiles = new Set<string>();
  private readonly commands = new Map<string, { directory: string; argv: string[]; triple?: string }>();
  private readonly ambiguousCommands = new Set<string>();
  private logBuffer = '';
  private discardingLogLine = false;
  private logBytes = 0;
  private logOverflow = false;
  private loggedVersion = '';
  private pendingCommand: { file: string; stage: 'directory' | 'argv'; directory?: string } | undefined;

  /**
   * @brief 建立惰性 clangd 客户端，仅接受用户侧已验证的运行时授权。
   * @param[in] root 已确定的项目根目录
   * @param[in] compileDirectory 单个视图的编译数据库目录
   * @param[in] runtime 可信用户侧解析的 clangd 路径和驱动白名单
   * @param[in] signal 索引取消信号
   * @param[in] timeoutMs 显式请求等待预算；未指定时 sync 使用独立的有界默认预算
   * @return 无
   */
  constructor(private readonly root: string, private readonly compileDirectory: string,
    private readonly runtime: CppSemanticRuntimeOptions, private readonly signal?: AbortSignal,
    timeoutMs?: number) {
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error('Invalid clangd request timeout');
    this.timeoutMs = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    // TU/索引任务及两轮 CDB/后台索引/模块各自可等 60 秒；默认总预算留余量且仍有限。
    this.syncTimeoutMs = timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  }

  /**
   * @brief 首次需要 LSP 请求时启动进程并完成 initialize/initialized 握手。
   * @return 无；启动、协议或取消失败时抛出异常
   */
  async start(): Promise<void> {
    if (this.initialized) return;
    if (this.stopped || this.signal?.aborted) throw new Error('clangd session cancelled');
    if (!this.runtime.clangdPath) throw new Error('Trusted clangd executable is unavailable');
    const args = [`--compile-commands-dir=${this.compileDirectory}`, '--background-index', '--log=verbose'];
    if (this.runtime.queryDrivers.length) args.push(`--query-driver=${this.runtime.queryDrivers.join(',')}`);
    const child = spawn(this.runtime.clangdPath, args, { cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.childClosed = new Promise(resolve => child.once('close', resolve));
    child.on('error', () => { this.stopped = true; });
    child.on('close', () => { this.stopped = true; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.collectEffectiveContext(chunk));
    this.signal?.addEventListener('abort', this.onAbort, { once: true });
    try {
      const connection = createMessageConnection(child.stdout, child.stdin);
      this.connection = connection;
      connection.onClose(() => { this.stopped = true; });
      connection.onNotification('textDocument/publishDiagnostics', (value: unknown) => {
        const params = value as { uri?: unknown; diagnostics?: unknown } | null;
        if (typeof params?.uri !== 'string' || !Array.isArray(params.diagnostics)) return;
        this.documentErrors.set(params.uri, params.diagnostics.some((diagnostic: unknown) => {
          const severity = (diagnostic as { severity?: unknown } | null)?.severity;
          return severity === undefined || severity === 1;
        }));
      });
      connection.listen();
      await this.request('initialize', { processId: process.pid, rootUri: pathToFileURL(this.root + '/').href,
        capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          callHierarchy: { dynamicRegistration: false } }, workspace: { symbol: {} } },
        initializationOptions: {}, clientInfo: { name: 'codegraph' } });
      connection.sendNotification('initialized', {});
      this.initialized = true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /**
   * @brief 发送单个有界 LSP 请求，超时或取消时使本视图失效。
   * @param[in] method LSP 方法名
   * @param[in] params 方法参数
   * @param[in] timeoutMs 当前请求的等待上限
   * @return 服务端响应
   */
  private async request<T>(method: string, params: object, timeoutMs = this.timeoutMs): Promise<T> {
    if (!this.connection || this.stopped || this.signal?.aborted) throw new Error('clangd session stopped');
    const token = new CancellationTokenSource();
    try {
      return await bounded(this.connection.sendRequest<T>(method, params, token.token), timeoutMs, this.signal,
        () => { if (!this.stopped) token.cancel(); this.kill(); });
    } finally { token.dispose(); }
  }

  /**
   * @brief 打开一个项目源文件供 clangd 查询。
   * @param[in] uri 源文件的 file URI
   * @param[in] languageId c 或 cpp
   * @param[in] text 源文件全文
   * @return 无
   */
  didOpen(uri: string, languageId: string, text: string): void {
    if (!this.initialized || !this.connection || this.stopped) throw new Error('clangd session not initialized');
    this.documentErrors.delete(uri);
    this.openedFiles.add(decodeURIComponent(new URL(uri).pathname));
    this.connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
  }

  /**
   * @brief 等待 clangd 19 测试扩展报告 TU、CDB 和后台索引均空闲。
   * @return 无；不支持、超时、取消或服务端未空闲时抛出异常
   */
  async waitForIndex(): Promise<void> {
    await this.request('sync', {}, this.syncTimeoutMs);
  }

  /**
   * @brief 判定一个已打开文档是否收到无错误的最终诊断。
   * @param[in] uri 已打开源文件的 file URI
   * @return 诊断已发布且无错误时为 true；缺失或有错误时为 false
   */
  hasCleanDiagnostics(uri: string): boolean {
    return this.documentErrors.get(uri) === false;
  }

  /**
   * @brief 有界采集同一进程的真实 ASTWorker command 和 cc1 target，不保存普通协议日志。
   * @param[in] chunk stderr 新到达的 UTF-8 日志片段
   * @return 无；截断、歧义或不受支持的日志格式令对应上下文不可用
   */
  private collectEffectiveContext(chunk: string): void {
    if (this.logOverflow) return;
    if (this.discardingLogLine) {
      const end = chunk.indexOf('\n');
      if (end < 0) return;
      chunk = chunk.slice(end + 1); this.discardingLogLine = false;
    }
    this.logBuffer += chunk;
    for (;;) {
      const end = this.logBuffer.indexOf('\n');
      if (end < 0) break;
      const raw = this.logBuffer.slice(0, end).replace(/\r$/, '');
      this.logBuffer = this.logBuffer.slice(end + 1);
      const line = raw.replace(/^[IVDE]\[\d{2}:\d{2}:\d{2}\.\d{3}\] /, '');
      if (Buffer.byteLength(raw) > 256 * 1024) {
        // verbose LSP 正文可能单行很长；不保存它，也不能因此否定已完整收集的其他 TU context。
        // 若命令块本身越界，只把该 TU 记为未知，绝不截断后拼成 argv。
        if (this.pendingCommand) this.ambiguousCommands.add(this.pendingCommand.file);
        this.pendingCommand = undefined; continue;
      }
      const version = line.match(/\bclangd version (19\.\d+\.\d+)\b/);
      if (version) this.loggedVersion = version[1]!;
      const build = line.match(/^ASTWorker building file (.+) version 1 with command(?: .*)?$/);
      if (build) {
        this.pendingCommand = this.openedFiles.has(build[1]!) ? { file: build[1]!, stage: 'directory' } : undefined;
        continue;
      }
      if (this.pendingCommand) {
        const pending = this.pendingCommand;
        if (pending.stage === 'directory' && /^\[[^\r\n]+\]$/.test(line)) {
          pending.directory = line.slice(1, -1); pending.stage = 'argv'; continue;
        }
        if (pending.stage === 'argv') {
          const argv = decodeSimpleClangdArgv(line);
          this.logBytes += Buffer.byteLength(line);
          if (this.logBytes > 2 * 1024 * 1024 || this.commands.size >= 128) this.logOverflow = true;
          const existing = this.commands.get(pending.file);
          if (argv && pending.directory && path.isAbsolute(pending.directory) && !this.logOverflow) {
            if (existing && JSON.stringify([existing.directory, existing.argv]) !== JSON.stringify([pending.directory, argv]))
              this.ambiguousCommands.add(pending.file);
            else this.commands.set(pending.file, { directory: pending.directory, argv });
          } else this.ambiguousCommands.add(pending.file);
        } else this.ambiguousCommands.add(pending.file);
        this.pendingCommand = undefined;
      }
      const cc1 = line.match(/^(?:Driver produced command: |internal \(cc1\) args are: )(.*)$/);
      if (!cc1?.[1]) continue;
      const argv = decodeSimpleClangdArgv(cc1[1]);
      if (!argv) continue;
      const file = argv[argv.length - 1]!;
      const command = this.commands.get(file);
      const tripleIndex = argv.indexOf('-triple');
      if (!command || tripleIndex < 0 || !argv[tripleIndex + 1]) continue;
      const triple = argv[tripleIndex + 1]!;
      if (command.triple && command.triple !== triple) this.ambiguousCommands.add(file);
      else command.triple = triple;
    }
    if (Buffer.byteLength(this.logBuffer) > 256 * 1024) {
      if (this.pendingCommand) this.ambiguousCommands.add(this.pendingCommand.file);
      this.pendingCommand = undefined; this.logBuffer = ''; this.discardingLogLine = true;
    }
  }

  /**
   * @brief 取已打开 version 1 文档的同会话 effective command；不读取旧日志或 CDB 猜测参数。
   * @param[in] mainFile 已打开主文件的绝对路径
   * @return 真实版本、target、argv 与会话哈希；不完整或歧义时返回 null
   */
  effectiveCompileContext(mainFile: string): EffectiveCompileContext | null {
    const command = this.commands.get(mainFile);
    if (this.logOverflow || this.ambiguousCommands.has(mainFile) || !this.loggedVersion || !command?.triple) return null;
    const hash = createHash('sha256').update(JSON.stringify([this.sessionId, mainFile, 1,
      this.loggedVersion, command.directory, command.argv, command.triple])).digest('hex');
    return { ...command, triple: command.triple, clangdVersion: this.loggedVersion,
      documentVersion: 1, sessionId: this.sessionId, hash };
  }

  /**
   * @brief 查询文档内语义符号。
   * @param[in] uri 源文件的 file URI
   * @return 层级或扁平化 LSP 符号结果
   */
  async documentSymbols(uri: string): Promise<Array<LspDocumentSymbol | LspSymbolInformation>> {
    return (await this.request<Array<LspDocumentSymbol | LspSymbolInformation> | null>(
      'textDocument/documentSymbol', { textDocument: { uri } })) ?? [];
  }

  /**
   * @brief 查询实际源码引用绑定的定义位置，不按符号名字猜测目标。
   * @param[in] uri 引用所在文件 URI
   * @param[in] position 引用的 LSP 坐标
   * @return clangd 解析的定义位置；无定义时返回空数组
   */
  async definitions(uri: string, position: LspPosition): Promise<LspDefinition[]> {
    const result = await this.request<LspDefinition | LspDefinition[] | null>('textDocument/definition',
      { textDocument: { uri }, position });
    return result ? Array.isArray(result) ? result : [result] : [];
  }

  /**
   * @brief 将文档位置解析为可用于来电查询的函数身份。
   * @param[in] uri 源文件的 file URI
   * @param[in] position 函数选择范围中的 LSP 坐标
   * @return clangd 返回的零个或多个层级身份
   */
  async prepareCallHierarchy(uri: string, position: LspPosition): Promise<LspCallHierarchyItem[]> {
    return (await this.request<LspCallHierarchyItem[] | null>('textDocument/prepareCallHierarchy',
      { textDocument: { uri }, position })) ?? [];
  }

  /**
   * @brief 查询一个函数的直接调用点和真实 caller 身份。
   * @param[in] item clangd 准备阶段返回的函数身份
   * @return 包含调用位置的 incoming call 列表
   */
  async incomingCalls(item: LspCallHierarchyItem): Promise<LspIncomingCall[]> {
    return (await this.request<LspIncomingCall[] | null>('callHierarchy/incomingCalls', { item })) ?? [];
  }

  /**
   * @brief 将外部索引取消传播为当前 clangd 会话终止。
   * @return 无
   */
  private readonly onAbort = (): void => { this.kill(); };

  /**
   * @brief 强制停止当前失效会话，避免继续接收不完整响应。
   * @return 无
   */
  private kill(): void {
    this.stopped = true;
    if (this.child && this.child.exitCode === null) this.child.kill('SIGTERM');
  }

  /**
   * @brief 尝试有界 shutdown/exit 并最终回收进程。
   * @return 无；即使服务端挂起也在有限时间内结束
   */
  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.signal?.removeEventListener('abort', this.onAbort);
    if (this.initialized && !this.stopped && this.connection) {
      try {
        await bounded(this.connection.sendRequest('shutdown'), this.timeoutMs, this.signal, () => this.kill());
        this.connection.sendNotification('exit');
      } catch { this.kill(); }
    }
    // clangd 忽略 exit 时在有限时间内升级为 SIGKILL；close 事件确保子进程已经被回收。
    if (child.exitCode === null && child.signalCode === null && this.childClosed) {
      const exited = this.childClosed;
      await bounded(exited, EXIT_WAIT_MS, undefined, () => child.kill('SIGKILL')).catch(() => {});
      await bounded(exited, EXIT_WAIT_MS, undefined, () => {}).catch(() => {});
    }
    this.stopped = true;
    this.connection?.dispose();
    this.connection = undefined;
    this.child = undefined;
    this.childClosed = undefined;
  }
}
