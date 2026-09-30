/** @file 同 clangd 会话上下文的有界 libclang 宏直接目标适配。 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { CppSemanticRuntimeOptions } from '../../project-config';
import { Node } from '../../types';
import { isWithinProject } from './compile-database';
import { EffectiveCompileContext } from './clangd-client';
import { NativeTargetEvidence, SemanticCallFact, SemanticSymbolFact, SemanticSymbolIdentity } from './facts';

export const NATIVE_HELPER_PATH = path.resolve(__dirname, '../../../scripts/cpp-native-callees.py');
const INPUT_BYTES = 256 * 1024;
const OUTPUT_BYTES = 2 * 1024 * 1024;
const PARSE_TIMEOUT_MS = 5000;

interface PhysicalPosition { file: string; line: number; column: number; offset: number }
interface NativeIdentity {
  kind: number; name: string; usr: string; linkage: number;
  physical: PhysicalPosition | null; start: PhysicalPosition | null; end: PhysicalPosition | null;
}
interface NativeCall {
  caller: NativeIdentity | null; target: NativeIdentity; expansion: PhysicalPosition;
  spelling: PhysicalPosition; macro: string;
}

/**
 * @brief 验证 effective argv 仅表示一个主文件，拒绝隐含执行、response、插件和附加输入。
 * @param[in] context 同会话已核验的真实参数及目录
 * @param[in] mainFile 唯一允许的绝对主文件
 * @return libclang 可安全回放的参数；未知参数不猜测兼容性并抛错
 */
export function nativeReplayArguments(context: EffectiveCompileContext, mainFile: string): string[] {
  const argv = [...context.argv];
  if (!argv.length || argv.length > 2048 || !path.isAbsolute(context.directory) ||
      !/^19\.\d+\.\d+$/.test(context.clangdVersion)) throw new Error('unsupported native compile context');
  const delimiter = argv.indexOf('--');
  if (delimiter !== argv.length - 2 || argv[argv.length - 1] !== mainFile ||
      argv.filter(arg => arg === mainFile).length !== 1) throw new Error('native context is not a single main input');
  // libclang 在 Driver 参数尾部追加 editor flag；只删除紧邻唯一绝对主文件的已证明 delimiter。
  argv.splice(delimiter, 1);
  const values = new Set(['-I', '-D', '-U', '-isystem', '-iquote', '-idirafter', '-include',
    '-imacros', '-isysroot', '--sysroot', '-target', '--target', '-resource-dir', '-x', '-o']);
  for (let index = 1; index < argv.length - 1; index++) {
    const arg = argv[index]!;
    if (!arg || /[\x00-\x1f\x7f]/.test(arg) || arg.startsWith('@') ||
        /(?:plugin|load|^-Xclang|^-Xpreprocessor|^-mllvm|^-B|^-cc1|^-fmodule|^-include-pch|^-ivfsoverlay|^-working-directory)/i.test(arg))
      throw new Error('unsafe native replay argument');
    if (values.has(arg)) {
      const value = argv[++index];
      if (!value || index >= argv.length - 1 || value.startsWith('@') || /[\x00-\x1f\x7f]/.test(value))
        throw new Error('invalid native replay option value');
      continue;
    }
    if (/^(?:-c|-g\d*|-O[0-3sgz]|-pipe|-pthread|-fsyntax-only|-nostdinc(?:\+\+)?|-ansi|-pedantic(?:-errors)?|-W[\w=+,-]+|-D.+|-U.+|-I.+|-std=.+|--?target=.+|--?sysroot=.+|-resource-dir=.+|-m(?:arch|cpu|tune|abi|float-abi|fpu)=.+|-m(?:32|64|thumb|arm)|-f(?:no-)?(?:signed-char|unsigned-char|short-wchar|short-enums|exceptions|rtti|pic|PIC|pie|PIE))$/.test(arg)) continue;
    throw new Error(`unsupported native replay option: ${arg}`);
  }
  return argv;
}

/**
 * @brief 在固定字节预算内散列真实声明文件，用于既有 fingerprint 和生命周期核验。
 * @param[in] file 原生出口证明的物理文件路径
 * @return SHA256；声明不可读、不是普通文件或超过预算时抛错
 */
