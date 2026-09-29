/** @file clangd LSP 坐标、源码身份和内存语义事实。 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { isWithinProject } from './compile-database';
import { LspCallHierarchyItem, LspDocumentSymbol, LspIncomingCall, LspPosition,
  LspRange, LspSymbolInformation } from './clangd-client';

export interface SemanticSymbolIdentity {
  filePath: string;
  kind: 'function' | 'method';
  name: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface SemanticSymbolFact extends SemanticSymbolIdentity {
  configId: string;
  signature?: string;
}

/**
 * @brief 为真正碰撞的同行同名 C/C++ 定义生成稳定的列号消歧 ID。
 * @param[in] identity 定义的文件、类型、名称和起始行列坐标
 * @return 与常规行号 ID 不同、同一源码位置跨采集保持不变的节点 ID
 */
export function semanticCollisionNodeId(identity: Pick<SemanticSymbolIdentity,
  'filePath' | 'kind' | 'name' | 'startLine' | 'startColumn'>): string {
  const hash = createHash('sha256').update(JSON.stringify([
    identity.filePath, identity.kind, identity.name, identity.startLine, identity.startColumn,
  ])).digest('hex').slice(0, 32);
  return `${identity.kind}:${hash}`;
}

/**
 * @brief 判断同名同文件定义的源码范围是否足以表示同一个函数体。
 * @param[in] left 第一份定义的行列范围
 * @param[in] right 第二份定义的行列范围
 * @return 共享结束行或存在至少半个短范围的交叠时返回 true
 */
export function semanticRangesOverlap(left: Pick<SemanticSymbolIdentity, 'startLine' | 'endLine' | 'startColumn' | 'endColumn'>,
  right: Pick<SemanticSymbolIdentity, 'startLine' | 'endLine' | 'startColumn' | 'endColumn'>): boolean {
  const start = Math.max(left.startLine, right.startLine);
  const end = Math.min(left.endLine, right.endLine);
  if (start > end) return false;
  // 同一物理行里连续的两个函数可有相同 end/start 行，但不共享源码字节。
  if (left.endLine === right.startLine && left.endColumn <= right.startColumn ||
      right.endLine === left.startLine && right.endColumn <= left.startColumn) return false;
  const sharedLines = end - start + 1;
  const shorter = Math.min(left.endLine - left.startLine + 1, right.endLine - right.startLine + 1);
  return left.endLine === right.endLine || sharedLines * 2 >= shorter;
}

/**
 * @brief 确认已筛选的旧候选彼此也有直接的源码身份重叠。
 * @param[in] candidates 同文件、类型、名称且各自匹配当前事实或基线节点的旧候选
 * @return 无；存在不能直接归并的旧候选时抛错，由调用方事务回滚
 */
export function assertPairwiseSemanticOverlap(candidates: ReadonlyArray<Pick<SemanticSymbolIdentity,
  'startLine' | 'endLine' | 'startColumn' | 'endColumn'>>): void {
  // 分别与新事实重叠不具有传递性，不能据此归并原本分离的旧定义。
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (!semanticRangesOverlap(candidates[i]!, candidates[j]!)) {
        throw new Error('Cannot merge unverified semantic identity');
      }
    }
  }
}

export interface SemanticCallFact {
  configId: string;
  caller: SemanticSymbolIdentity;
  callee: SemanticSymbolIdentity;
  callLine: number;
  callColumn: number;
}

export type SemanticSourceLines = Map<string, string[]>;

/**
 * @brief 将 LSP 行换成 1-based，并验证仍为 UTF-16 单位的 0-based 列。
 * @param[in] position LSP 0-based 行列
 * @return 尚未按源码行转为字节列的坐标；非法位置返回 null
 */
export function normalizeLspPosition(position: LspPosition): { line: number; column: number } | null {
  if (!position || !Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character) ||
      position.line < 0 || position.character < 0) return null;
  return { line: position.line + 1, column: position.character };
}

/**
 * @brief 把 LSP 默认 UTF-16 列转换为 CodeGraph Tree-sitter 的 UTF-8 字节列。
 * @param[in] root 项目真实根目录
 * @param[in] filePath 已验证的项目相对源文件路径
 * @param[in] position LSP 零起始行及 UTF-16 列
 * @param[in,out] sourceLines 每视图复用的源码行缓存
 * @return 1-based 行和 0-based 字节列；无效坐标返回 null
 */
function sourcePosition(root: string, filePath: string, position: LspPosition,
  sourceLines: SemanticSourceLines): { line: number; column: number } | null {
  const normalized = normalizeLspPosition(position);
  if (!normalized) return null;
  let lines = sourceLines.get(filePath);
  if (!lines) {
    try { lines = fs.readFileSync(path.join(root, filePath), 'utf8').split('\n'); }
    catch { return null; }
    sourceLines.set(filePath, lines);
  }
  const line = lines[position.line];
  if (line === undefined || position.character > line.length) return null;
  return { line: normalized.line, column: Buffer.byteLength(line.slice(0, position.character), 'utf8') };
}

