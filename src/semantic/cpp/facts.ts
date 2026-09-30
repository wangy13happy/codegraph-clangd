/** @file clangd LSP 坐标、源码身份和内存语义事实。 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { generateNodeId } from '../../extraction/tree-sitter-helpers';
import type { Node } from '../../types';
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
  /** 只有同 TU 原生直接绑定且物理声明完整时允许创建项目外 stub。 */
  external?: boolean;
}

export interface NativeTargetEvidence {
  usr: string;
  linkage: number;
  translationUnit: string;
  contextHash: string;
  declarationHash: string;
  declarationFile?: string;
  sourceHash?: string;
  macroHash?: string;
  libraryVersion: string;
  /** 两次同点展开可共享图边，物理宏体锚点仍分别保留用于审计。 */
  macroId?: string;
  spellingFile?: string;
  spellingLine?: number;
  spellingColumn?: number;
}

export interface SemanticSymbolFact extends SemanticSymbolIdentity {
  configId: string;
  signature?: string;
  native?: NativeTargetEvidence;
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
 * @brief 判断重复节点 ID 是否来自可按列号分离的真实同行 C/C++ 定义。
 * @param[in] candidates 同一 ID 的源码节点组
 * @return 全部互不重叠且身份可验证时为 true；全体重叠为 false；混合或伪造身份抛错
 */
export function areDisjointCppIdCollisions(candidates: ReadonlyArray<Pick<Node,
  'id' | 'filePath' | 'kind' | 'name' | 'startLine' | 'startColumn' | 'endLine' | 'endColumn'>>): boolean {
  let disjoint = false;
  let overlapping = false;
  // 仅重复 ID 小组做两两检查；桥接范围不能据此归并或消歧，仍需拒写。
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (semanticRangesOverlap(candidates[i]!, candidates[j]!)) overlapping = true;
      else disjoint = true;
    }
  }
  if (!disjoint) return false;
  const first = candidates[0]!;
  if (overlapping || (first.kind !== 'function' && first.kind !== 'method') ||
      first.id !== generateNodeId(first.filePath, first.kind, first.name, first.startLine) ||
      candidates.some(node => node.id !== first.id || node.filePath !== first.filePath ||
        node.kind !== first.kind || node.name !== first.name || node.startLine !== first.startLine)) {
    throw new Error('Cannot disambiguate C/C++ node identity');
  }
  return true;
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
  provenance?: 'libclang';
  native?: NativeTargetEvidence;
}

export interface StructuralTypedefContext {
  nodeId: string;
  filePath: string;
  name: string;
  startLine: number;
  endLine: number;
  sourceStartLine: number;
  sourceEndLine: number;
  conditions: string[];
  confirmedConfigIds?: string[];
}

export interface SemanticTypedefBinding { nodeId: string; configId: string }

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
 * @param[in] definitions 同一视图已核实的完整函数定义，按文件、类型和名称分组
 * @param[in] onUnresolved 无法唯一定位调用者时将视图标为非完整覆盖
 * @return 所有可验证的项目内调用事实
 */
export function incomingCallFacts(root: string, configId: string, callee: LspCallHierarchyItem,
  incoming: LspIncomingCall[], sourceLines: SemanticSourceLines,
  definitions: ReadonlyMap<string, ReadonlyArray<SemanticSymbolIdentity>>,
  onUnresolved: () => void): SemanticCallFact[] {
  const target = symbolIdentity(root, callee.uri, callee.kind, callee.name, callee.range, sourceLines);
  if (!target) return [];
  const facts: SemanticCallFact[] = [];
  for (const call of incoming) {
    // clangd 会把函数指针注册表等变量引用也放入 incoming；它们不是可删除的直接调用边。
    if (call.from.kind !== 12 && call.from.kind !== 6) continue;
    const signature = symbolIdentity(root, call.from.uri, call.from.kind, call.from.name, call.from.range, sourceLines);
    if (!signature) { onUnresolved(); continue; }
    for (const range of call.fromRanges) {
      const position = sourcePosition(root, signature.filePath, range.start, sourceLines);
      if (!position) { onUnresolved(); continue; }
      // clangd incoming.from.range 可只覆盖签名；真实归属由完整定义范围和调用点共同决定。
      const candidates = (definitions.get(`${signature.filePath}\0${signature.kind}\0${signature.name}`) ?? [])
        .filter(definition => (position.line > definition.startLine ||
          position.line === definition.startLine && position.column >= definition.startColumn) &&
          (position.line < definition.endLine ||
          position.line === definition.endLine && position.column < definition.endColumn));
      if (candidates.length !== 1) { onUnresolved(); continue; }
      facts.push({ configId, caller: candidates[0]!, callee: target,
        callLine: position.line, callColumn: position.column });
    }
  }
  return facts;
}