export function nativeDeclarationHash(file: string): string {
  if (!path.isAbsolute(file) || !fs.statSync(file).isFile() || fs.statSync(file).size > OUTPUT_BYTES)
    throw new Error('native declaration file unavailable or over budget');
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * @brief 在独立解释器进程里执行 shipped helper，严格限制输入、输出、时间和取消。
 * @param[in] runtime 用户侧可信解释器与 libclang 路径
 * @param[in] request 单主文件协议请求
 * @param[in] signal 索引取消信号
 * @return 唯一完整 JSON 回应；异常、超时、取消或超预算时抛错且回收进程
 */
async function runNativeHelper(runtime: CppSemanticRuntimeOptions, request: object,
  signal?: AbortSignal): Promise<any> {
  if (!runtime.nativePythonPath || !runtime.nativeLibclangPath) throw new Error('trusted native runtime unavailable');
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > INPUT_BYTES) throw new Error('native request byte budget exceeded');
  if (signal?.aborted) throw new Error('native collection cancelled');
  return new Promise((resolve, reject) => {
    // -I 不读取项目 Python 模块、PYTHONPATH 或用户 site；helper 位置属于产品安装而非项目配置。
    const child = spawn(runtime.nativePythonPath!, ['-I', NATIVE_HELPER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = Buffer.alloc(0);
    let failure: Error | undefined;
    let stderrBytes = 0;
    /**
     * @brief 记录失败并强制终止不能继续产生可靠事实的原生解析。
     * @param[in] reason 已确认的失败原因
     * @return 无；最终由 close 事件结算并确认回收
     */
    const stop = (reason: string): void => { failure ??= new Error(reason); child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('native parse timed out'), PARSE_TIMEOUT_MS);
    /**
     * @brief 把索引取消传播到解析进程的强制终止。
     * @return 无
     */
    const abort = (): void => stop('native collection cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', error => { failure ??= error; });
    child.stdin.on('error', error => { failure ??= error; });
    child.stdout.on('data', (data: Buffer) => {
      if (output.length + data.length > OUTPUT_BYTES) stop('native response byte budget exceeded');
      else output = Buffer.concat([output, data]);
    });
    child.stderr.on('data', (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes > 64 * 1024) stop('native diagnostic byte budget exceeded');
    });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure || code !== 0) { reject(failure ?? new Error(`native helper failed: ${code}`)); return; }
      try { resolve(JSON.parse(output.toString('utf8'))); }
      catch { reject(new Error('malformed native helper response')); }
    });
    child.stdin.end(input);
  });
}

/**
 * @brief 将物理原生身份转换为图身份，严格保留 external 边界和真实声明范围。
 * @param[in] root 项目真实根目录
 * @param[in] value 原生 FunctionDecl 或 CXXMethod 身份
 * @param[in] allowExternal 是否允许 selective 外部声明
 * @return 合法物理身份；缺 USR、scratch、范围冲突或间接目标时返回 null
 */
function physicalIdentity(root: string, value: NativeIdentity | null, allowExternal: boolean): SemanticSymbolIdentity | null {
  if (!value || ![8, 21].includes(value.kind) || !value.usr || !value.name ||
      ![2, 3, 4].includes(value.linkage) || !value.physical || !value.start || !value.end) return null;
  const { start, end } = value;
  if (start.file !== end.file || !path.isAbsolute(start.file) || !fs.statSync(start.file).isFile() ||
      !Number.isSafeInteger(start.line) || start.line < 1 || !Number.isSafeInteger(end.line) || end.line < start.line ||
      !Number.isSafeInteger(start.column) || start.column < 1 || !Number.isSafeInteger(end.column) || end.column < 1 ||
      !Number.isSafeInteger(start.offset) || !Number.isSafeInteger(end.offset) || start.offset < 0 || end.offset <= start.offset)
    return null;
  const real = fs.realpathSync(start.file);
  const external = !isWithinProject(root, real);
  if (external && (!allowExternal || value.linkage !== 4)) return null;
  return { filePath: external ? real : path.relative(root, real).replace(/\\/g, '/'),
    kind: value.kind === 21 ? 'method' : 'function', name: value.name,
    startLine: start.line, startColumn: start.column - 1, endLine: end.line, endColumn: end.column - 1,
    ...(external ? { external: true } : {}) };
}

/**
 * @brief 采集一个已确认存在宏调用候选的 TU，将真实 native binding 接入既有 facts 合同。
 * @param[in] root 项目真实根目录
 * @param[in] configId 已有编译视图身份
 * @param[in] mainFile 实际已打开 TU
 * @param[in] sourceHash 与 clangd didOpen 一致的主文件字节哈希
 * @param[in] context 同会话 effective context；未知时不能从 CDB 替代
 * @param[in] runtime 可信运行时路径
 * @param[in] macros 实际项目内结构宏定义，只提供筛选范围
 * @param[in] invocations TU 内语法调用候选的一起始字节坐标
 * @param[in] definitions 已有 clangd 项目定义，用于唯一定位 caller 与项目 callee
 * @param[in] signal 索引取消信号
 * @return 正向事实及 complete 状态；任何未知事实不升级为猜测边
 */