/**
 * @brief 仅接受源文件真实路径在项目根目录内的 LSP file URI。
 * @param[in] root 项目真实根目录
 * @param[in] uri clangd 返回的 URI
 * @return 项目相对路径；非本地文件或项目外路径返回 null
 */
export function projectFileFromUri(root: string, uri: string): string | null {
  try {
    const real = fs.realpathSync(fileURLToPath(uri));
    if (!isWithinProject(root, real) || !fs.statSync(real).isFile()) return null;
    return path.relative(root, real).replace(/\\/g, '/');
  } catch { return null; }
}

/**
 * @brief 从 LSP 范围提取可区分同名静态函数的项目源码身份。
 * @param[in] root 项目真实根目录
 * @param[in] uri 函数的源文件 URI
 * @param[in] kind LSP 符号类型
 * @param[in] name 函数名称
 * @param[in] range 源码范围
 * @param[in,out] sourceLines 当前视图的源码行缓存
 * @return 仅在范围和文件均有效时返回函数身份
 */
export function symbolIdentity(root: string, uri: string, kind: number, name: string,
  range: LspRange, sourceLines: SemanticSourceLines): SemanticSymbolIdentity | null {
  if (kind !== 12 && kind !== 6 || typeof name !== 'string' || !name || !range) return null;
  const filePath = projectFileFromUri(root, uri);
  const start = filePath ? sourcePosition(root, filePath, range.start, sourceLines) : null;
  const end = filePath ? sourcePosition(root, filePath, range.end, sourceLines) : null;
  if (!filePath || !start || !end || end.line < start.line ||
      (end.line === start.line && end.column < start.column)) return null;
  return { filePath, kind: kind === 6 ? 'method' : 'function', name,
    startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column };
}

/**
 * @brief 用 clangd 的源码范围终点区分带函数体的定义与纯声明。
 * @param[in] lines 已按行拆分的当前文档
 * @param[in] range clangd 报告的符号源码范围
 * @return 范围以闭合函数体结尾时为 true
 */
function hasFunctionBody(lines: string[] | undefined, range: LspRange): boolean {
  const line = lines?.[range.end?.line];
  return line?.slice(0, range.end.character).trimEnd().endsWith('}') ?? false;
}

/**
 * @brief 递归收集 LSP 文档函数符号，不将项目外 URI 或非函数转为图事实。
 * @param[in] root 项目真实根目录
 * @param[in] uri 当前文档 URI
 * @param[in] configId 编译视图 ID
 * @param[in] symbols 层级或扁平文档符号
 * @param[in,out] sourceLines 当前视图的源码行缓存
 * @return 内存中的定义事实及调用层级查询位置
 */
export function documentSymbolFacts(root: string, uri: string, configId: string,
  symbols: Array<LspDocumentSymbol | LspSymbolInformation>, sourceLines: SemanticSourceLines):
  Array<{ fact: SemanticSymbolFact; position: LspPosition }> {
  const found: Array<{ fact: SemanticSymbolFact; position: LspPosition }> = [];
  for (const symbol of symbols) {
    if ('location' in symbol) {
      const identity = symbolIdentity(root, symbol.location.uri, symbol.kind, symbol.name, symbol.location.range, sourceLines);
      if (identity && hasFunctionBody(sourceLines.get(identity.filePath), symbol.location.range) &&
          projectFileFromUri(root, symbol.location.uri) === projectFileFromUri(root, uri)) {
        found.push({ fact: { configId, ...identity }, position: symbol.location.range.start });
      }
    } else {
      const identity = symbolIdentity(root, uri, symbol.kind, symbol.name, symbol.range, sourceLines);
      if (identity && hasFunctionBody(sourceLines.get(identity.filePath), symbol.range)) found.push({ fact: { configId, ...identity,
        ...(symbol.detail ? { signature: symbol.detail } : {}) },
        position: symbol.selectionRange?.start ?? symbol.range.start });
      if (symbol.children) found.push(...documentSymbolFacts(root, uri, configId, symbol.children, sourceLines));
    }
  }
  return found;
}

/**
 * @brief 将 clangd incoming 调用列表转换为项目内准确调用位置。
 * @param[in] root 项目真实根目录
 * @param[in] configId 编译视图 ID
 * @param[in] callee 已通过层级查询定位的被调函数
 * @param[in] incoming clangd 返回的 caller 及调用范围
 * @param[in,out] sourceLines 当前视图的源码行缓存
 * @return 所有可验证的项目内调用事实
 */
export function incomingCallFacts(root: string, configId: string, callee: LspCallHierarchyItem,
  incoming: LspIncomingCall[], sourceLines: SemanticSourceLines): SemanticCallFact[] {
  const target = symbolIdentity(root, callee.uri, callee.kind, callee.name, callee.range, sourceLines);
  if (!target) return [];
  const facts: SemanticCallFact[] = [];
  for (const call of incoming) {
    const caller = symbolIdentity(root, call.from.uri, call.from.kind, call.from.name, call.from.range, sourceLines);
    if (!caller) continue;
    for (const range of call.fromRanges) {
      const position = sourcePosition(root, caller.filePath, range.start, sourceLines);
      if (position) facts.push({ configId, caller, callee: target,
        callLine: position.line, callColumn: position.column });
    }
  }
  return facts;
}