export async function collectNativeMacroCalls(root: string, configId: string, mainFile: string, sourceHash: string,
  context: EffectiveCompileContext | null, runtime: CppSemanticRuntimeOptions, macros: Node[],
  invocations: Array<{ line: number; column: number }>, definitions: SemanticSymbolFact[], signal?: AbortSignal):
  Promise<{ symbols: SemanticSymbolFact[]; calls: SemanticCallFact[]; complete: boolean; reason?: string;
    durationMs: number; bytes: number; visited: number; contextHash?: string }> {
  const started = Date.now();
  const symbols: SemanticSymbolFact[] = [];
  const calls: SemanticCallFact[] = [];
  let reason: string | undefined;
  let bytes = 0;
  let visited = 0;
  try {
    if (!context) throw new Error('same-session native compile context unavailable');
    if (macros.length > 512 || invocations.length > 512) throw new Error('native macro candidate budget exceeded');
    const headers = new Map([...new Set(macros.map(macro => path.join(root, macro.filePath)))]
      .map(file => [file, nativeDeclarationHash(file)]));
    const reply = await runNativeHelper(runtime, { protocolVersion: 1, configId, mainFile, mainFileHash: sourceHash,
      context, library: runtime.nativeLibclangPath, argv: nativeReplayArguments(context, mainFile), invocations,
      macros: macros.map(macro => ({ nodeId: macro.id, file: fs.realpathSync(path.join(root, macro.filePath)),
        startLine: macro.startLine, endLine: macro.endLine })) }, signal);
    bytes = Buffer.byteLength(JSON.stringify(reply));
    visited = reply.visited;
    if (reply.protocolVersion !== 1 || reply.configId !== configId || reply.mainFile !== mainFile ||
        reply.mainFileHash !== sourceHash || reply.contextHash !== context.hash || reply.triple !== context.triple ||
        ![32, 64].includes(reply.pointerWidth) || typeof reply.libraryVersion !== 'string' ||
        !reply.libraryVersion.includes(`clang version ${context.clangdVersion}`) || !Array.isArray(reply.calls) ||
        reply.calls.length > 1024 || !Number.isSafeInteger(visited) || visited > 10001 ||
        typeof reply.complete !== 'boolean' || !Array.isArray(reply.reasons)) throw new Error('native response identity or version mismatch');
    if (nativeDeclarationHash(mainFile) !== sourceHash || [...headers].some(([file, hash]) => nativeDeclarationHash(file) !== hash))
      throw new Error('native source snapshot changed');
    if (!reply.complete) reason = reply.reasons.join('; ') || 'native collection partial';
    for (const call of reply.calls as NativeCall[]) {
      const callerIdentity = physicalIdentity(root, call.caller, false);
      const targetIdentity = physicalIdentity(root, call.target, true);
      if (!callerIdentity || !targetIdentity || call.expansion?.file !== mainFile ||
          !Number.isSafeInteger(call.expansion.line) || !Number.isSafeInteger(call.expansion.column) ||
          !invocations.some(item => item.line === call.expansion.line && item.column === call.expansion.column) ||
          !macros.some(macro => macro.id === call.macro && path.join(root, macro.filePath) === call.spelling?.file &&
            call.spelling.line >= macro.startLine && call.spelling.line <= macro.endLine)) {
        reason ??= 'native call lacks verified physical identity'; continue;
      }
      const callerCandidates = definitions.filter(fact => fact.filePath === callerIdentity.filePath &&
        fact.kind === callerIdentity.kind && fact.name === callerIdentity.name &&
        (call.expansion.line > fact.startLine || call.expansion.line === fact.startLine && call.expansion.column - 1 >= fact.startColumn) &&
        (call.expansion.line < fact.endLine || call.expansion.line === fact.endLine && call.expansion.column - 1 < fact.endColumn));
      let callee: SemanticSymbolIdentity = targetIdentity;
      if (!targetIdentity.external) {
        const matches = definitions.filter(fact => fact.filePath === targetIdentity.filePath && fact.kind === targetIdentity.kind &&
          fact.name === targetIdentity.name && fact.startLine <= targetIdentity.endLine && fact.endLine >= targetIdentity.startLine);
        if (matches.length !== 1) { reason ??= 'native project target not uniquely represented'; continue; }
        callee = matches[0]!;
      }
      if (callerCandidates.length !== 1) { reason ??= 'native caller not uniquely represented'; continue; }
      const evidence: NativeTargetEvidence = { usr: call.target.usr, linkage: call.target.linkage,
        translationUnit: path.relative(root, mainFile), contextHash: context.hash,
        declarationHash: nativeDeclarationHash(call.target.start!.file), declarationFile: call.target.start!.file,
        sourceHash, macroHash: headers.get(call.spelling.file), libraryVersion: reply.libraryVersion,
        macroId: call.macro, spellingFile: call.spelling.file,
        spellingLine: call.spelling.line, spellingColumn: call.spelling.column - 1 };
      if (targetIdentity.external) symbols.push({ ...targetIdentity, configId, native: evidence });
      calls.push({ configId, caller: callerCandidates[0]!, callee,
        callLine: call.expansion.line, callColumn: call.expansion.column - 1, provenance: 'libclang', native: evidence });
    }
  } catch (failure) {
    // Context/协议/源快照错误使整批 native 输出失效，不保留可能跨上下文的正向猜测。
    symbols.length = 0; calls.length = 0; reason = String(failure);
  }
  return { symbols, calls, complete: !reason, ...(reason ? { reason } : {}), durationMs: Date.now() - started,
    bytes, visited, ...(context ? { contextHash: context.hash } : {}) };
}
