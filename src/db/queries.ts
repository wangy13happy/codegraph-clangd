/**
 * Database Queries
 *
 * Prepared statements for CRUD operations on the knowledge graph.
 */

import { SqliteDatabase, SqliteStatement } from './sqlite-adapter';
import {
  Node,
  Edge,
  FileRecord,
  UnresolvedReference,
  NodeKind,
  EdgeKind,
  Language,
  GraphStats,
  SearchOptions,
  SearchResult,
} from '../types';
import { safeJsonParse } from '../utils';
import { kindBonus, nameMatchBonus, scorePathRelevance } from '../search/query-utils';
import { parseQuery, boundedEditDistance } from '../search/query-parser';
import { isGeneratedFile } from '../extraction/generated-detection';
import { splitIdentifierSegments } from '../search/identifier-segments';
import { semanticRangesOverlap, assertPairwiseSemanticOverlap,
  areDisjointCppIdCollisions } from '../semantic/cpp/facts';
import { generateNodeId, semanticCollisionNodeId } from '../extraction/tree-sitter-helpers';
import type { SemanticFactCollection, SemanticSymbolIdentity } from '../semantic/cpp';

/**
 * Files that should not be candidates for "dominant file" detection: test/spec
 * files and tool-generated files. Generated files (`*.pb.go`, `*.pulsar.go`,
 * mock outputs, …) often have huge in-file edge counts that dwarf the real
 * source — etcd's `rpc.pb.go` has 4× the in-file edges of `server.go`.
 *
 * Path patterns plus, when the caller passes the indexed set, files whose
 * HEADER declares them generated — a `payroll.go` full of generated CRUD has
 * exactly the same edge-density problem as `rpc.pb.go` and nothing in its name
 * to catch it (#1500).
 */
function isLowValueFile(filePath: string, generated?: ReadonlySet<string>): boolean {
  if (generated?.has(filePath)) return true;
  const lp = filePath.toLowerCase();
  return (
    /(?:^|\/)(tests?|__tests?__|spec)\//.test(lp) ||
    /_test\.go$/.test(lp) ||
    /(?:^|\/)test_[^/]+\.py$/.test(lp) ||
    /_test\.py$/.test(lp) ||
    /_spec\.rb$/.test(lp) ||
    /_test\.rb$/.test(lp) ||
    /\.(test|spec)\.[jt]sx?$/.test(lp) ||
    /(test|spec|tests)\.(java|kt|scala)$/.test(lp) ||
    /(tests?|spec)\.cs$/.test(lp) ||
    /tests?\.swift$/.test(lp) ||
    /_test\.dart$/.test(lp) ||
    isGeneratedFile(filePath)
  );
}

const SQLITE_PARAM_CHUNK_SIZE = 500;

/**
 * How much of the exact-name bonus a `deprioritize`d path keeps (#982). Damped
 * rather than zeroed: a query that genuinely targets that tree must still rank
 * it, the same "discount, don't erase" rule the path penalty follows.
 *
 * Derived rather than picked. `nameMatchBonus`'s prefix arm tops out below
 * `10 + 30 = 40`, and a de-prioritized node also takes the -15 path penalty, so
 * `80 * SCALE - 15 > 40` is what stops a damped WHOLE-QUERY exact match from
 * losing to a mere prefix match. 0.75 clears it (45). Measured on a 62k-node
 * django index: at 0.25 that invariant breaks in practice — `child`, `parent`
 * and `method` lose rank 1 to `children`, `all_parents` and `method_decorator`
 * — while crowd-out removal is almost flat between 0.75 and 0.5 (39 vs 40 of 88
 * peripheral top-10 slots cleared), so a deeper discount buys little and costs
 * the invariant. Pinned by a test.
 */
export const DEPRIORITIZED_NAME_BONUS_SCALE = 0.75;

/**
 * Database row types (snake_case from SQLite)
 */
interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
  docstring: string | null;
  signature: string | null;
  visibility: string | null;
  is_exported: number;
  is_async: number;
  is_static: number;
  is_abstract: number;
  decorators: string | null;
  type_parameters: string | null;
  return_type: string | null;
  semantic_origin: string | null;
  updated_at: number;
}

interface EdgeRow {
  id: number;
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
  line: number | null;
  col: number | null;
  provenance: string | null;
}

interface FileRow {
  path: string;
  content_hash: string;
  language: string;
  size: number;
  modified_at: number;
  indexed_at: number;
  node_count: number;
  errors: string | null;
  /** Absent on pre-v9 rows read through a stale prepared statement. */
  generated?: number | null;
}

interface UnresolvedRefRow {
  id: number;
  from_node_id: string;
  reference_name: string;
  reference_kind: string;
  line: number;
  col: number;
  candidates: string | null;
  file_path: string;
  language: string;
  status: string;
  name_tail: string;
}

/**
 * Last segment of a (possibly dotted/qualified) reference name — the part a
 * new symbol's plain node name could match: 'util.greet' → 'greet',
 * 'mod::fn' → 'fn', 'greet' → 'greet'. Written to unresolved_refs.name_tail
 * when a ref is marked failed, so the #1240 retry lookup can match dotted
 * refs against newly-added node names.
 */
function referenceNameTail(referenceName: string): string {
  // Erlang refs carry a written arity (`f/1`, `mod::fn/2` — #1610); the tail a
  // new symbol's plain name could match is the arity-less function name.
  const base = referenceName.replace(/\/\d{1,3}$/, '') || referenceName;
  const idx = Math.max(base.lastIndexOf('.'), base.lastIndexOf(':'));
  return idx >= 0 ? base.slice(idx + 1) : base;
}

/**
 * Convert database row to Node object
 */
function rowToNode(row: NodeRow): Node {
  return {
    id: row.id,
    kind: row.kind as NodeKind,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    language: row.language as Language,
    startLine: row.start_line,
    endLine: row.end_line,
    startColumn: row.start_column,
    endColumn: row.end_column,
    docstring: row.docstring ?? undefined,
    signature: row.signature ?? undefined,
    visibility: row.visibility as Node['visibility'],
    isExported: row.is_exported === 1,
    isAsync: row.is_async === 1,
    isStatic: row.is_static === 1,
    isAbstract: row.is_abstract === 1,
    decorators: row.decorators ? safeJsonParse(row.decorators, undefined) : undefined,
    typeParameters: row.type_parameters ? safeJsonParse(row.type_parameters, undefined) : undefined,
    returnType: row.return_type ?? undefined,
    semanticOrigin: row.semantic_origin as Node['semanticOrigin'] ?? undefined,
    updatedAt: row.updated_at,
  };
}

/**
 * Convert database row to Edge object
 */
function rowToEdge(row: EdgeRow): Edge {
  return {
    source: row.source,
    target: row.target,
    kind: row.kind as EdgeKind,
    metadata: row.metadata ? safeJsonParse(row.metadata, undefined) : undefined,
    line: row.line ?? undefined,
    column: row.col ?? undefined,
    provenance: row.provenance as Edge['provenance'],
  };
}

/**
 * Convert database row to FileRecord object
 */
function rowToFileRecord(row: FileRow): FileRecord {
  return {
    path: row.path,
    contentHash: row.content_hash,
    language: row.language as Language,
    size: row.size,
    modifiedAt: row.modified_at,
    indexedAt: row.indexed_at,
    nodeCount: row.node_count,
    errors: row.errors ? safeJsonParse(row.errors, undefined) : undefined,
    generated: row.generated === 1,
  };
}

/**
 * Query builder for the knowledge graph database
 */
export class QueryBuilder {
  private db: SqliteDatabase;

  // Project-name tokens (go.mod / package.json / repo dir), normalized. A query
  // word matching one is dropped from path-relevance scoring — it names the
  // whole project, not a symbol, so it carries no discriminative signal (#720).
  // Set once by the CodeGraph instance; empty by default (no down-weighting).
  private projectNameTokens: Set<string> = new Set();
  private isDeprioritizedPath: ((filePath: string) => boolean) | undefined;

  // Node cache for frequently accessed nodes (LRU-style, max 1000 entries)
  private nodeCache: Map<string, Node> = new Map();
  private readonly maxCacheSize = 1000;

  // Prepared statements (lazily initialized)
  private stmts: {
    insertNode?: SqliteStatement;
    updateNode?: SqliteStatement;
    deleteNode?: SqliteStatement;
    deleteNodesByFile?: SqliteStatement;
    getNodeById?: SqliteStatement;
    getNodesByFile?: SqliteStatement;
    getNodesByKind?: SqliteStatement;
    insertEdge?: SqliteStatement;
    upsertFile?: SqliteStatement;
    deleteEdgesBySource?: SqliteStatement;
    deleteEdgesByTarget?: SqliteStatement;
    getEdgesBySource?: SqliteStatement;
    getEdgesByTarget?: SqliteStatement;
    insertFile?: SqliteStatement;
    updateFile?: SqliteStatement;
    deleteFile?: SqliteStatement;
    getFileByPath?: SqliteStatement;
    getAllFiles?: SqliteStatement;
    insertUnresolved?: SqliteStatement;
    deleteUnresolvedByNode?: SqliteStatement;
    getUnresolvedByName?: SqliteStatement;
    getNodesByName?: SqliteStatement;
    getNodesByNamePrefix?: SqliteStatement;
    getNodesByQualifiedNameExact?: SqliteStatement;
    getNodesByLowerName?: SqliteStatement;
    getUnresolvedCount?: SqliteStatement;
    getUnresolvedBatch?: SqliteStatement;
    getUnresolvedBatchAfter?: SqliteStatement;
    deleteRefsByRowIdsFull?: SqliteStatement;
    getAllFilePaths?: SqliteStatement;
    getAllNodeNames?: SqliteStatement;
    getDominantFile?: SqliteStatement;
    getTopRouteFile?: SqliteStatement;
    getRoutingManifest?: SqliteStatement;
    insertNameSegment?: SqliteStatement;
  } = {};

  // Names whose segments were already written this session — skips re-splitting
  // and re-inserting for the same-named nodes that repeat across files ("get",
  // "render", …). Purely a write-path fast path; INSERT OR IGNORE is the
  // correctness backstop. Bounded so a pathological repo can't grow it forever.
  private segmentedNames: Set<string> = new Set();
  private static readonly MAX_SEGMENTED_NAMES = 65536;

  // Multi-row INSERT statements, cached per (statement kind × row count). The
  // bulk write path decomposes N rows into a few fixed batch sizes so each
  // size's statement is prepared once and reused — one .run() binds a whole
  // chunk instead of one row, which is where the per-call overhead lives.
  // Row order within and across chunks is the input order, so rowid assignment
  // (and therefore resolution's insertion-order disambiguation) is identical
  // to the one-row-per-run path.
  private batchStmts: Map<string, SqliteStatement> = new Map();
  private static readonly BATCH_SIZES: readonly number[] = [128, 32, 8, 1];

  /**
   * Run `rows` through a multi-row `INSERT` built as `head + (tuple,)*n`,
   * decomposed greedily into the cached batch sizes. Preserves row order.
   */
  private runBatched(kind: string, head: string, tuple: string, rows: unknown[][], tail = ''): void {
    if (rows.length === 0) return;
    let i = 0;
    for (const size of QueryBuilder.BATCH_SIZES) {
      while (rows.length - i >= size) {
        const key = `${kind}:${size}`;
        let stmt = this.batchStmts.get(key);
        if (!stmt) {
          stmt = this.db.prepare(head + new Array(size).fill(tuple).join(',') + tail);
          this.batchStmts.set(key, stmt);
        }
        if (size === 1) {
          stmt.run(...rows[i]!);
        } else {
          const params: unknown[] = [];
          for (let r = 0; r < size; r++) {
            const row = rows[i + r]!;
            for (let c = 0; c < row.length; c++) params.push(row[c]);
          }
          stmt.run(...params);
        }
        i += size;
      }
    }
  }

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  /**
   * Swap the underlying connection in place. Used by pool workers'
   * connection recycling (plan §7a.6, writes-under-readers): a long-lived
   * read connection pins WAL checkpoint progress, and the deep WAL that
   * accumulates behind it taxes every main-thread B-tree page operation
   * (deletes measured 42.6s → 118.8s from 0 to 4 attached readers on
   * identical hardware). Workers therefore close and reopen their read-only
   * connection at the pool-idle boundary; everything above the connection —
   * this QueryBuilder, the resolver and its warm caches — survives, and only
   * connection-derived state (prepared statements) resets, re-preparing
   * lazily on next use.
   */
  rebind(db: SqliteDatabase): void {
    this.db = db;
    this.stmts = {};
    this.batchStmts.clear();
  }

  /** Set the normalized project-name tokens used to down-weight non-discriminative
   * query words in path scoring (#720). Called once when the project opens. */
  setProjectNameTokens(tokens: Set<string>): void {
    this.projectNameTokens = tokens;
  }

  /** The normalized project-name tokens (#720); empty if none were derived. */
  getProjectNameTokens(): Set<string> {
    return this.projectNameTokens;
  }

  /**
   * Set the predicate that marks a path as de-prioritized by the project's
   * `codegraph.json` `deprioritize` patterns (#982). Ranking-only: those paths
   * stay indexed and findable, they just stop outranking first-party code.
   * Called once when the project opens; undefined disables the lever.
   */
  setDeprioritizedPathMatcher(matcher: ((filePath: string) => boolean) | undefined): void {
    this.isDeprioritizedPath = matcher;
  }

  /** The `deprioritize` predicate (#982), so other rankers apply the same lever. */
  getDeprioritizedPathMatcher(): ((filePath: string) => boolean) | undefined {
    return this.isDeprioritizedPath;
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  /**
   * @brief 普通 C/C++ 节点写入前核实同 ID 源码身份，并消歧合法独立定义。
   * @param[in] node 即将写入的普通提取节点
   * @return 可安全写入的节点；真实 baseline 碰撞时返回列号 ID，伪造 ID 时抛错
   */
  private verifySemanticNodeIdentity(node: Node): Node {
    if (node.semanticOrigin || (node.language !== 'c' && node.language !== 'cpp') ||
        (node.kind !== 'function' && node.kind !== 'method')) return node;
    const ordinary = (this.db.prepare(`
      SELECT * FROM nodes WHERE file_path = ? AND kind = ? AND name = ?
        AND start_line = ? AND semantic_origin IS NULL
    `).all(node.filePath, node.kind, node.name, node.startLine) as NodeRow[])
      .filter(candidate => semanticRangesOverlap(node, rowToNode(candidate)));
    if (ordinary.length > 1) throw new Error('Cannot disambiguate ordinary C/C++ node identity');
    if (ordinary[0] && ordinary[0].id !== node.id &&
        (node.id === generateNodeId(node.filePath, node.kind, node.name, node.startLine) ||
          node.id === semanticCollisionNodeId(node))) {
      return { ...node, id: ordinary[0].id };
    }
    const existing = this.db.prepare('SELECT * FROM nodes WHERE id = ?')
      .get(node.id) as NodeRow | undefined;
    if (existing) {
      if (existing.file_path !== node.filePath || existing.kind !== node.kind ||
          existing.name !== node.name) {
        throw new Error('Ordinary node conflicts with existing semantic node ID');
      }
      if (semanticRangesOverlap(node, {
          startLine: existing.start_line, startColumn: existing.start_column,
          endLine: existing.end_line, endColumn: existing.end_column,
        })) return node;
      if (existing.start_line !== node.startLine ||
          node.id !== generateNodeId(node.filePath, node.kind, node.name, node.startLine)) {
        throw new Error('Ordinary node conflicts with existing semantic node ID');
      }
      if (!existing.semantic_origin) {
        // 已有普通定义保留原 ID；另一独立定义按其自身列号接管已有语义身份。
        const replacement = { ...node, id: semanticCollisionNodeId(node) };
        const atTarget = this.db.prepare('SELECT * FROM nodes WHERE id = ?')
          .get(replacement.id) as NodeRow | undefined;
        if (atTarget && (atTarget.file_path !== node.filePath || atTarget.kind !== node.kind ||
            atTarget.name !== node.name || !semanticRangesOverlap(node, rowToNode(atTarget)))) {
          throw new Error('Ordinary node conflicts with existing semantic node ID');
        }
        return replacement;
      }
      const relocated = semanticCollisionNodeId({ filePath: node.filePath, kind: node.kind,
        name: node.name, startLine: existing.start_line, startColumn: existing.start_column });
      // 外键无 ON UPDATE CASCADE：先复制旧节点，转移所有子关系，再删除原 ID。
      if (this.db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(relocated)) {
        throw new Error('Semantic node ID collides with existing identity');
      }
      this.db.prepare(`
        INSERT INTO nodes (id,kind,name,qualified_name,file_path,language,start_line,end_line,
          start_column,end_column,docstring,signature,visibility,is_exported,is_async,is_static,
          is_abstract,decorators,type_parameters,return_type,semantic_origin,updated_at)
        SELECT ?,kind,name,qualified_name,file_path,language,start_line,end_line,
          start_column,end_column,docstring,signature,visibility,is_exported,is_async,is_static,
          is_abstract,decorators,type_parameters,return_type,semantic_origin,updated_at
        FROM nodes WHERE id = ?
      `).run(relocated, node.id);
      this.db.prepare('UPDATE semantic_node_configs SET node_id = ? WHERE node_id = ?')
        .run(relocated, node.id);
      this.db.prepare('UPDATE unresolved_refs SET from_node_id = ? WHERE from_node_id = ?')
        .run(relocated, node.id);
      this.db.prepare('UPDATE edges SET source = ? WHERE source = ?').run(relocated, node.id);
      this.db.prepare('UPDATE edges SET target = ? WHERE target = ?').run(relocated, node.id);
      this.deleteNode(node.id);
      this.nodeCache.delete(relocated);
    }
    return node;
  }

  /**
   * @brief 同批真实同行 C/C++ 定义优先保留旧身份匹配者的行号 ID，其余按列号消歧。
   * @param[in] nodes 本次批量写入的普通节点
   * @return 原顺序且各独立源码定义拥有不同 ID 的节点列表
   */
  private disambiguateBatchNodeIds(nodes: Node[]): Node[] {
    const groups = new Map<string, number[]>();
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      if (node.semanticOrigin || (node.language !== 'c' && node.language !== 'cpp') ||
          (node.kind !== 'function' && node.kind !== 'method')) continue;
      const indices = groups.get(node.id) ?? [];
      indices.push(i);
      groups.set(node.id, indices);
    }
    const prepared = [...nodes];
    const occupied = new Set(nodes.map(node => node.id));
    for (const [id, indices] of groups) {
      if (indices.length < 2) continue;
      if (!areDisjointCppIdCollisions(indices.map(index => nodes[index]!))) continue;
      const first = nodes[indices[0]!]!;
      const existing = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
      const matching = existing ? indices.filter(index =>
        existing.file_path === first.filePath && existing.kind === first.kind &&
        existing.name === first.name && semanticRangesOverlap(nodes[index]!, rowToNode(existing))) : [];
      if (matching.length > 1) throw new Error('Cannot disambiguate ordinary C/C++ node identity');
      const keep = matching[0] ?? indices.reduce((best, index) =>
        nodes[index]!.startColumn < nodes[best]!.startColumn ? index : best);
      for (const index of indices) {
        if (index === keep) continue;
        const node = nodes[index]!;
        const replacement = semanticCollisionNodeId(node);
        if (occupied.has(replacement)) throw new Error('C/C++ column node ID collides with existing identity');
        occupied.add(replacement);
        prepared[index] = { ...node, id: replacement };
      }
    }
    return prepared;
  }

  /**
   * @brief 事务内将旧语义身份的配置归属和可验证普通引用迁至获胜节点，再删除旧节点。
   * @param[in] winner 保留的节点 ID，调用前必须已写入数据库
   * @param[in] loser 待删除的 clangd 独占节点 ID
   * @return 无；身份不一致时抛错，由调用方事务回滚全部写入
   */
  mergeSemanticNode(winner: string, loser: string): void {
    if (winner === loser) return;
    const identity = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    const old = identity.get(loser) as NodeRow | undefined;
    const retained = identity.get(winner) as NodeRow | undefined;
    if (!old || old.semantic_origin !== 'clangd' || !retained ||
        old.file_path !== retained.file_path || old.kind !== retained.kind ||
        old.name !== retained.name || !semanticRangesOverlap(rowToNode(old), rowToNode(retained))) {
      throw new Error('Cannot merge unverified semantic identity');
    }
    this.db.prepare(`
      INSERT INTO semantic_node_configs (node_id, config_id, signature, definition_line, definition_col)
      SELECT ?, config_id, signature, definition_line, definition_col
      FROM semantic_node_configs WHERE node_id = ?
      ON CONFLICT(node_id, config_id) DO NOTHING
    `).run(winner, loser);
    const incoming = this.db.prepare(`
      SELECT e.* FROM edges e JOIN nodes source ON source.id = e.source
      WHERE e.target = ? AND e.source != ? AND e.kind = 'references'
        AND e.provenance IS NULL AND e.metadata IS NOT NULL
    `).all(loser, loser) as EdgeRow[];
    for (const edge of incoming) {
      const metadata = safeJsonParse(edge.metadata!, null) as Record<string, unknown> | null;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
          typeof metadata.refName !== 'string' || !metadata.refName ||
          referenceNameTail(metadata.refName) !== old.name ||
          (metadata.refKind !== undefined && metadata.refKind !== 'references' &&
            metadata.refKind !== 'function_ref')) continue;
      // 保留原引用文字及行列，只转绑有原始引用戳的普通解析结果。
      this.insertEdge({ ...rowToEdge(edge), target: winner });
    }
    this.deleteNode(loser);
  }

  /**
   * @brief 将 clangd 入向调用及配置归属对账到普通 C/C++ 调用边。
   * @param[in] collection 已完成节点修复的视图事实和运行时覆盖状态
   * @param[out] onRepositioned 可选统计回调，仅报告由同一调用关系新坐标替代的旧边数
   * @return 新建边和退役旧边数量；事实非法或写入失败时整批回滚
   */
  reconcileCppSemanticCalls(collection: SemanticFactCollection,
    onRepositioned?: (count: number) => void): { added: number; removed: number } {
    const viewIds = new Set(collection.views.map(view => view.id));
    if (viewIds.size !== collection.views.length) throw new Error('Invalid C/C++ call view inventory');
    /**
     * @brief 防止外部或畸形调用事实进入图写入事务。
     * @param[in] identity 项目相对源码定义身份
     * @return 文件、类型和行列均有效时为 true
     */
    const validIdentity = (identity: SemanticSymbolIdentity): boolean =>
      !!identity && !!identity.filePath && !/^(?:\/|[A-Za-z]:[\\/])/.test(identity.filePath) &&
      !identity.filePath.split(/[\\/]/).includes('..') && !!identity.name &&
      (identity.kind === 'function' || identity.kind === 'method') &&
      Number.isSafeInteger(identity.startLine) && identity.startLine > 0 &&
      Number.isSafeInteger(identity.endLine) && identity.endLine >= identity.startLine &&
      Number.isSafeInteger(identity.startColumn) && identity.startColumn >= 0 &&
      Number.isSafeInteger(identity.endColumn) && identity.endColumn >= 0 &&
      (identity.endLine !== identity.startLine || identity.endColumn >= identity.startColumn);
    for (const call of collection.calls) {
      if (!viewIds.has(call.configId) || !validIdentity(call.caller) || !validIdentity(call.callee) ||
          !Number.isSafeInteger(call.callLine) || call.callLine < call.caller.startLine ||
          call.callLine > call.caller.endLine || !Number.isSafeInteger(call.callColumn) || call.callColumn < 0) {
        throw new Error('Invalid C/C++ semantic call fact');
      }
    }

    const nodesByFile = new Map<string, Map<string, Node[]>>();
    /**
     * @brief 按文件、名称和定义源码范围唯一匹配已修复的图节点。
     * @param[in] identity clangd 函数身份
     * @return 唯一候选节点；无法消歧时返回 undefined
     */
    const match = (identity: SemanticSymbolIdentity): Node | undefined => {
      let nodes = nodesByFile.get(identity.filePath);
      if (!nodes) {
        nodes = new Map();
        for (const node of this.getNodesByFile(identity.filePath)) {
          if (node.language !== 'c' && node.language !== 'cpp') continue;
          const key = `${node.kind}\0${node.name}`;
          const group = nodes.get(key) ?? [];
          group.push(node);
          nodes.set(key, group);
        }
        nodesByFile.set(identity.filePath, nodes);
      }
      const matches = (nodes.get(`${identity.kind}\0${identity.name}`) ?? [])
        .filter(node => semanticRangesOverlap(node, identity));
      // 同行 static 或桥接范围不能猜测其 ID；只有唯一源码身份可对账。
      return matches.length === 1 ? matches[0] : undefined;
    };
    const represented = new Set<string>();
    const representedSources = new Set<string>();
    const representedTargets = new Set<string>();
    const targetNodes = new Map<string, Node>();
    for (const symbol of collection.symbols) {
      const node = match(symbol);
      if (node && viewIds.has(symbol.configId)) {
        represented.add(`${symbol.configId}\0${node.id}`);
        representedSources.add(node.id);
        representedTargets.add(node.id);
        targetNodes.set(node.id, node);
      }
    }
    const observed = new Map<string, { source: Node; target: Node; line: number; col: number; configs: Set<string> }>();
    const eligibleNames = new Map<string, Set<string>>();
    const eligibleTargets = new Map<string, Set<Node>>();
    for (const call of collection.calls) {
      const source = match(call.caller);
      const target = match(call.callee);
      if (!source || !target || !represented.has(`${call.configId}\0${target.id}`)) continue;
      const key = JSON.stringify([source.id, target.id, call.callLine, call.callColumn]);
      let entry = observed.get(key);
      if (!entry) {
        entry = { source, target, line: call.callLine, col: call.callColumn, configs: new Set() };
        observed.set(key, entry);
      }
      entry.configs.add(call.configId);
      if (represented.has(`${call.configId}\0${source.id}`)) {
        let names = eligibleNames.get(source.id);
        if (!names) { names = new Set(); eligibleNames.set(source.id, names); }
        names.add(target.name);
        const replacementKey = `${source.id}\0${target.name}`;
        let targets = eligibleTargets.get(replacementKey);
        if (!targets) { targets = new Set(); eligibleTargets.set(replacementKey, targets); }
        targets.add(target);
      }
    }
    /**
     * @brief 检查调用者文件在所有相关权威视图均已成功覆盖。
     * @param[in] file 项目相对源码文件路径
     * @return 该文件能提供完整负面证据时为 true
     */
    const covered = (file: string): boolean => {
      const relevant = collection.views.filter(view => view.coveredFiles.includes(file) || view.failedFiles.includes(file));
      const expected = collection.expectedViewsByFile?.[file];
      return collection.inventory === 'authoritative' && relevant.length > 0 &&
        (!collection.scopeFiles || (!!expected?.length && expected.every(id => relevant.some(view => view.id === id)))) &&
        relevant.every(view =>
        view.inventory === 'authoritative' && view.success && view.failedFiles.length === 0 &&
        view.failedTuCount === 0 && view.coveredFiles.includes(file) &&
        view.coveredFiles.length === view.analyzedTuCount);
    };
    /**
     * @brief 限定调用者和被调者在同一权威、完整的配置里均有源码身份。
     * @param[in] source 调用者的图节点
     * @param[in] target 被调者的图节点
     * @return 两端均完整覆盖并共享已采集配置时为 true
     */
    const fullyObservedRelation = (source: Node, target: Node): boolean =>
      covered(source.filePath) && covered(target.filePath) && collection.views.some(view =>
        view.coveredFiles.includes(source.filePath) && view.coveredFiles.includes(target.filePath) &&
        represented.has(`${view.id}\0${source.id}`) && represented.has(`${view.id}\0${target.id}`));
    const result = { added: 0, removed: 0 };
    let repositioned = 0;
    const observedRelations = new Set([...observed.values()].map(entry => `${entry.source.id}\0${entry.target.id}`));
    this.db.transaction(() => {
      const select = this.db.prepare('SELECT id,provenance FROM edges WHERE source = ? AND target = ? AND kind = ? AND line = ? AND col = ?');
      const insert = this.db.prepare("INSERT OR IGNORE INTO edges (source,target,kind,line,col,provenance) VALUES (?,?,'calls',?,?,'clangd')");
      const member = this.db.prepare('INSERT OR IGNORE INTO semantic_edge_configs (edge_id,config_id) VALUES (?,?)');
      const retireMember = this.db.prepare('DELETE FROM semantic_edge_configs WHERE edge_id = ? AND config_id = ?');
      // 精确坐标是边身份：同一调用者/目标的不同调用点必须逐条保留。
      for (const entry of observed.values()) {
        let row = select.get(entry.source.id, entry.target.id, 'calls', entry.line, entry.col) as
          { id: number; provenance: string | null } | undefined;
        if (!row) {
          result.added += insert.run(entry.source.id, entry.target.id, entry.line, entry.col).changes;
          row = select.get(entry.source.id, entry.target.id, 'calls', entry.line, entry.col) as typeof row;
        }
        // 唯一索引可能已被 heuristic 占用；绝不改写其归属或删除它。
        if (row && row.provenance !== 'heuristic') {
          if (fullyObservedRelation(entry.source, entry.target)) {
            // 完整覆盖方可撤销已验证边在旧视图里的归属；部分结果只附加正向事实。
            for (const view of collection.views) {
              if (view.coveredFiles.includes(entry.source.filePath) &&
                  view.coveredFiles.includes(entry.target.filePath) &&
                  represented.has(`${view.id}\0${entry.source.id}`) &&
                  represented.has(`${view.id}\0${entry.target.id}`)) retireMember.run(row.id, view.id);
            }
          }
          for (const config of entry.configs) member.run(row.id, config);
        }
      }
      const stale = this.db.prepare(`
        SELECT e.id,e.target,e.line,e.col,t.name FROM edges e
        JOIN nodes t ON t.id = e.target WHERE e.source = ? AND e.kind = 'calls'
          AND (e.provenance IS NULL OR e.provenance != 'heuristic')
      `);
      const remove = this.db.prepare('DELETE FROM edges WHERE id = ?');
      // 从已有目标反查可能需要删除的调用者；不逐个扫描无调用的所有函数。
      const candidates = new Set(eligibleNames.keys());
      for (const row of this.db.prepare(`
        SELECT DISTINCT source FROM edges WHERE kind = 'calls'
          AND target IN (SELECT value FROM json_each(?))
      `).all(JSON.stringify([...representedTargets])) as Array<{ source: string }>) candidates.add(row.source);
      for (const sourceId of candidates) {
        if (!representedSources.has(sourceId)) continue;
        const source = this.getNodeById(sourceId);
        if (!source || !covered(source.filePath)) continue;
        for (const edge of stale.all(sourceId) as Array<{ id: number; target: string; line: number | null; col: number | null; name: string }>) {
          if (collection.scopeFiles && !collection.scopeFiles.includes(source.filePath) &&
              !collection.scopeFiles.includes(this.getNodeById(edge.target)?.filePath ?? '')) continue;
          // 缺失事实只能否定已纳入语义清单的目标；错误 static 目标需有同名正向证据。
          if (!representedTargets.has(edge.target) && !eligibleNames.get(sourceId)?.has(edge.name)) continue;
          const target = targetNodes.get(edge.target);
          if (target) {
            // callee 的符号可先于失败的 incoming hierarchy 入库；跨视图不能用符号充当负面证据。
            if (!fullyObservedRelation(source, target)) continue;
          } else {
            const replacements = eligibleTargets.get(`${sourceId}\0${edge.name}`);
            const oldTarget = this.getNodeById(edge.target);
            // 错绑目标若仍有失败视图，或正确目标尚无完整覆盖，均保留旧线索。
            if (!replacements || (oldTarget && collection.views.some(view =>
              view.failedFiles.includes(oldTarget.filePath))) ||
              ![...replacements].some(node => fullyObservedRelation(source, node))) continue;
          }
          const key = JSON.stringify([sourceId, edge.target, edge.line, edge.col]);
          if (!observed.has(key)) {
            const deleted = remove.run(edge.id).changes;
            result.removed += deleted;
            if (observedRelations.has(`${sourceId}\0${edge.target}`)) repositioned += deleted;
          }
        }
      }
    })();
    onRepositioned?.(repositioned);
    return result;
  }

  /**
   * @brief 在增量提取覆盖既有文件前记录将受外键级联影响的语义归属。
   * @param[in] files 本次确实需要重新提取的 C/C++ 项目相对文件
   * @return 节点及调用边的已验证配置归属；仅在相同身份重现后可恢复
   */
  captureCppSemanticMembership(files: string[]): {
    identities: Node[];
    nodes: Array<{ node_id: string; config_id: string; signature: string | null;
      definition_line: number | null; definition_col: number | null;
      file_path: string; kind: string; name: string }>;
    edges: Array<{ source: string; target: string; kind: string; line: number | null;
      col: number | null; config_id: string; metadata: string | null; provenance: string | null }>;
  } {
    if (!files.length) return { identities: [], nodes: [], edges: [] };
    const paths = JSON.stringify(files);
    const nodes = this.db.prepare(`
      SELECT m.node_id,m.config_id,m.signature,m.definition_line,m.definition_col,
        n.file_path,n.kind,n.name FROM semantic_node_configs m
      JOIN nodes n ON n.id=m.node_id WHERE n.file_path IN (SELECT value FROM json_each(?))
    `).all(paths) as ReturnType<QueryBuilder['captureCppSemanticMembership']>['nodes'];
    const edges = this.db.prepare(`
      SELECT e.source,e.target,e.kind,e.line,e.col,e.metadata,e.provenance,m.config_id
      FROM semantic_edge_configs m JOIN edges e ON e.id=m.edge_id
      JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
      WHERE s.file_path IN (SELECT value FROM json_each(?))
        OR t.file_path IN (SELECT value FROM json_each(?))
    `).all(paths, paths) as ReturnType<QueryBuilder['captureCppSemanticMembership']>['edges'];
    const memberIds = new Set(nodes.map(row => row.node_id));
    const affectedIds = new Set([...memberIds, ...edges.flatMap(edge => [edge.source, edge.target])]);
    const identities = files.flatMap(file => this.getNodesByFile(file))
      .filter(node => affectedIds.has(node.id));
    return { identities, nodes, edges };
  }

  /**
   * @brief 按直接源码范围恢复增量提取级联删除的语义节点和调用边归属。
   * @param[in] saved 删除前采集的语义节点和边归属
   * @return 无；不相交的现存定义不会继承旧归属，无法消歧时事务回滚
   */
  restoreCppSemanticMembership(saved: ReturnType<QueryBuilder['captureCppSemanticMembership']>): void {
    this.db.transaction(() => {
      const owners = new Map<string, string>();
      for (const prior of saved.identities) {
        const current = this.getNodeById(prior.id);
        if (current) {
          if (current.filePath === prior.filePath && current.kind === prior.kind &&
              current.name === prior.name && semanticRangesOverlap(current, prior)) {
            owners.set(prior.id, current.id);
          } else if (prior.semanticOrigin === 'clangd') {
            // 同一行另一列复用旧 ID 时，不能把旧语义归属与调用边交给新定义。
            const separateId = semanticCollisionNodeId(prior);
            if (this.getNodeById(separateId)) throw new Error('Semantic node ID collides with existing identity');
            this.insertNode({ ...prior, id: separateId });
            owners.set(prior.id, separateId);
          }
          continue;
        }
        const baseline = this.getNodesByFile(prior.filePath).find(candidate =>
          !candidate.semanticOrigin && candidate.kind === prior.kind && candidate.name === prior.name &&
          semanticRangesOverlap(candidate, prior));
        if (baseline) owners.set(prior.id, baseline.id);
        else if (prior.semanticOrigin === 'clangd') {
          // 普通提取未接管此身份；保留旧正向语义证据直到权威完整视图完成刷新。
          this.insertNode(prior);
          owners.set(prior.id, prior.id);
        }
      }
      const node = this.db.prepare('SELECT file_path,kind,name FROM nodes WHERE id = ?');
      const restoreNode = this.db.prepare(`INSERT OR IGNORE INTO semantic_node_configs
        (node_id,config_id,signature,definition_line,definition_col) VALUES (?,?,?,?,?)`);
      for (const row of saved.nodes) {
        const owner = owners.get(row.node_id);
        if (!owner) continue;
        const current = node.get(owner) as { file_path: string; kind: string; name: string } | undefined;
        if (current?.file_path === row.file_path && current.kind === row.kind && current.name === row.name) {
          restoreNode.run(owner, row.config_id, row.signature, row.definition_line, row.definition_col);
        }
      }
      const edge = this.db.prepare(`SELECT id,provenance FROM edges WHERE source=? AND target=?
        AND kind=? AND line IS ? AND col IS ?`);
      const restoreEdge = this.db.prepare('INSERT OR IGNORE INTO semantic_edge_configs (edge_id,config_id) VALUES (?,?)');
      const insertEdge = this.db.prepare(`INSERT OR IGNORE INTO edges
        (source,target,kind,line,col,metadata,provenance) VALUES (?,?,?,?,?,?,?)`);
      const affectedIds = new Set(saved.identities.map(identity => identity.id));
      for (const row of saved.edges) {
        if ((affectedIds.has(row.source) && !owners.has(row.source)) ||
            (affectedIds.has(row.target) && !owners.has(row.target))) continue;
        const source = owners.get(row.source) ?? row.source;
        const target = owners.get(row.target) ?? row.target;
        if (!this.getNodeById(source) || !this.getNodeById(target)) continue;
        insertEdge.run(source, target, row.kind, row.line, row.col, row.metadata, row.provenance);
        const current = edge.get(source, target, row.kind, row.line, row.col) as
          { id: number; provenance: string | null } | undefined;
        if (current && current.provenance !== 'heuristic') restoreEdge.run(current.id, row.config_id);
      }
    })();
  }

  /**
   * @brief 普通 C/C++ 提取写入前，把重叠的 clangd 独占身份归属转到基线 ID。
   * @param[in] node 即将写入的普通提取节点
   * @return 无；由调用者事务保证迁移与实际节点写入一起提交或回滚
   */
  private takeOverSemanticNodes(node: Node): void {
    if (node.semanticOrigin || (node.language !== 'c' && node.language !== 'cpp') ||
        (node.kind !== 'function' && node.kind !== 'method')) return;
    const candidates = (this.db.prepare(`
      SELECT * FROM nodes WHERE file_path = ? AND kind = ? AND name = ?
        AND semantic_origin = 'clangd' AND start_line <= ? AND end_line >= ?
      ORDER BY start_line, id
    `).all(node.filePath, node.kind, node.name, node.endLine, node.startLine) as NodeRow[])
      .map(rowToNode).filter(old => old.id !== node.id && semanticRangesOverlap(node, old));
    assertPairwiseSemanticOverlap(candidates);
    for (const old of candidates) this.mergeSemanticNode(node.id, old.id);
  }

  /**
   * Insert a new node
   */
  insertNode(node: Node): void {
    if (!this.stmts.insertNode) {
      this.stmts.insertNode = this.db.prepare(`
        INSERT INTO nodes (
          id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column,
          docstring, signature, visibility,
          is_exported, is_async, is_static, is_abstract,
          decorators, type_parameters, return_type, semantic_origin, updated_at
        ) VALUES (
          @id, @kind, @name, @qualifiedName, @filePath, @language,
          @startLine, @endLine, @startColumn, @endColumn,
          @docstring, @signature, @visibility,
          @isExported, @isAsync, @isStatic, @isAbstract,
          @decorators, @typeParameters, @returnType, @semanticOrigin, @updatedAt
        ) ON CONFLICT(id) DO UPDATE SET
          kind=excluded.kind, name=excluded.name, qualified_name=excluded.qualified_name,
          file_path=excluded.file_path, language=excluded.language,
          start_line=excluded.start_line, end_line=excluded.end_line,
          start_column=excluded.start_column, end_column=excluded.end_column,
          docstring=excluded.docstring, signature=excluded.signature,
          visibility=excluded.visibility, is_exported=excluded.is_exported,
          is_async=excluded.is_async, is_static=excluded.is_static,
          is_abstract=excluded.is_abstract, decorators=excluded.decorators,
          type_parameters=excluded.type_parameters, return_type=excluded.return_type,
          semantic_origin=excluded.semantic_origin, updated_at=excluded.updated_at
      `);
    }

    // Validate required fields to prevent SQLite bind errors
    if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
      console.error('[CodeGraph] Skipping node with missing required fields:', {
        id: node.id,
        kind: node.kind,
        name: node.name,
        filePath: node.filePath,
        language: node.language,
      });
      return;
    }

    // UPSERT 可覆盖缓存中已有的同 ID 节点；读取前使缓存失效。
    this.nodeCache.delete(node.id);

    this.db.transaction(() => {
      node = this.verifySemanticNodeIdentity(node);
      this.nodeCache.delete(node.id);
      this.stmts.insertNode!.run({
        id: node.id,
        kind: node.kind,
        name: node.name,
        qualifiedName: node.qualifiedName ?? node.name,
        filePath: node.filePath,
        language: node.language,
        startLine: node.startLine ?? 0,
        endLine: node.endLine ?? 0,
        startColumn: node.startColumn ?? 0,
        endColumn: node.endColumn ?? 0,
        docstring: node.docstring ?? null,
        signature: node.signature ?? null,
        visibility: node.visibility ?? null,
        isExported: node.isExported ? 1 : 0,
        isAsync: node.isAsync ? 1 : 0,
        isStatic: node.isStatic ? 1 : 0,
        isAbstract: node.isAbstract ? 1 : 0,
        decorators: node.decorators ? JSON.stringify(node.decorators) : null,
        typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
        returnType: node.returnType ?? null,
        semanticOrigin: node.semanticOrigin ?? null,
        updatedAt: node.updatedAt ?? Date.now(),
      });
      this.takeOverSemanticNodes(node);

      // 名字词段同事务落库；孤立词段留作待核验候选，file/import 节点不计入该索引。
      if (this.isSegmentableKind(node.kind)) this.insertNameSegments(node.name);
    })();
  }

  /** Which node kinds contribute their name to the segment vocabulary — the
   *  single gate shared by insertNode, updateNode, and the rebuild page query
   *  (getDistinctNodeNames), so the write paths can't drift apart. */
  private isSegmentableKind(kind: string): boolean {
    return kind !== 'file' && kind !== 'import';
  }

  /** Write `name`'s segments into name_segment_vocab (idempotent). */
  private insertNameSegments(name: string): void {
    const rows: unknown[][] = [];
    this.collectNameSegmentRows(name, rows);
    this.runBatched(
      'insertNameSegments',
      'INSERT OR IGNORE INTO name_segment_vocab (segment, name) VALUES ',
      '(?,?)',
      rows
    );
  }

  /**
   * @brief 在事务内插入节点，真实 C/C++ ID 碰撞按源码范围消歧。
   * @param[in] nodes 待写入节点，缺少必填字段的节点仍按原规则跳过
   * @return 实际写入的节点及 canonical ID，顺序与有效输入一致
   */
  insertNodes(nodes: Node[]): Node[] {
    return this.db.transaction(() => {
      const preparedNodes = this.disambiguateBatchNodeIds(nodes);
      // Bulk path: same semantics as insertNode() per row (validation, cache
      // invalidation, segment vocab), but bound as multi-row INSERTs — the
      // per-.run() call overhead dominates the store phase on full indexes.
      const rows: unknown[][] = [];
      const segmentRows: unknown[][] = [];
      const effectiveNodes: Node[] = [];
      for (const original of preparedNodes) {
        let node = original;
        if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
          console.error('[CodeGraph] Skipping node with missing required fields:', {
            id: node.id,
            kind: node.kind,
            name: node.name,
            filePath: node.filePath,
            language: node.language,
          });
          continue;
        }
        this.nodeCache.delete(node.id);
        node = this.verifySemanticNodeIdentity(node);
        this.nodeCache.delete(node.id);
        effectiveNodes.push(node);
        rows.push([
          node.id,
          node.kind,
          node.name,
          node.qualifiedName ?? node.name,
          node.filePath,
          node.language,
          node.startLine ?? 0,
          node.endLine ?? 0,
          node.startColumn ?? 0,
          node.endColumn ?? 0,
          node.docstring ?? null,
          node.signature ?? null,
          node.visibility ?? null,
          node.isExported ? 1 : 0,
          node.isAsync ? 1 : 0,
          node.isStatic ? 1 : 0,
          node.isAbstract ? 1 : 0,
          node.decorators ? JSON.stringify(node.decorators) : null,
          node.typeParameters ? JSON.stringify(node.typeParameters) : null,
          node.returnType ?? null,
          node.semanticOrigin ?? null,
          node.updatedAt ?? Date.now(),
        ]);
        if (this.isSegmentableKind(node.kind)) this.collectNameSegmentRows(node.name, segmentRows);
      }
      this.runBatched(
        'insertNodes',
        `INSERT INTO nodes (
          id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column,
          docstring, signature, visibility,
          is_exported, is_async, is_static, is_abstract,
          decorators, type_parameters, return_type, semantic_origin, updated_at
        ) VALUES `,
        '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        rows,
        ` ON CONFLICT(id) DO UPDATE SET
          kind=excluded.kind, name=excluded.name, qualified_name=excluded.qualified_name,
          file_path=excluded.file_path, language=excluded.language,
          start_line=excluded.start_line, end_line=excluded.end_line,
          start_column=excluded.start_column, end_column=excluded.end_column,
          docstring=excluded.docstring, signature=excluded.signature,
          visibility=excluded.visibility, is_exported=excluded.is_exported,
          is_async=excluded.is_async, is_static=excluded.is_static,
          is_abstract=excluded.is_abstract, decorators=excluded.decorators,
          type_parameters=excluded.type_parameters, return_type=excluded.return_type,
          semantic_origin=excluded.semantic_origin, updated_at=excluded.updated_at`
      );
      this.runBatched(
        'insertNameSegments',
        'INSERT OR IGNORE INTO name_segment_vocab (segment, name) VALUES ',
        '(?,?)',
        segmentRows
      );
      // 基线行必须先存在：迁移 membership 时立即检查目标外键。
      for (const node of effectiveNodes) {
        this.takeOverSemanticNodes(node);
      }
      return effectiveNodes;
    })();
  }

  /**
   * @brief 在单次事务内存储文件提取结果，并映射碰撞节点对应的边与引用端点。
   * @param[in] bundle 已过滤非法节点和端点的单文件提取结果
   * @return 实际存储的 canonical 节点，顺序与有效输入一致
   *
   * Store one file's whole extraction bundle — nodes, edges, unresolved refs,
   * and the file record — in a SINGLE transaction. The bulk-index path calls
   * this once per file instead of opening one transaction per table (#1015
   * file-order commit discipline is unchanged: callers still invoke it in file
   * order, and row order within is input order).
   *
   * Edges MUST already be endpoint-filtered by the caller (the store path
   * filters to the file's own inserted node ids), so the per-file existence
   * SELECT that insertEdges() pays is skipped here.
   */
  storeFileBundle(bundle: {
    nodes: Node[];
    edges: Edge[];
    refs: UnresolvedReference[];
    file: FileRecord;
  }): Node[] {
    return this.db.transaction(() => {
      const validNodes = bundle.nodes.filter(node => node.id && node.kind && node.name && node.filePath && node.language);
      const effective = this.insertNodes(validNodes);
      const remap = new Map<string, string>();
      const ambiguous = new Set<string>();
      for (let i = 0; i < validNodes.length; i++) {
        const original = validNodes[i]!.id;
        const canonical = effective[i]!.id;
        if (remap.has(original) && remap.get(original) !== canonical) ambiguous.add(original);
        remap.set(original, canonical);
      }
      if (bundle.edges.some(edge => ambiguous.has(edge.source) || ambiguous.has(edge.target)) ||
          bundle.refs.some(ref => ambiguous.has(ref.fromNodeId))) {
        throw new Error('Ambiguous C/C++ extraction endpoint; disambiguate before emitting references');
      }
      if (bundle.edges.length > 0) {
        const rows: unknown[][] = [];
        for (const edge of bundle.edges) {
          rows.push([
            remap.get(edge.source) ?? edge.source,
            remap.get(edge.target) ?? edge.target,
            edge.kind,
            edge.metadata ? JSON.stringify(edge.metadata) : null,
            edge.line ?? null,
            edge.column ?? null,
            edge.provenance ?? null,
          ]);
        }
        this.runBatched(
          'insertEdges',
          'INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance) VALUES ',
          '(?,?,?,?,?,?,?)',
          rows
        );
      }
      if (bundle.refs.length > 0) this.insertUnresolvedRefsBatch(bundle.refs.map(ref => ({
        ...ref, fromNodeId: remap.get(ref.fromNodeId) ?? ref.fromNodeId,
      })));
      this.upsertFile(bundle.file);
      return effective;
    })();
  }

  /**
   * Collect (segment, name) rows for a name, honouring the same session-dedupe
   * semantics as insertNameSegments(). Shared by the bulk write paths.
   */
  private collectNameSegmentRows(name: string, out: unknown[][]): void {
    if (this.segmentedNames.has(name)) return;
    if (this.segmentedNames.size >= QueryBuilder.MAX_SEGMENTED_NAMES) this.segmentedNames.clear();
    this.segmentedNames.add(name);
    for (const segment of splitIdentifierSegments(name)) out.push([segment, name]);
  }

  /**
   * Update an existing node
   */
  updateNode(node: Node): void {
    if (!this.stmts.updateNode) {
      this.stmts.updateNode = this.db.prepare(`
        UPDATE nodes SET
          kind = @kind,
          name = @name,
          qualified_name = @qualifiedName,
          file_path = @filePath,
          language = @language,
          start_line = @startLine,
          end_line = @endLine,
          start_column = @startColumn,
          end_column = @endColumn,
          docstring = @docstring,
          signature = @signature,
          visibility = @visibility,
          is_exported = @isExported,
          is_async = @isAsync,
          is_static = @isStatic,
          is_abstract = @isAbstract,
          decorators = @decorators,
          type_parameters = @typeParameters,
          return_type = @returnType,
          updated_at = @updatedAt
        WHERE id = @id
      `);
    }

    // Invalidate cache before update
    this.nodeCache.delete(node.id);

    // Validate required fields
    if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
      console.error('[CodeGraph] Skipping node update with missing required fields:', node.id);
      return;
    }

    this.stmts.updateNode.run({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName ?? node.name,
      filePath: node.filePath,
      language: node.language,
      startLine: node.startLine ?? 0,
      endLine: node.endLine ?? 0,
      startColumn: node.startColumn ?? 0,
      endColumn: node.endColumn ?? 0,
      docstring: node.docstring ?? null,
      signature: node.signature ?? null,
      visibility: node.visibility ?? null,
      isExported: node.isExported ? 1 : 0,
      isAsync: node.isAsync ? 1 : 0,
      isStatic: node.isStatic ? 1 : 0,
      isAbstract: node.isAbstract ? 1 : 0,
      decorators: node.decorators ? JSON.stringify(node.decorators) : null,
      typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
      returnType: node.returnType ?? null,
      updatedAt: node.updatedAt ?? Date.now(),
    });

    // updateNode is a second real write path to `nodes` — framework
    // post-extract passes rewrite names through it (NestJS route prefixing),
    // and a renamed node's new name must reach the segment vocabulary just
    // like an inserted one's (#1141). Without this the rename left the new
    // name permanently unsearchable: the old name's rows became honest-gate
    // orphans and the only backfill is gated on the vocab being EMPTY.
    // insertNameSegments is idempotent (in-memory set + INSERT OR IGNORE),
    // so no name-changed check is needed.
    if (this.isSegmentableKind(node.kind)) this.insertNameSegments(node.name);
  }

  /**
   * Delete a node by ID
   */
  deleteNode(id: string): void {
    if (!this.stmts.deleteNode) {
      this.stmts.deleteNode = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    }
    // Invalidate cache
    this.nodeCache.delete(id);
    this.stmts.deleteNode.run(id);
  }

  /**
   * Delete all nodes for a file
   */
  deleteNodesByFile(filePath: string): void {
    if (!this.stmts.deleteNodesByFile) {
      this.stmts.deleteNodesByFile = this.db.prepare('DELETE FROM nodes WHERE file_path = ?');
    }
    // Invalidate cache for nodes in this file
    for (const [id, node] of this.nodeCache) {
      if (node.filePath === filePath) {
        this.nodeCache.delete(id);
      }
    }
    this.stmts.deleteNodesByFile.run(filePath);
  }

  // ===========================================================================
  // Name-segment vocabulary (prompt-hook graph-derived gate)
  // ===========================================================================

  /** Wipe the segment vocabulary. A full index calls this at its start; the
   *  node write path repopulates it as files (re-)index, so the end state is
   *  exactly the current names with no orphan rows. */
  clearNameSegmentVocab(): void {
    this.db.exec('DELETE FROM name_segment_vocab');
    this.segmentedNames.clear();
  }

  /** True when the vocab has no rows — an index built before the table existed.
   *  `sync` uses this to heal such databases (see rebuildNameSegmentVocabFrom). */
  isNameSegmentVocabEmpty(): boolean {
    const row = this.db.prepare('SELECT 1 FROM name_segment_vocab LIMIT 1').get();
    return row === undefined;
  }

  /** One page of distinct segmentable node names, for batched vocab rebuilds
   *  (file basenames and import specifiers are excluded from the vocab — see
   *  insertNode). */
  getDistinctNodeNames(limit: number, offset: number): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT name FROM nodes WHERE kind NOT IN ('file', 'import') ORDER BY name LIMIT ? OFFSET ?")
      .all(limit, offset) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  /** Insert segments for a batch of names in one transaction (vocab heal path). */
  insertNameSegmentsBatch(names: string[]): void {
    this.db.transaction(() => {
      const rows: unknown[][] = [];
      for (const name of names) this.collectNameSegmentRows(name, rows);
      this.runBatched(
        'insertNameSegments',
        'INSERT OR IGNORE INTO name_segment_vocab (segment, name) VALUES ',
        '(?,?)',
        rows
      );
    })();
  }

  /**
   * Names whose segments cover at least `minWords` distinct PROMPT WORDS —
   * the co-occurrence probe behind the prompt hook's medium tier: the words
   * "state" and "machine" both being segments of `OrderStateMachine` is strong
   * evidence the prompt names that symbol in prose. Ordered by coverage.
   *
   * Takes (segment variant → original word) pairs and folds variants back to
   * their word INSIDE the SQL: a name matching both `service` and `services`
   * counts ONE word, not two. Counting raw variants let plural-variant pairs
   * of a single word tie with genuine two-word matches and — because ORDER
   * BY/LIMIT run here, before any JS-side re-check — crowd a real match past
   * the LIMIT on vocab-heavy repos (#1146).
   */
  getSegmentCoOccurrence(
    variants: Array<{ segment: string; word: string }>,
    minWords: number,
    limit: number,
  ): Array<{ name: string; matches: number }> {
    if (variants.length === 0) return [];
    const placeholders = variants.map(() => '?').join(', ');
    const whens = variants.map(() => 'WHEN ? THEN ?').join(' ');
    const rows = this.db
      .prepare(
        `SELECT name, COUNT(DISTINCT CASE segment ${whens} END) AS matches
         FROM name_segment_vocab
         WHERE segment IN (${placeholders})
         GROUP BY name
         HAVING matches >= ?
         ORDER BY matches DESC, length(name) ASC
         LIMIT ?`,
      )
      .all(
        ...variants.flatMap((v) => [v.segment, v.word]),
        ...variants.map((v) => v.segment),
        minWords,
        limit,
      ) as Array<{ name: string; matches: number }>;
    return rows;
  }

  /** How many distinct names each segment appears in — the rarity signal that
   *  separates a discriminative word ("checkout") from a ubiquitous one ("state"). */
  getSegmentNameCounts(segments: string[]): Map<string, number> {
    if (segments.length === 0) return new Map();
    const placeholders = segments.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT segment, COUNT(*) AS n FROM name_segment_vocab
         WHERE segment IN (${placeholders}) GROUP BY segment`,
      )
      .all(...segments) as Array<{ segment: string; n: number }>;
    return new Map(rows.map((r) => [r.segment, r.n]));
  }

  /** Names containing the given segment (rare-single-word tier). */
  getNamesForSegment(segment: string, limit: number): string[] {
    const rows = this.db
      .prepare('SELECT name FROM name_segment_vocab WHERE segment = ? ORDER BY length(name) ASC LIMIT ?')
      .all(segment, limit) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  /**
   * Get a node by ID
   */
  getNodeById(id: string): Node | null {
    // Check cache first
    if (this.nodeCache.has(id)) {
      const cached = this.nodeCache.get(id)!;
      // Move to end to implement LRU (delete and re-add)
      this.nodeCache.delete(id);
      this.nodeCache.set(id, cached);
      return cached;
    }

    if (!this.stmts.getNodeById) {
      this.stmts.getNodeById = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    }
    const row = this.stmts.getNodeById.get(id) as NodeRow | undefined;
    if (!row) {
      return null;
    }

    const node = rowToNode(row);
    this.cacheNode(node);
    return node;
  }

  /**
   * Batch lookup: fetch many nodes by ID in a single SQL round-trip.
   *
   * Replaces the N+1 pattern in graph traversal where every edge would
   * trigger its own `getNodeById` call. For a function with 50 callers
   * this collapses 50 point reads into one IN-list query (~10-50x
   * faster end-to-end).
   *
   * Returns a Map keyed by id so callers can preserve their own ordering
   * (typically the order edges were returned from the graph). Missing IDs
   * are simply absent from the map.
   *
   * Cache-aware: ids already in the LRU cache are served from memory and
   * the SQL query only touches the misses.
   */
  getNodesByIds(ids: readonly string[]): Map<string, Node> {
    const out = new Map<string, Node>();
    if (ids.length === 0) return out;

    // Serve cache hits first; build the miss list for SQL.
    const misses: string[] = [];
    for (const id of ids) {
      const cached = this.nodeCache.get(id);
      if (cached !== undefined) {
        // LRU touch
        this.nodeCache.delete(id);
        this.nodeCache.set(id, cached);
        out.set(id, cached);
      } else {
        misses.push(id);
      }
    }
    if (misses.length === 0) return out;

    // Chunk under SQLite's parameter limit (default 999, raised to 32766
    // in better-sqlite3 builds — chunk at 500 for safety across both
    // backends and to keep the query plan simple).
    for (let i = 0; i < misses.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = misses.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`)
        .all(...chunk) as NodeRow[];
      for (const row of rows) {
        const node = rowToNode(row);
        out.set(node.id, node);
        this.cacheNode(node);
      }
    }
    return out;
  }

  private getExistingNodeIds(ids: readonly string[]): Set<string> {
    const out = new Set<string>();
    if (ids.length === 0) return out;

    const uniqueIds = [...new Set(ids)];
    for (let i = 0; i < uniqueIds.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = uniqueIds.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT id FROM nodes WHERE id IN (${placeholders})`)
        .all(...chunk) as { id: string }[];
      for (const row of rows) {
        out.add(row.id);
      }
    }

    return out;
  }

  /**
   * Add a node to the cache, evicting oldest if needed
   */
  private cacheNode(node: Node): void {
    if (this.nodeCache.size >= this.maxCacheSize) {
      // Evict oldest (first) entry
      const firstKey = this.nodeCache.keys().next().value;
      if (firstKey) {
        this.nodeCache.delete(firstKey);
      }
    }
    this.nodeCache.set(node.id, node);
  }

  /**
   * Clear the node cache
   */
  clearCache(): void {
    this.nodeCache.clear();
  }

  /**
   * Get all nodes in a file
   */
  getNodesByFile(filePath: string): Node[] {
    if (!this.stmts.getNodesByFile) {
      this.stmts.getNodesByFile = this.db.prepare(
        'SELECT * FROM nodes WHERE file_path = ? ORDER BY start_line'
      );
    }
    const rows = this.stmts.getNodesByFile.all(filePath) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Find the file that holds the densest concentration of the project's
   * internal call graph — the "core" file. Used by context-builder to
   * boost ranking of symbols in that file's directory (so e.g. sinatra
   * queries surface `lib/sinatra/base.rb`'s `route!` instead of
   * `sinatra-contrib/lib/sinatra/multi_route.rb`'s `route` extension).
   *
   * Returns null if no file has a meaningful concentration (e.g. spread
   * evenly across many files, or empty index).
   *
   * "Internal" = source and target are in the same file. Cross-file
   * edges aren't useful here — they don't tell us which file is the
   * functional center.
   *
   * Excludes test/spec files from candidacy via path-pattern. The agent's
   * typical question is "how does X work", not "how is X tested", so
   * boosting a test file's directory would be a misfire.
   */
  getDominantFile(): { filePath: string; edgeCount: number; nextEdgeCount: number } | null {
    if (!this.stmts.getDominantFile) {
      // Pull top 20 candidates; we then filter out test/generated files
      // in code (regex-grade matching that SQL LIKE can't express). The
      // generated-file filter is critical — without it, etcd's
      // `api/etcdserverpb/rpc.pb.go` (1916 in-file edges, generated
      // protobuf stub) outranks the real `server/etcdserver/server.go`
      // (470 edges) by 4×, and the boost would push the agent toward
      // generated code.
      this.stmts.getDominantFile = this.db.prepare(`
        SELECT n.file_path AS file_path, COUNT(*) AS edge_count
        FROM edges e
        JOIN nodes n ON e.source = n.id
        JOIN nodes m ON e.target = m.id
        WHERE n.file_path = m.file_path
        GROUP BY n.file_path
        ORDER BY edge_count DESC
        LIMIT 20
      `);
    }
    const rows = this.stmts.getDominantFile.all() as Array<{ file_path: string; edge_count: number }>;
    const generated = this.getGeneratedPathsAmong(rows.map(r => r.file_path));
    const filtered = rows.filter(r => !isLowValueFile(r.file_path, generated));
    if (filtered.length === 0 || filtered[0]!.edge_count < 20) return null;
    return {
      filePath: filtered[0]!.file_path,
      edgeCount: filtered[0]!.edge_count,
      nextEdgeCount: filtered[1]?.edge_count ?? 0,
    };
  }

  /**
   * Find the file that holds the densest concentration of the project's
   * `route` nodes (framework-emitted: Express/Gin/Flask/Rails/Drupal/etc.).
   * Used by handleContext on small repos to inline the project's routing
   * config when the agent's query is about request flow — eliminating the
   * "Glob + Read routes.rb" pattern that beats codegraph on tiny realworld
   * template repos.
   *
   * Excludes test/generated files from candidacy. Returns null if there
   * are fewer than 3 non-test routes total, or if no file holds at least
   * 30% of them (diffuse routing → no single answer file).
   */
  getTopRouteFile(): { filePath: string; routeCount: number; totalRoutes: number } | null {
    if (!this.stmts.getTopRouteFile) {
      this.stmts.getTopRouteFile = this.db.prepare(`
        SELECT file_path, COUNT(*) AS cnt
        FROM nodes
        WHERE kind = 'route'
        GROUP BY file_path
        ORDER BY cnt DESC
        LIMIT 20
      `);
    }
    const rows = this.stmts.getTopRouteFile.all() as Array<{ file_path: string; cnt: number }>;
    const generated = this.getGeneratedPathsAmong(rows.map(r => r.file_path));
    const filtered = rows.filter(r => !isLowValueFile(r.file_path, generated));
    if (filtered.length === 0) return null;
    const totalRoutes = filtered.reduce((sum, r) => sum + r.cnt, 0);
    const top = filtered[0]!;
    if (totalRoutes < 3 || top.cnt < 3) return null;
    if (top.cnt / totalRoutes < 0.30) return null;
    return { filePath: top.file_path, routeCount: top.cnt, totalRoutes };
  }

  /**
   * Build a URL → handler manifest from the index. Each route node's
   * `references` edge points at the function/method that handles the
   * request. We join them in one pass; the agent gets the canonical
   * routing answer ("POST /users/login → AuthController#login") without
   * having to parse the framework's route DSL itself.
   *
   * Also returns the file with the most handler endpoints — used as the
   * "top handler file" to inline source for, so the agent has both the
   * mapping AND the handler implementations.
   */
  getRoutingManifest(limit: number = 40): {
    entries: Array<{ url: string; handler: string; handlerFile: string; handlerLine: number; handlerKind: string }>;
    topHandlerFile: string | null;
    topHandlerFileCount: number;
    totalRoutes: number;
  } | null {
    if (!this.stmts.getRoutingManifest) {
      // Edge kind varies across framework resolvers: Spring/Rails/
      // Laravel/Drupal emit `references`, Express emits `calls`. Accept
      // both — the semantic is the same (route → its handler).
      this.stmts.getRoutingManifest = this.db.prepare(`
        SELECT
          r.name AS url,
          h.name AS handler,
          h.file_path AS handler_file,
          h.start_line AS handler_line,
          h.kind AS handler_kind
        FROM nodes r
        JOIN edges e ON e.source = r.id
        JOIN nodes h ON e.target = h.id
        WHERE r.kind = 'route'
          AND e.kind IN ('references', 'calls')
          AND h.kind IN ('function', 'method', 'class')
        ORDER BY r.file_path, r.start_line
        LIMIT ?
      `);
    }
    const rows = this.stmts.getRoutingManifest.all(limit) as Array<{
      url: string; handler: string; handler_file: string; handler_line: number; handler_kind: string;
    }>;
    // Drop test/generated handlers — same hygiene as elsewhere.
    const generated = this.getGeneratedPathsAmong(rows.map(r => r.handler_file));
    const filtered = rows.filter(r => !isLowValueFile(r.handler_file, generated));
    if (filtered.length < 3) return null;
    // Identify the file holding the most handlers (the "primary handler file").
    const fileCounts = new Map<string, number>();
    for (const r of filtered) {
      fileCounts.set(r.handler_file, (fileCounts.get(r.handler_file) ?? 0) + 1);
    }
    let topHandlerFile: string | null = null;
    let topHandlerFileCount = 0;
    for (const [file, count] of fileCounts) {
      if (count > topHandlerFileCount) {
        topHandlerFile = file;
        topHandlerFileCount = count;
      }
    }
    return {
      entries: filtered.map(r => ({
        url: r.url,
        handler: r.handler,
        handlerFile: r.handler_file,
        handlerLine: r.handler_line,
        handlerKind: r.handler_kind,
      })),
      topHandlerFile,
      topHandlerFileCount,
      totalRoutes: filtered.length,
    };
  }

  /**
   * Get all nodes of a specific kind
   */
  getNodesByKind(kind: NodeKind): Node[] {
    if (!this.stmts.getNodesByKind) {
      this.stmts.getNodesByKind = this.db.prepare('SELECT * FROM nodes WHERE kind = ?');
    }
    const rows = this.stmts.getNodesByKind.all(kind) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Stream every node of a kind one at a time (lazy) instead of materializing
   * them all like {@link getNodesByKind}. For unbounded kinds (`function`,
   * `method`) on a symbol-dense project the full array is gigabytes; the
   * dynamic-edge synthesizers only scan-and-filter, so they iterate to keep
   * memory O(1) in the node count rather than O(nodes) (#610).
   */
  *iterateNodesByKind(kind: NodeKind): IterableIterator<Node> {
    // Fresh statement per call (not a cached one): an iterator holds an open
    // cursor, so a shared statement would conflict across overlapping scans.
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE kind = ?');
    for (const row of stmt.iterate(kind)) {
      yield rowToNode(row as NodeRow);
    }
  }

  /**
   * Get all nodes in the database
   */
  getAllNodes(): Node[] {
    const rows = this.db.prepare('SELECT * FROM nodes').all() as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Stream nodes of one language whose `decorators` JSON array contains
   * `decorator`. The LIKE on the JSON text is a cheap index-free pre-filter
   * (a decorator name can appear as a substring of another), so callers must
   * still exact-check `node.decorators.includes(decorator)`. Exists so the
   * kotlin expect/actual synthesizer never materializes the whole node table
   * the way `getAllNodes().filter(...)` did — that array alone OOM'd Node's
   * default heap on a 2M-node graph (#1212).
   */
  *iterateNodesByLanguageWithDecorator(language: Language, decorator: string): IterableIterator<Node> {
    // Fresh statement per call — an iterator holds an open cursor (see
    // iterateNodesByKind).
    const stmt = this.db.prepare(
      "SELECT * FROM nodes WHERE language = ? AND decorators LIKE '%' || ? || '%'"
    );
    for (const row of stmt.iterate(language, `"${decorator}"`)) {
      yield rowToNode(row as NodeRow);
    }
  }

  /**
   * Distinct languages present in the files table. One indexed aggregate —
   * lets the dynamic-edge synthesizers skip passes for languages the project
   * doesn't contain at all (a Kotlin pass has no work on a pure-C repo), so
   * their cost is zero rather than a full-graph scan that finds nothing (#1212).
   */
  getDistinctFileLanguages(): Set<string> {
    const rows = this.db.prepare('SELECT DISTINCT language FROM files').all() as Array<{ language: string }>;
    return new Set(rows.map((r) => r.language));
  }

  /**
   * Get nodes by exact name match (uses idx_nodes_name index).
   *
   * This is resolution's candidate list, and the ORDER BY is load-bearing for
   * index correctness, not cosmetic (CG-33). When a reference names a symbol
   * that several files define and nothing disambiguates them, resolution binds
   * to the first candidate — so without an ORDER BY the winner was decided by
   * rowid, i.e. by the order files happened to be WRITTEN. A full index writes
   * them in scan order; an incremental sync appends each file as it changes, so
   * the same tree resolved to different edges depending on how the index was
   * built, and a long-lived synced index drifted away from a rebuild of itself
   * (measured at 4.3% of distinct edges, mostly `calls`).
   *
   * `(file_path, start_line)` is a property of the CODE, so both paths now pick
   * the same candidate. The sort is paid once per distinct name per resolution
   * run — ReferenceResolver memoizes this in its nameCache — and the population
   * is capped by AMBIGUOUS_NAME_CEILING (#999).
   */
  getNodesByName(name: string): Node[] {
    if (!this.stmts.getNodesByName) {
      this.stmts.getNodesByName = this.db.prepare(
        'SELECT * FROM nodes WHERE name = ? ORDER BY file_path, start_line'
      );
    }
    const rows = this.stmts.getNodesByName.all(name) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Nodes whose name starts with `prefix`, by index range scan (a LIKE would
   * skip idx_nodes_name under SQLite's default case-insensitive LIKE).
   */
  getNodesByNamePrefix(prefix: string, limit = 20): Node[] {
    if (!this.stmts.getNodesByNamePrefix) {
      this.stmts.getNodesByNamePrefix = this.db.prepare(
        'SELECT * FROM nodes WHERE name >= ? AND name < ? ORDER BY name LIMIT ?'
      );
    }
    const rows = this.stmts.getNodesByNamePrefix.all(prefix, prefix + '￿', limit) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get nodes by exact qualified name match (uses idx_nodes_qualified_name index)
   */
  getNodesByQualifiedNameExact(qualifiedName: string): Node[] {
    if (!this.stmts.getNodesByQualifiedNameExact) {
      this.stmts.getNodesByQualifiedNameExact = this.db.prepare(
        'SELECT * FROM nodes WHERE qualified_name = ?'
      );
    }
    const rows = this.stmts.getNodesByQualifiedNameExact.all(qualifiedName) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get nodes by name, case-insensitively (seeks the idx_nodes_lower_name
   * expression index).
   *
   * The parameter is lowered in SQL rather than trusted to arrive lowered, so
   * the lookup means the same thing whatever casing a caller hands it. Written
   * as a bare `lower(name) = ?` it silently returned nothing for any input
   * carrying an uppercase letter, and — because SQLite's `lower()` folds ASCII
   * only while JavaScript's `.toLowerCase()` folds Unicode — a caller that
   * pre-lowered in JavaScript could not match a non-ASCII name at all.
   *
   * Note this hardens the query, not its one caller: `matchFuzzy` still lowers
   * in JavaScript before calling, so the non-ASCII gap remains open there.
   */
  getNodesByLowerName(name: string): Node[] {
    if (!this.stmts.getNodesByLowerName) {
      this.stmts.getNodesByLowerName = this.db.prepare(
        'SELECT * FROM nodes WHERE lower(name) = lower(?)'
      );
    }
    const rows = this.stmts.getNodesByLowerName.all(name) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Search nodes by name using FTS with fallback to LIKE for better matching
   *
   * Search strategy:
   * 1. Try FTS5 prefix match (query*) for word-start matching
   * 2. If no results, try LIKE for substring matching (e.g., "signIn" finds "signInWithGoogle")
   * 3. Score results based on match quality
   */
  searchNodes(query: string, options: SearchOptions = {}): SearchResult[] {
    const { limit = 100, offset = 0 } = options;

    // Parse field-qualified bits out of the raw query (kind:, lang:,
    // path:, name:). Anything not recognised stays in `text` and goes
    // to FTS unchanged. Filters compose with the SearchOptions arg —
    // both are applied (intersection-style).
    const parsed = parseQuery(query);
    const mergedKinds =
      parsed.kinds.length > 0
        ? Array.from(new Set([...(options.kinds ?? []), ...parsed.kinds]))
        : options.kinds;
    const mergedLanguages =
      parsed.languages.length > 0
        ? Array.from(new Set([...(options.languages ?? []), ...parsed.languages]))
        : options.languages;
    const pathFilters = parsed.pathFilters;
    const nameFilters = parsed.nameFilters;
    // The text portion drives FTS/LIKE; if all the user typed was
    // filters (`kind:function`), we still need *some* candidate set,
    // so synthesise an empty-text path that returns everything matching
    // the filters.
    const text = parsed.text;
    const kinds = mergedKinds;
    const languages = mergedLanguages;

    // First try FTS5 with prefix matching
    let results = text
      ? this.searchNodesFTS(text, { kinds, languages, limit, offset })
      // Over-fetch by 5× when running filter-only (no text). The
      // post-scoring path: + name: filters can be very selective, so
      // a smaller multiplier risks returning fewer than `limit`
      // results despite the DB having plenty of matches.
      : this.searchAllByFilters({ kinds, languages, limit: limit * 5 });

    // If no FTS results, try LIKE-based substring search
    if (results.length === 0 && text.length >= 2) {
      results = this.searchNodesLike(text, { kinds, languages, limit, offset });
    }

    // Final fuzzy fallback: scan all known names and keep those within
    // a tight Levenshtein distance. Only fires when both FTS and LIKE
    // returned nothing AND there's a text portion long enough to be
    // worth fuzzing (1-char queries would match too much).
    if (results.length === 0 && text.length >= 3) {
      results = this.searchNodesFuzzy(text, { kinds, languages, limit });
    }

    // Supplement: ensure exact name matches are always candidates.
    // BM25 can bury short exact-match names (e.g. "getBean") under hundreds of
    // compound names (e.g. "getBeanDescriptor") in large codebases,
    // pushing them past the FTS fetch limit before post-hoc scoring can help.
    // Use the max BM25 score as the base so the nameMatchBonus (exact=30 vs
    // prefix=20) actually differentiates them after rescoring.
    //
    // Whole-name equality MUST be written as `lower(name) = lower(?)` so it
    // seeks `idx_nodes_lower_name`. The equivalent `name = ? COLLATE NOCASE`
    // matches no index — `idx_nodes_name` is BINARY-collated and the expression
    // index only matches the same expression — and degrades to a full table
    // scan. The `LIMIT 20` does not rescue it: SQLite can only stop early once
    // it has produced 20 rows, and this runs once per query term, most of which
    // name nothing in the corpus. Measured per term on an unmatched term:
    // 0.08ms on gin (2.5k nodes), 0.39ms on excalidraw (11k), 2.4ms on django
    // (62k) — and growing with the corpus, where the seek is flat at ~0.002ms.
    // Lowering the parameter in SQL rather than in JS is deliberate: SQLite's
    // `lower()` and NOCASE both fold ASCII only, while JS `.toLowerCase()`
    // folds Unicode, which would silently stop matching non-ASCII names.
    if (results.length > 0 && query) {
      const existingIds = new Set(results.map(r => r.node.id));
      const maxFtsScore = Math.max(...results.map(r => r.score));
      const terms = query.split(/\s+/).filter(t => t.length >= 2);
      for (const term of terms) {
        let sql = 'SELECT * FROM nodes WHERE lower(name) = lower(?)';
        const params: (string | number)[] = [term];
        if (kinds && kinds.length > 0) {
          sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
          params.push(...kinds);
        }
        if (languages && languages.length > 0) {
          sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
          params.push(...languages);
        }
        sql += ' LIMIT 20';
        const rows = this.db.prepare(sql).all(...params) as NodeRow[];
        for (const row of rows) {
          if (!existingIds.has(row.id)) {
            results.push({ node: rowToNode(row), score: maxFtsScore });
            existingIds.add(row.id);
          }
        }
      }
    }

    // Apply multi-signal scoring
    if (results.length > 0 && (text || query)) {
      const scoringQuery = text || query;
      results = results.map(r => {
        // A path the project de-prioritized is saying its symbol NAMES are not
        // the answer, so the exact-name bonus has to be damped too. The -15 path
        // penalty alone cannot do it: the bonus is additive and larger (measured
        // on #982's repro, a `usage()` helper sat at 74.8 vs 51.2 for the top
        // product symbol — -15 lands at 59.8, still ahead). Damped, not zeroed,
        // so the tree stays findable when it genuinely is what you asked for.
        // Evaluated once and reused: the predicate stats the config file.
        const deprioritized = this.isDeprioritizedPath?.(r.node.filePath) ?? false;
        const nameBonus = nameMatchBonus(r.node.name, scoringQuery);
        return {
          ...r,
          score: r.score
            + kindBonus(r.node.kind)
            + scorePathRelevance(r.node.filePath, scoringQuery, this.projectNameTokens, deprioritized)
            + (deprioritized ? Math.round(nameBonus * DEPRIORITIZED_NAME_BONUS_SCALE) : nameBonus),
        };
      });
      results.sort((a, b) => b.score - a.score);
      // Trim to requested limit after rescoring
      if (results.length > limit) {
        results = results.slice(0, limit);
      }
    }

    // Apply path: + name: filters AFTER scoring. Scoring already uses
    // path/name as a soft signal; the explicit filters here are a hard
    // gate. Done last so the FTS limit fetched plenty of candidates to
    // narrow from.
    if (pathFilters.length > 0) {
      const lowered = pathFilters.map((p) => p.toLowerCase());
      results = results.filter((r) => {
        const fp = r.node.filePath.toLowerCase();
        return lowered.some((p) => fp.includes(p));
      });
    }
    if (nameFilters.length > 0) {
      const lowered = nameFilters.map((n) => n.toLowerCase());
      results = results.filter((r) => {
        const nm = r.node.name.toLowerCase();
        return lowered.some((n) => nm.includes(n));
      });
    }

    return results;
  }

  /**
   * Match-everything path used when the user supplied only field
   * filters (`kind:function lang:typescript`) with no text. Returns
   * candidates ordered by name; the caller's filter pass narrows to
   * what was asked for.
   */
  private searchAllByFilters(options: {
    kinds?: NodeKind[];
    languages?: Language[];
    limit: number;
  }): SearchResult[] {
    const { kinds, languages, limit } = options;
    let sql = 'SELECT * FROM nodes WHERE 1=1';
    const params: (string | number)[] = [];
    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }
    sql += ' ORDER BY name LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as NodeRow[];
    return rows.map((row) => ({ node: rowToNode(row), score: 1 }));
  }

  /**
   * Fuzzy fallback: when zero FTS/LIKE hits, try an edit-distance
   * sweep over the distinct symbol-name set. Caps `maxDist` at 2 so
   * `getUssr` finds `getUser` but `process` doesn't match `prosody`.
   * Bounded edit distance keeps each comparison cheap; the per-query
   * scan is O(distinct-name-count) which is far smaller than total
   * node count on any real codebase.
   */
  private searchNodesFuzzy(
    text: string,
    options: { kinds?: NodeKind[]; languages?: Language[]; limit: number }
  ): SearchResult[] {
    const { kinds, languages, limit } = options;
    const lowered = text.toLowerCase();
    const maxDist = lowered.length <= 4 ? 1 : 2;

    // Pull the distinct name list once. The set is cached on QueryBuilder
    // by getAllNodeNames(); even on a 200k-node project the distinct
    // name set is typically O(10k) because most names repeat. The
    // candidate-cap below bounds memory regardless.
    const allNames = this.getAllNodeNames();
    const candidates: Array<{ name: string; dist: number }> = [];
    for (const name of allNames) {
      const dist = boundedEditDistance(name.toLowerCase(), lowered, maxDist);
      if (dist <= maxDist) candidates.push({ name, dist });
    }
    candidates.sort((a, b) => a.dist - b.dist);

    // Cap the per-name follow-up queries. Each survivor triggers a
    // separate `SELECT * FROM nodes WHERE name = ?`; without this cap
    // a project with many similar names (`getUser1`, `getUser2`...)
    // could fan out far beyond `limit` queries before the inner-loop
    // limit kicks in.
    const FUZZY_FOLLOWUP_CAP = Math.max(limit * 2, 50);
    const cappedCandidates = candidates.slice(0, FUZZY_FOLLOWUP_CAP);

    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const c of cappedCandidates) {
      if (results.length >= limit) break;
      let sql = 'SELECT * FROM nodes WHERE name = ?';
      const params: (string | number)[] = [c.name];
      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }
      if (languages && languages.length > 0) {
        sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
        params.push(...languages);
      }
      sql += ' LIMIT 5';
      const rows = this.db.prepare(sql).all(...params) as NodeRow[];
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        // Lower the score for each edit step away from the query so
        // exact-match fallbacks (dist 0) outrank dist-2 typos.
        results.push({ node: rowToNode(row), score: 1 / (1 + c.dist) });
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  /**
   * FTS5 search with prefix matching
   */
  private searchNodesFTS(query: string, options: SearchOptions): SearchResult[] {
    const { kinds, languages, limit = 100, offset = 0 } = options;

    // Add prefix wildcard for better matching (e.g., "auth" matches "AuthService", "authenticate")
    // Escape special FTS5 characters and add prefix wildcard.
    //
    // `::` is a qualifier separator in Rust/C++/Ruby, not a token char,
    // so treat it as whitespace before the strip step. Otherwise queries
    // like `stage_apply::run` collapse to `stage_applyrun` (the colons
    // are stripped without splitting) and find nothing. See #173.
    const ftsQuery = query
      .replace(/::/g, ' ') // Rust/C++/Ruby qualifier separator
      .replace(/['"*():^]/g, '') // Remove FTS5 special chars
      .split(/\s+/)
      .filter(term => term.length > 0)
      // Strip FTS5 boolean operators to prevent query manipulation
      .filter(term => !/^(AND|OR|NOT|NEAR)$/i.test(term))
      .map(term => `"${term}"*`) // Prefix match each term
      .join(' OR ');

    if (!ftsQuery) {
      return [];
    }

    // BM25 column weights: id=0, name=20, qualified_name=5, docstring=1, signature=2
    // Heavy name weight ensures exact/prefix name matches rank above incidental
    // mentions in long docstrings or qualified names of nested symbols.
    // Fetch 5x requested limit so post-hoc rescoring (kindBonus, pathRelevance,
    // nameMatchBonus) can promote results that BM25 alone undervalues.
    const ftsLimit = Math.max(limit * 5, 100);

    let sql = `
      SELECT nodes.*, bm25(nodes_fts, 0, 20, 5, 1, 2) as score
      FROM nodes_fts
      JOIN nodes ON nodes_fts.id = nodes.id
      WHERE nodes_fts MATCH ?
    `;

    const params: (string | number)[] = [ftsQuery];

    if (kinds && kinds.length > 0) {
      sql += ` AND nodes.kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND nodes.language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY score LIMIT ? OFFSET ?';
    params.push(ftsLimit, offset);

    try {
      const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
      return rows.map((row) => ({
        node: rowToNode(row),
        score: Math.abs(row.score), // bm25 returns negative scores
      }));
    } catch {
      // FTS query failed, return empty
      return [];
    }
  }

  /**
   * LIKE-based substring search for cases where FTS doesn't match
   * Useful for camelCase matching (e.g., "signIn" finds "signInWithGoogle")
   */
  private searchNodesLike(query: string, options: SearchOptions): SearchResult[] {
    const { kinds, languages, limit = 100, offset = 0 } = options;

    let sql = `
      SELECT nodes.*,
        CASE
          WHEN name = ? THEN 1.0
          WHEN name LIKE ? THEN 0.9
          WHEN name LIKE ? THEN 0.8
          WHEN qualified_name LIKE ? THEN 0.7
          ELSE 0.5
        END as score
      FROM nodes
      WHERE (
        name LIKE ? OR
        qualified_name LIKE ? OR
        name LIKE ?
      )
    `;

    // Pattern variants for better matching
    const exactMatch = query;
    const startsWith = `${query}%`;
    const contains = `%${query}%`;

    const params: (string | number)[] = [
      exactMatch,     // Exact match score
      startsWith,     // Starts with score
      contains,       // Contains score
      contains,       // Qualified name score
      contains,       // WHERE: name contains
      contains,       // WHERE: qualified_name contains
      startsWith,     // WHERE: name starts with
    ];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY score DESC, length(name) ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];

    return rows.map((row) => ({
      node: rowToNode(row),
      score: row.score,
    }));
  }

  /**
   * Find nodes by exact name match
   *
   * Used for hybrid search - looks up symbols by exact name or case-insensitive match.
   * Returns high-confidence matches for known symbol names extracted from query.
   *
   * @param names - Array of symbol names to look up
   * @param options - Search options (kinds, languages, limit)
   * @returns SearchResult array with exact matches scored at 1.0
   */
  findNodesByExactName(names: string[], options: SearchOptions = {}): SearchResult[] {
    if (names.length === 0) return [];

    const { kinds, languages, limit = 50 } = options;

    // Two-pass approach to handle common names (e.g., "run" has 40+ matches):
    // Pass 1: Find which files contain distinctive (rare) symbols from the query.
    // Pass 2: Query each name, boosting results that co-locate with distinctive symbols.

    // Pass 1: Find files containing each queried name, identify distinctive names
    //
    // Both passes spell whole-name equality as `lower(name) = lower(?)` so they
    // seek `idx_nodes_lower_name` — see the note in `searchNodes` for why the
    // `name = ? COLLATE NOCASE` form full-scans instead. This path is the one
    // that hurts most: it runs both passes for every symbol extracted from the
    // query, and extraction is generous, so most of those names are absent from
    // the corpus and never reach either LIMIT.
    const nameToFiles = new Map<string, Set<string>>();
    for (const name of names) {
      let sql = 'SELECT DISTINCT file_path FROM nodes WHERE lower(name) = lower(?)';
      const params: (string | number)[] = [name];
      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }
      sql += ' LIMIT 100';
      const rows = this.db.prepare(sql).all(...params) as { file_path: string }[];
      nameToFiles.set(name.toLowerCase(), new Set(rows.map(r => r.file_path)));
    }

    // Distinctive names are those with fewer than 10 file matches (e.g., "scrapeLoop" = 1 file)
    const distinctiveFiles = new Set<string>();
    for (const [, files] of nameToFiles) {
      if (files.size > 0 && files.size < 10) {
        for (const f of files) distinctiveFiles.add(f);
      }
    }

    // Pass 2: Query each name with per-name limit, scoring by co-location
    const perNameLimit = Math.max(8, Math.ceil(limit / names.length));
    const allResults: SearchResult[] = [];
    const seenIds = new Set<string>();

    for (const name of names) {
      let sql = `
        SELECT nodes.*, 1.0 as score
        FROM nodes
        WHERE lower(name) = lower(?)
      `;
      const params: (string | number)[] = [name];

      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }

      if (languages && languages.length > 0) {
        sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
        params.push(...languages);
      }

      // Fetch enough to find co-located results among common names
      sql += ' LIMIT ?';
      params.push(Math.max(perNameLimit * 3, 50));

      const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
      const nameResults: SearchResult[] = [];
      for (const row of rows) {
        const node = rowToNode(row);
        if (seenIds.has(node.id)) continue;
        // Boost results in files that also contain distinctive symbols
        const coLocationBoost = distinctiveFiles.has(node.filePath) ? 20 : 0;
        nameResults.push({ node, score: row.score + coLocationBoost });
      }

      // Sort by score (co-located first), take per-name limit
      nameResults.sort((a, b) => b.score - a.score);
      for (const r of nameResults.slice(0, perNameLimit)) {
        seenIds.add(r.node.id);
        allResults.push(r);
      }
    }

    // Sort all results by score so co-located results bubble up
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, limit);
  }

  /**
   * Find nodes whose name contains a substring (LIKE-based).
   * Useful for CamelCase-part matching where FTS fails because
   * e.g. "TransportSearchAction" is one FTS token, not matchable by "Search"*.
   *
   * Results are ordered by name length (shorter = more likely to be the core type).
   */
  findNodesByNameSubstring(
    substring: string,
    options: SearchOptions & { excludePrefix?: boolean } = {}
  ): SearchResult[] {
    const { kinds, languages, limit = 30, excludePrefix } = options;

    let sql = `
      SELECT nodes.*, 1.0 as score
      FROM nodes
      WHERE name LIKE ?
    `;
    const params: (string | number)[] = [`%${substring}%`];

    // Exclude prefix matches (handled by FTS-based prefix search in Step 2b)
    if (excludePrefix) {
      sql += ` AND name NOT LIKE ?`;
      params.push(`${substring}%`);
    }

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY length(name) ASC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
    return rows.map((row) => ({
      node: rowToNode(row),
      score: row.score,
    }));
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  /**
   * Insert a new edge
   */
  insertEdge(edge: Edge): void {
    if (!this.stmts.insertEdge) {
      this.stmts.insertEdge = this.db.prepare(`
        INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance)
        VALUES (@source, @target, @kind, @metadata, @line, @col, @provenance)
      `);
    }

    this.stmts.insertEdge.run({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
      line: edge.line ?? null,
      col: edge.column ?? null,
      provenance: edge.provenance ?? null,
    });
  }

  /**
   * Insert multiple edges in a transaction
   */
  insertEdges(edges: Edge[]): void {
    if (edges.length === 0) return;

    this.db.transaction(() => {
      const endpointIds = new Set<string>();
      for (const edge of edges) {
        endpointIds.add(edge.source);
        endpointIds.add(edge.target);
      }
      const existingNodeIds = this.getExistingNodeIds([...endpointIds]);

      const rows: unknown[][] = [];
      for (const edge of edges) {
        if (!existingNodeIds.has(edge.source) || !existingNodeIds.has(edge.target)) {
          continue;
        }
        rows.push([
          edge.source,
          edge.target,
          edge.kind,
          edge.metadata ? JSON.stringify(edge.metadata) : null,
          edge.line ?? null,
          edge.column ?? null,
          edge.provenance ?? null,
        ]);
      }
      this.runBatched(
        'insertEdges',
        'INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance) VALUES ',
        '(?,?,?,?,?,?,?)',
        rows
      );
    })();
  }

  /**
   * Delete all edges from a source node
   */
  deleteEdgesBySource(sourceId: string): void {
    if (!this.stmts.deleteEdgesBySource) {
      this.stmts.deleteEdgesBySource = this.db.prepare('DELETE FROM edges WHERE source = ?');
    }
    this.stmts.deleteEdgesBySource.run(sourceId);
  }

  /**
   * Get outgoing edges from a node
   */
  getOutgoingEdges(sourceId: string, kinds?: EdgeKind[], provenance?: string): Edge[] {
    if ((kinds && kinds.length > 0) || provenance) {
      let sql = 'SELECT * FROM edges WHERE source = ?';
      const params: (string | number)[] = [sourceId];

      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }

      if (provenance) {
        sql += ' AND provenance = ?';
        params.push(provenance);
      }

      const rows = this.db.prepare(sql).all(...params) as EdgeRow[];
      return rows.map(rowToEdge);
    }

    if (!this.stmts.getEdgesBySource) {
      this.stmts.getEdgesBySource = this.db.prepare('SELECT * FROM edges WHERE source = ?');
    }
    const rows = this.stmts.getEdgesBySource.all(sourceId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * Get incoming edges to a node
   */
  getIncomingEdges(targetId: string, kinds?: EdgeKind[]): Edge[] {
    if (kinds && kinds.length > 0) {
      const sql = `SELECT * FROM edges WHERE target = ? AND kind IN (${kinds.map(() => '?').join(',')})`;
      const rows = this.db.prepare(sql).all(targetId, ...kinds) as EdgeRow[];
      return rows.map(rowToEdge);
    }

    if (!this.stmts.getEdgesByTarget) {
      this.stmts.getEdgesByTarget = this.db.prepare('SELECT * FROM edges WHERE target = ?');
    }
    const rows = this.stmts.getEdgesByTarget.all(targetId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * Find all edges where both source and target are in the given node set.
   * Useful for recovering inter-node connectivity after BFS.
   */
  findEdgesBetweenNodes(nodeIds: string[], kinds?: EdgeKind[]): Edge[] {
    if (nodeIds.length === 0) return [];

    const idsJson = JSON.stringify(nodeIds);
    let sql = `SELECT * FROM edges WHERE source IN (SELECT value FROM json_each(?)) AND target IN (SELECT value FROM json_each(?))`;
    const params: string[] = [idsJson, idsJson];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    const rows = this.db.prepare(sql).all(...params) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * Distinct file paths that DEPEND ON `filePath`: every file containing a
   * symbol with a cross-file edge (any kind except `contains`) into a symbol
   * of this file. This is the file-level projection of the symbol dependency
   * graph and the basis for blast-radius / `affected` test selection.
   *
   * It deliberately does NOT restrict to `imports` edges. In this graph an
   * `imports` edge connects a file to its own local import declarations
   * (it is always same-file), so an imports-only lookup returns zero
   * cross-file dependents for every file. The real cross-file dependency
   * signal is the resolved call/reference graph — calls, references,
   * instantiates, extends, implements, overrides, type_of, returns,
   * decorates — exactly what {@link GraphTraverser.getImpactRadius} traverses.
   * `contains` is excluded: a parent containing a symbol does not *depend* on
   * it. One indexed query (idx_nodes_file_path + idx_edges_target_kind).
   */
  getDependentFilePaths(filePath: string): string[] {
    const sql = `SELECT DISTINCT src.file_path AS fp
      FROM edges e
      JOIN nodes tgt ON tgt.id = e.target
      JOIN nodes src ON src.id = e.source
      WHERE tgt.file_path = ?
        AND e.kind != 'contains'
        AND src.file_path != ?`;
    const rows = this.db.prepare(sql).all(filePath, filePath) as Array<{ fp: string }>;
    return rows.map((r) => r.fp);
  }

  /**
   * Distinct file paths that `filePath` DEPENDS ON — the inverse of
   * {@link getDependentFilePaths}: every file containing a symbol that a
   * symbol of this file has a cross-file edge into. Same edge-kind rules
   * (all kinds except `contains`); same reason imports-only is insufficient.
   */
  getDependencyFilePaths(filePath: string): string[] {
    const sql = `SELECT DISTINCT tgt.file_path AS fp
      FROM edges e
      JOIN nodes src ON src.id = e.source
      JOIN nodes tgt ON tgt.id = e.target
      WHERE src.file_path = ?
        AND e.kind != 'contains'
        AND tgt.file_path != ?`;
    const rows = this.db.prepare(sql).all(filePath, filePath) as Array<{ fp: string }>;
    return rows.map((r) => r.fp);
  }

  /**
   * @brief 快照跨文件入向边及目标源码身份，供删除后安全重绑或恢复原始引用。
   * @param[in] filePath 将要重索引或删除的目标文件相对路径
   * @return 不含 contains 的跨文件入向边、目标身份和原源文件信息
   * @note 同行独立定义标记必须在删除前保存；重索引后某个成员可能已消失。
   */
  getCrossFileIncomingEdgesWithTarget(
    filePath: string
  ): Array<Edge & {
    targetName: string; targetKind: NodeKind; sourceFilePath: string; sourceLanguage: Language;
    targetIdentity: Pick<Node, 'filePath' | 'language' | 'kind' | 'name' | 'qualifiedName' | 'signature' |
      'startLine' | 'startColumn' | 'endLine' | 'endColumn'>;
    targetIsDisambiguated: boolean;
    targetSameLinePeerCount: number;
  }> {
    const sql = `SELECT e.*, tgt.name AS target_name, tgt.kind AS target_kind,
        tgt.file_path AS target_file_path, tgt.language AS target_language,
        tgt.qualified_name AS target_qualified_name, tgt.signature AS target_signature,
        tgt.start_line AS target_start_line, tgt.start_column AS target_start_column,
        tgt.end_line AS target_end_line, tgt.end_column AS target_end_column,
        (SELECT COUNT(*) FROM nodes peer
          WHERE tgt.language IN ('c', 'cpp') AND tgt.kind IN ('function', 'method')
            AND peer.file_path = tgt.file_path AND peer.kind = tgt.kind AND peer.name = tgt.name
            AND peer.start_line = tgt.start_line AND peer.id != tgt.id
            AND ((peer.end_line = tgt.start_line AND peer.end_column <= tgt.start_column)
              OR (tgt.end_line = peer.start_line AND tgt.end_column <= peer.start_column))
        ) AS target_same_line_peer_count,
        src.file_path AS source_file_path, src.language AS source_language
      FROM edges e
      JOIN nodes tgt ON tgt.id = e.target
      JOIN nodes src ON src.id = e.source
      WHERE tgt.file_path = ?
        AND e.kind != 'contains'
        AND src.file_path != ?`;
    const rows = this.db.prepare(sql).all(filePath, filePath) as Array<
      EdgeRow & {
        target_name: string; target_kind: NodeKind; source_file_path: string; source_language: Language;
        target_file_path: string; target_language: Language; target_qualified_name: string; target_signature: string | null;
        target_start_line: number; target_start_column: number; target_end_line: number; target_end_column: number;
        target_same_line_peer_count: number;
      }
    >;
    return rows.map(row => {
      const targetIdentity = {
        filePath: row.target_file_path, language: row.target_language, kind: row.target_kind, name: row.target_name,
        qualifiedName: row.target_qualified_name, signature: row.target_signature ?? undefined,
        startLine: row.target_start_line, startColumn: row.target_start_column,
        endLine: row.target_end_line, endColumn: row.target_end_column,
      };
      return {
        ...rowToEdge(row),
        targetName: row.target_name,
        targetKind: row.target_kind,
        sourceFilePath: row.source_file_path,
        sourceLanguage: row.source_language,
        targetIdentity,
        targetSameLinePeerCount: row.target_same_line_peer_count,
        // 已独立存在的列号 ID 即使当前只剩一个成员，也不能退回同名猜测。
        targetIsDisambiguated: (row.target_language === 'c' || row.target_language === 'cpp') &&
          (row.target_kind === 'function' || row.target_kind === 'method') &&
          (row.target_same_line_peer_count !== 0 || row.target === semanticCollisionNodeId(targetIdentity)),
      };
    });
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Insert or update a file record
   */
  upsertFile(file: FileRecord): void {
    if (!this.stmts.upsertFile) {
      this.stmts.upsertFile = this.db.prepare(`
        INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors, generated)
        VALUES (@path, @contentHash, @language, @size, @modifiedAt, @indexedAt, @nodeCount, @errors, @generated)
        ON CONFLICT(path) DO UPDATE SET
          content_hash = @contentHash,
          language = @language,
          size = @size,
          modified_at = @modifiedAt,
          indexed_at = @indexedAt,
          node_count = @nodeCount,
          errors = @errors,
          generated = @generated
      `);
    }

    this.stmts.upsertFile.run({
      path: file.path,
      contentHash: file.contentHash,
      language: file.language,
      size: file.size,
      modifiedAt: file.modifiedAt,
      indexedAt: file.indexedAt,
      nodeCount: file.nodeCount,
      errors: file.errors ? JSON.stringify(file.errors) : null,
      // The upsert always REWRITES the flag: a file that loses its banner in an
      // edit must lose the flag on the next sync, not keep a stale 1.
      generated: file.generated ? 1 : 0,
    });
  }

  /**
   * Which of `filePaths` the index flagged as tool-generated (schema v9+).
   *
   * Bounded-lookup by design: every consumer already holds a short candidate
   * list (a ranked file group, an FTS result page, a LIMIT-20 aggregate), so
   * this stays a partial-index probe over a handful of paths — no whole-repo
   * set to materialize, and no cache to invalidate, which means a ranking call
   * can never serve a verdict the last sync already replaced.
   *
   * Returns ONLY the content/index signal; callers union it with
   * {@link isGeneratedFile} so pre-v9 databases (column present, all zeros
   * until a re-index) keep the path-only behavior rather than regressing.
   */
  getGeneratedPathsAmong(filePaths: Iterable<string>): Set<string> {
    const unique = [...new Set(filePaths)];
    const found = new Set<string>();
    if (unique.length === 0) return found;

    for (let i = 0; i < unique.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = unique.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT path FROM files WHERE generated = 1 AND path IN (${placeholders})`)
        .all(...chunk) as Array<{ path: string }>;
      for (const row of rows) found.add(row.path);
    }
    return found;
  }

  /**
   * A reusable `(path) => boolean` over a bounded candidate list, unioning the
   * indexed flag with the path convention. This is the shape every ranking
   * comparator wants: one query up front, then O(1) per comparison.
   */
  generatedPredicateFor(filePaths: Iterable<string>): (filePath: string) => boolean {
    const flagged = this.getGeneratedPathsAmong(filePaths);
    return (filePath: string) => flagged.has(filePath) || isGeneratedFile(filePath);
  }

  /**
   * Which of `filePaths` are AMBIENT DECLARATION files — they declare nothing
   * but types, and nothing in the index depends on them (CG-28). A hand-written
   * ambient `.d.ts` of global shims, a vendored typings file, module
   * augmentation: reachable only by name, structurally attached to nothing.
   *
   * Structural, not extension-based, so a hand-written `types.ts` and a `.d.ts`
   * are judged by the same rule and a `.d.ts` that does declare a class or a
   * const is (correctly) not caught. Four conditions, all required:
   *
   *   1. it declares at least one symbol — an empty or unparsed file is not a
   *      declaration file, it is a file we know nothing about;
   *   2. EVERY declared symbol is a type-level kind (interface / type alias /
   *      enum / namespace). The narrowness is deliberate and measured: a rule
   *      of "no callables" alone flags 1–18% of a repo, including Kotlin sealed
   *      classes, Rust `mod.rs` re-exports and django's locale constant tables —
   *      real source that must not be demoted. This rule flags 0–4%;
   *   3. no symbol in it originates a `calls`/`instantiates` edge — the direct
   *      evidence that nothing here has a body;
   *   4. NOTHING ELSE IN THE INDEX points at it. This is the condition that
   *      separates an ambient shim from a working type module, and it is why
   *      the flag is narrow enough to be safe: `displacement-ts`'s pipeline
   *      `types.ts` passes 1–3 identically but carries 13 inbound imports and
   *      21 references, so the files that answer a query about the pipeline are
   *      typed BY it — it is part of that answer's structure. An ambient
   *      `declare global` shim has zero. Deliberately index-wide rather than
   *      restricted to the candidate list: the file that imports it is usually
   *      not itself a candidate.
   *
   * Bounded-lookup like {@link getGeneratedPathsAmong}: callers hold a ranked
   * candidate list, so this is a partial-index probe over a handful of paths.
   */
  getAmbientDeclarationPathsAmong(filePaths: Iterable<string>): Set<string> {
    const unique = [...new Set(filePaths)];
    const found = new Set<string>();
    if (unique.length === 0) return found;

    for (let i = 0; i < unique.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = unique.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      // `file`/`import`/`export`/`parameter` are structural bookkeeping, not
      // things the file declares, so they neither qualify nor disqualify.
      const rows = this.db
        .prepare(`
          SELECT file_path,
                 SUM(CASE WHEN kind NOT IN ('file','import','export','parameter')
                          THEN 1 ELSE 0 END) AS declared,
                 SUM(CASE WHEN kind IN ('interface','type_alias','enum','enum_member','namespace')
                          THEN 1 ELSE 0 END) AS typeDeclared
          FROM nodes
          WHERE file_path IN (${placeholders})
          GROUP BY file_path
        `)
        .all(...chunk) as Array<{ file_path: string; declared: number; typeDeclared: number }>;
      let candidates = rows
        .filter((r) => r.declared > 0 && r.declared === r.typeDeclared)
        .map((r) => r.file_path);
      if (candidates.length === 0) continue;

      const disqualify = (sql: string): void => {
        if (candidates.length === 0) return;
        const hit = new Set(
          (this.db
            .prepare(sql.replace('$IN$', candidates.map(() => '?').join(',')))
            .all(...candidates) as Array<{ file_path: string }>).map((r) => r.file_path),
        );
        candidates = candidates.filter((p) => !hit.has(p));
      };
      // (3) originates behaviour
      disqualify(`
        SELECT DISTINCT n.file_path AS file_path
        FROM edges e JOIN nodes n ON n.id = e.source
        WHERE e.kind IN ('calls','instantiates') AND n.file_path IN ($IN$)
      `);
      // (4) something outside the file depends on it
      disqualify(`
        SELECT DISTINCT t.file_path AS file_path
        FROM edges e JOIN nodes t ON t.id = e.target JOIN nodes s ON s.id = e.source
        WHERE t.file_path IN ($IN$) AND s.file_path <> t.file_path
      `);
      for (const path of candidates) found.add(path);
    }
    return found;
  }

  /**
   * A reusable `(path) => boolean` ambient-declaration test over a bounded
   * candidate list — the shape a ranking comparator wants: one query up front,
   * O(1) per comparison.
   */
  ambientDeclarationPredicateFor(filePaths: Iterable<string>): (filePath: string) => boolean {
    const flagged = this.getAmbientDeclarationPathsAmong(filePaths);
    return (filePath: string) => flagged.has(filePath);
  }

  /** How many indexed files carry the generated flag. Surfaced by `status`. */
  countGeneratedFiles(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM files WHERE generated = 1')
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Delete a file record and its nodes
   */
  deleteFile(filePath: string): void {
    this.db.transaction(() => {
      this.deleteNodesByFile(filePath);
      if (!this.stmts.deleteFile) {
        this.stmts.deleteFile = this.db.prepare('DELETE FROM files WHERE path = ?');
      }
      this.stmts.deleteFile.run(filePath);
    })();
  }

  /**
   * Get a file record by path
   */
  getFileByPath(filePath: string): FileRecord | null {
    if (!this.stmts.getFileByPath) {
      this.stmts.getFileByPath = this.db.prepare('SELECT * FROM files WHERE path = ?');
    }
    const row = this.stmts.getFileByPath.get(filePath) as FileRow | undefined;
    return row ? rowToFileRecord(row) : null;
  }

  /**
   * Get all tracked files
   */
  getAllFiles(): FileRecord[] {
    if (!this.stmts.getAllFiles) {
      this.stmts.getAllFiles = this.db.prepare('SELECT * FROM files ORDER BY path');
    }
    const rows = this.stmts.getAllFiles.all() as FileRow[];
    return rows.map(rowToFileRecord);
  }

  /**
   * Most recent index timestamp (ms since epoch) across all tracked files, or
   * null when nothing is indexed yet. One indexed aggregate, no per-row scan. (#329)
   */
  getLastIndexedAt(): number | null {
    const row = this.db
      .prepare('SELECT MAX(indexed_at) AS last FROM files')
      .get() as { last: number | null } | undefined;
    return row?.last ?? null;
  }

  /**
   * Get files that need re-indexing (hash changed)
   */
  getStaleFiles(currentHashes: Map<string, string>): FileRecord[] {
    const files = this.getAllFiles();
    return files.filter((f) => {
      const currentHash = currentHashes.get(f.path);
      return currentHash && currentHash !== f.contentHash;
    });
  }

  // ===========================================================================
  // Unresolved References
  // ===========================================================================

  /**
   * Insert an unresolved reference
   */
  insertUnresolvedRef(ref: UnresolvedReference): void {
    if (!this.stmts.insertUnresolved) {
      this.stmts.insertUnresolved = this.db.prepare(`
        INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language)
        VALUES (@fromNodeId, @referenceName, @referenceKind, @line, @col, @candidates, @filePath, @language)
      `);
    }

    this.stmts.insertUnresolved.run({
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      col: ref.column,
      candidates: ref.candidates ? JSON.stringify(ref.candidates) : null,
      filePath: ref.filePath ?? '',
      language: ref.language ?? 'unknown',
    });
  }

  /**
   * Insert multiple unresolved references in a transaction
   */
  insertUnresolvedRefsBatch(refs: UnresolvedReference[]): void {
    if (refs.length === 0) return;
    const insert = this.db.transaction(() => {
      const rows: unknown[][] = [];
      for (const ref of refs) {
        rows.push([
          ref.fromNodeId,
          ref.referenceName,
          ref.referenceKind,
          ref.line,
          ref.column,
          ref.candidates ? JSON.stringify(ref.candidates) : null,
          ref.filePath ?? '',
          ref.language ?? 'unknown',
        ]);
      }
      this.runBatched(
        'insertUnresolvedRefs',
        'INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language) VALUES ',
        '(?,?,?,?,?,?,?,?)',
        rows
      );
    });
    insert();
  }

  /**
   * Delete unresolved references from a node
   */
  deleteUnresolvedByNode(nodeId: string): void {
    if (!this.stmts.deleteUnresolvedByNode) {
      this.stmts.deleteUnresolvedByNode = this.db.prepare(
        'DELETE FROM unresolved_refs WHERE from_node_id = ?'
      );
    }
    this.stmts.deleteUnresolvedByNode.run(nodeId);
  }

  /**
   * Get unresolved references by name (for resolution)
   */
  getUnresolvedByName(name: string): UnresolvedReference[] {
    if (!this.stmts.getUnresolvedByName) {
      this.stmts.getUnresolvedByName = this.db.prepare(
        'SELECT * FROM unresolved_refs WHERE reference_name = ?'
      );
    }
    const rows = this.stmts.getUnresolvedByName.all(name) as UnresolvedRefRow[];
    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
      rowId: row.id,
    }));
  }

  /**
   * Get all unresolved references
   */
  getUnresolvedReferences(): UnresolvedReference[] {
    const rows = this.db.prepare('SELECT * FROM unresolved_refs').all() as UnresolvedRefRow[];
    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
      rowId: row.id,
    }));
  }

  /**
   * Get the count of PENDING (never-attempted) references without loading
   * them into memory. Rows marked status='failed' — attempted by a completed
   * pass, no match — are excluded: they are not outstanding work, only retry
   * candidates for the #1240 sweep, so they must not trip the #1187 orphan
   * sweep or the `status` pending-refs warning.
   */
  getUnresolvedReferencesCount(): number {
    if (!this.stmts.getUnresolvedCount) {
      this.stmts.getUnresolvedCount = this.db.prepare(
        "SELECT COUNT(*) as count FROM unresolved_refs WHERE status = 'pending'"
      );
    }
    const row = this.stmts.getUnresolvedCount.get() as { count: number };
    return row.count;
  }

  /**
   * Get a batch of PENDING unresolved references using LIMIT/OFFSET
   * pagination. Used to process references in bounded memory chunks; failed
   * rows are excluded so the batched drain loop terminates once every row
   * has been attempted.
   */
  getUnresolvedReferencesBatch(offset: number, limit: number): UnresolvedReference[] {
    if (!this.stmts.getUnresolvedBatch) {
      // ORDER BY rowid is load-bearing for the pipelined resolution loop: it
      // prefetches batch k+1 at OFFSET batch_k.length while batch k's rows are
      // still pending, which is only exact under a stable enumeration. (A plain
      // scan and the status index both return rowid order anyway — this pins
      // it.)
      this.stmts.getUnresolvedBatch = this.db.prepare(
        "SELECT * FROM unresolved_refs WHERE status = 'pending' ORDER BY rowid LIMIT ? OFFSET ?"
      );
    }
    const rows = this.stmts.getUnresolvedBatch.all(limit, offset) as UnresolvedRefRow[];
    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
      rowId: row.id,
    }));
  }

  /**
   * Keyset variant of {@link getUnresolvedReferencesBatch} for the batched
   * resolution loop: seek past the last-seen row id instead of OFFSET-walking.
   * OFFSET reads re-scan the accumulated failed-row prefix on every batch —
   * O(failed rows) per read, measured at 54.6s of the kernel-scale batch loop
   * (§7a.2) — while the seek is O(batch) forever. `id` is the rowid alias, so
   * the enumeration order is identical to the OFFSET reader's.
   */
  getUnresolvedReferencesBatchAfter(afterRowId: number, limit: number): UnresolvedReference[] {
    if (!this.stmts.getUnresolvedBatchAfter) {
      this.stmts.getUnresolvedBatchAfter = this.db.prepare(
        "SELECT * FROM unresolved_refs WHERE status = 'pending' AND id > ? ORDER BY id LIMIT ?"
      );
    }
    const rows = this.stmts.getUnresolvedBatchAfter.all(afterRowId, limit) as UnresolvedRefRow[];
    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
      rowId: row.id,
    }));
  }

  /**
   * Get all tracked file paths (lightweight — no full FileRecord objects)
   */
  getAllFilePaths(): string[] {
    if (!this.stmts.getAllFilePaths) {
      this.stmts.getAllFilePaths = this.db.prepare('SELECT path FROM files ORDER BY path');
    }
    const rows = this.stmts.getAllFilePaths.all() as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  /**
   * Get all distinct node names (lightweight — just name strings for pre-filtering)
   */
  getAllNodeNames(): string[] {
    if (!this.stmts.getAllNodeNames) {
      this.stmts.getAllNodeNames = this.db.prepare('SELECT DISTINCT name FROM nodes');
    }
    const rows = this.stmts.getAllNodeNames.all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  /**
   * Stream the distinct node names one row at a time — the incremental
   * counterpart to {@link getAllNodeNames} for callers that need to yield
   * to the event loop mid-scan (resolver cache warm-up on multi-million-node
   * indexes). Fresh statement per call: the iterator holds an open cursor.
   */
  *iterateNodeNames(): IterableIterator<string> {
    const stmt = this.db.prepare('SELECT DISTINCT name FROM nodes');
    for (const row of stmt.iterate()) {
      yield (row as { name: string }).name;
    }
  }

  /**
   * Get unresolved references scoped to specific file paths.
   * Uses the idx_unresolved_file_path index for efficient lookup.
   */
  getUnresolvedReferencesByFiles(filePaths: string[]): UnresolvedReference[] {
    if (filePaths.length === 0) return [];

    // Chunk under SQLite's parameter limit: the first sync of a very large repo
    // passes every changed file here, which an unbounded `IN (...)` would bind
    // as one parameter each — exceeding MAX_VARIABLE_NUMBER and aborting with
    // "too many SQL variables". (#540)
    const rows: UnresolvedRefRow[] = [];
    for (let i = 0; i < filePaths.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const chunkRows = this.db
        .prepare(`SELECT * FROM unresolved_refs WHERE status = 'pending' AND file_path IN (${placeholders})`)
        .all(...chunk) as UnresolvedRefRow[];
      // Append with a loop, never a spread: the INPUT chunk is bounded, but
      // the RESULT rows per chunk are not — a dense recovery sync (e.g. the
      // #1541 self-heal re-indexing hundreds of files) returns more rows than
      // V8 allows as arguments, and `push(...chunkRows)` dies with "Maximum
      // call stack size exceeded", aborting resolution mid-sync (#1558).
      for (const row of chunkRows) rows.push(row);
    }

    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
      rowId: row.id,
    }));
  }

  /**
   * Delete all unresolved references (after resolution)
   */
  clearUnresolvedReferences(): void {
    this.db.exec('DELETE FROM unresolved_refs');
  }

  /**
   * Delete resolved references by their IDs
   */
  deleteResolvedReferences(fromNodeIds: string[]): void {
    if (fromNodeIds.length === 0) return;
    // Chunk under SQLite's parameter limit, matching every other IN-list in
    // this file. The internal resolution path uses deleteSpecificResolvedReferences
    // instead, but QueryBuilder is part of the public API, so a library consumer
    // passing more ids than SQLITE_MAX_VARIABLE_NUMBER (32766 on the bundled
    // node:sqlite) would otherwise hit "too many SQL variables". (#540, #1001)
    for (let i = 0; i < fromNodeIds.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = fromNodeIds.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM unresolved_refs WHERE from_node_id IN (${placeholders})`).run(...chunk);
    }
  }

  /**
   * Delete specific resolved references by (fromNodeId, referenceName, referenceKind) tuples.
   * More precise than deleteResolvedReferences — only removes refs that were actually resolved.
   */
  deleteSpecificResolvedReferences(refs: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }>): number {
    if (refs.length === 0) return 0;
    const stmt = this.db.prepare(
      'DELETE FROM unresolved_refs WHERE from_node_id = ? AND reference_name = ? AND reference_kind = ?'
    );
    // Returns rows actually removed (SQLite `changes`, summed): the batched
    // resolution loop's non-progress guard keys on this — zero removals from
    // a batch that claimed work is the direct runaway signal (§7a.2).
    let changed = 0;
    const deleteMany = this.db.transaction((items: typeof refs) => {
      for (const ref of items) {
        changed += stmt.run(ref.fromNodeId, ref.referenceName, ref.referenceKind).changes;
      }
    });
    deleteMany(refs);
    return changed;
  }

  /**
   * Delete unresolved-ref rows by row id — the precise cleanup for refs a
   * resolution pass actually processed. The key-tuple variant above also
   * deletes SIBLING rows (same caller calling the same callee at other lines)
   * that a later batch hasn't attempted yet, so when a batch boundary split a
   * caller's same-named call sites, the later sites' edges were silently never
   * created (#1269).
   */
  deleteReferencesByRowIds(rowIds: number[]): number {
    if (rowIds.length === 0) return 0;
    // One transaction for all chunks (each chunk was previously its own
    // implicit transaction = its own WAL commit — measurable on 100k+-ref
    // resolution persists), and the full-size chunk statement is cached so
    // repeat calls skip the re-prepare; only the final partial chunk (if any)
    // prepares ad hoc. Returns rows actually removed (summed `changes`) for
    // the batched loop's non-progress guard (§7a.2).
    let changed = 0;
    this.db.transaction(() => {
      for (let i = 0; i < rowIds.length; i += SQLITE_PARAM_CHUNK_SIZE) {
        const chunk = rowIds.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
        if (chunk.length === SQLITE_PARAM_CHUNK_SIZE) {
          if (!this.stmts.deleteRefsByRowIdsFull) {
            const placeholders = new Array(SQLITE_PARAM_CHUNK_SIZE).fill('?').join(',');
            this.stmts.deleteRefsByRowIdsFull = this.db.prepare(
              `DELETE FROM unresolved_refs WHERE id IN (${placeholders})`
            );
          }
          changed += this.stmts.deleteRefsByRowIdsFull.run(...chunk).changes;
        } else {
          const placeholders = chunk.map(() => '?').join(',');
          changed += this.db.prepare(`DELETE FROM unresolved_refs WHERE id IN (${placeholders})`).run(...chunk).changes;
        }
      }
    })();
    return changed;
  }

  /**
   * Mark refs a completed resolution pass could not resolve as status='failed'
   * instead of deleting them (#1240). Failed rows are invisible to the pending
   * count/batch readers (so drain loops and the #1187 orphan sweep still
   * terminate) but stay queryable by name_tail so a later sync can retry them
   * when a changed file introduces a symbol that could satisfy them. name_tail
   * is (re)written here so rows inserted before the v8 migration get their
   * tail the first time they're attempted.
   */
  markReferencesFailed(refs: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }>): number {
    if (refs.length === 0) return 0;
    const stmt = this.db.prepare(
      "UPDATE unresolved_refs SET status = 'failed', name_tail = ? WHERE from_node_id = ? AND reference_name = ? AND reference_kind = ?"
    );
    let changed = 0;
    const markMany = this.db.transaction((items: typeof refs) => {
      for (const ref of items) {
        changed += stmt.run(referenceNameTail(ref.referenceName), ref.fromNodeId, ref.referenceName, ref.referenceKind).changes;
      }
    });
    markMany(refs);
    return changed;
  }

  /**
   * Park refs as status='failed' by row id — the precise counterpart of
   * markReferencesFailed, for the same reason as deleteReferencesByRowIds:
   * the key-tuple variant also flips same-key sibling rows in later batches
   * to 'failed' before they were ever attempted (#1269). Resolution outcome
   * can differ per call site (receiver-type inference reads the ref's line),
   * so a sibling must not inherit this row's failure.
   */
  markReferencesFailedByRowIds(refs: Array<{ rowId: number; referenceName: string }>): number {
    if (refs.length === 0) return 0;
    const stmt = this.db.prepare(
      "UPDATE unresolved_refs SET status = 'failed', name_tail = ? WHERE id = ?"
    );
    let changed = 0;
    const markMany = this.db.transaction((items: typeof refs) => {
      for (const ref of items) {
        changed += stmt.run(referenceNameTail(ref.referenceName), ref.rowId).changes;
      }
    });
    markMany(refs);
    return changed;
  }

  /**
   * Failed refs whose name tail matches one of the given symbol names — the
   * candidates a sync should retry after files carrying those names changed
   * (#1240). Names matching more than `perNameCeiling` failed refs are
   * skipped entirely: at that population a name is external/builtin noise
   * (`get`, `map`, …) that one new definition won't resolve — the same
   * rationale as resolution's AMBIGUOUS_NAME_CEILING (#999) — and retrying an
   * arbitrary subset would be both wasted work and incoherent coverage.
   */
  getRetryableFailedReferences(names: string[], perNameCeiling: number = 500): UnresolvedReference[] {
    if (names.length === 0) return [];

    // Pass 1: per-tail counts, chunked under the SQLite parameter limit.
    const retryNames: string[] = [];
    for (let i = 0; i < names.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = names.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const counts = this.db
        .prepare(
          `SELECT name_tail, COUNT(*) as count FROM unresolved_refs WHERE status = 'failed' AND name_tail IN (${placeholders}) GROUP BY name_tail`
        )
        .all(...chunk) as Array<{ name_tail: string; count: number }>;
      for (const row of counts) {
        if (row.count <= perNameCeiling) retryNames.push(row.name_tail);
      }
    }
    if (retryNames.length === 0) return [];

    // Pass 2: load the surviving rows.
    const rows: UnresolvedRefRow[] = [];
    for (let i = 0; i < retryNames.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = retryNames.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const chunkRows = this.db
        .prepare(`SELECT * FROM unresolved_refs WHERE status = 'failed' AND name_tail IN (${placeholders})`)
        .all(...chunk) as UnresolvedRefRow[];
      // Loop, not spread — same V8 argument-limit hazard as
      // getUnresolvedReferencesByFiles (#1558): a large definition delta can
      // select an unbounded number of failed rows per chunk.
      for (const row of chunkRows) rows.push(row);
    }

    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
      rowId: row.id,
    }));
  }

  /**
   * Resolution edges whose TARGET symbol is named one of `names` — the edges a
   * sync must re-resolve after `names` gained or lost a definition (CG-33).
   *
   * Resolution binds a reference to a node whose name matches the reference's
   * tail, and it picks among ALL same-named definitions project-wide. So adding
   * or removing one definition of `pct` changes the answer for every `pct(...)`
   * reference in the repo — including references in files this sync never
   * touches, whose edges nothing else revisits. Those edges' current target is,
   * by that same rule, a node named `pct`, which is why the target's name is a
   * sufficient (and index-backed, via idx_nodes_name) way to find them without
   * a schema change or a scan of edge metadata.
   *
   * Returns the source file/language alongside each edge so the caller can
   * resurrect it as its original reference. Excludes `provenance='heuristic'`
   * (synthesized dispatch edges are not resolution output and carry no refName
   * stamp to resurrect from — deleting one would be a permanent loss).
   *
   * Names matching more than `perNameCeiling` edges are skipped entirely, same
   * rationale and same default as {@link getRetryableFailedReferences}: at that
   * population the name is generic (`get`, `clear`, …), one definition changing
   * won't flip most of them, and rebinding an arbitrary subset is both wasted
   * work and incoherent coverage.
   */
  getResolutionEdgesByTargetName(
    names: string[],
    perNameCeiling: number = 500
  ): Array<Edge & { edgeId: number; sourceFilePath: string; sourceLanguage: Language }> {
    if (names.length === 0) return [];

    // Pass 1: per-name edge counts, chunked under the SQLite parameter limit.
    const keep: string[] = [];
    for (let i = 0; i < names.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = names.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const counts = this.db
        .prepare(
          `SELECT tgt.name AS name, COUNT(*) AS count
             FROM edges e
             JOIN nodes tgt ON tgt.id = e.target
            WHERE tgt.name IN (${placeholders})
              AND (e.provenance IS NULL OR e.provenance != 'heuristic')
            GROUP BY tgt.name`
        )
        .all(...chunk) as Array<{ name: string; count: number }>;
      for (const row of counts) {
        if (row.count <= perNameCeiling) keep.push(row.name);
      }
    }
    if (keep.length === 0) return [];

    // Pass 2: load the surviving edges with the source file context a
    // resurrection needs.
    const out: Array<Edge & { edgeId: number; sourceFilePath: string; sourceLanguage: Language }> = [];
    for (let i = 0; i < keep.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = keep.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT e.*, src.file_path AS source_file_path, src.language AS source_language
             FROM edges e
             JOIN nodes tgt ON tgt.id = e.target
             JOIN nodes src ON src.id = e.source
            WHERE tgt.name IN (${placeholders})
              AND (e.provenance IS NULL OR e.provenance != 'heuristic')`
        )
        .all(...chunk) as Array<EdgeRow & { source_file_path: string; source_language: Language }>;
      for (const row of rows) {
        out.push({
          ...rowToEdge(row),
          edgeId: row.id,
          sourceFilePath: row.source_file_path,
          sourceLanguage: row.source_language,
        });
      }
    }
    return out;
  }

  /** Delete edges by primary key — the rebind pass's half of a re-resolution. */
  deleteEdgesByIds(edgeIds: number[]): number {
    if (edgeIds.length === 0) return 0;
    let changed = 0;
    this.db.transaction(() => {
      for (let i = 0; i < edgeIds.length; i += SQLITE_PARAM_CHUNK_SIZE) {
        const chunk = edgeIds.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');
        changed += this.db.prepare(`DELETE FROM edges WHERE id IN (${placeholders})`).run(...chunk).changes;
      }
    })();
    return changed;
  }

  /**
   * Distinct node names present in the given files — the symbol names a sync
   * pass uses to look up retryable failed refs after those files changed.
   */
  getNodeNamesByFiles(filePaths: string[]): string[] {
    if (filePaths.length === 0) return [];
    const names = new Set<string>();
    for (let i = 0; i < filePaths.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT DISTINCT name FROM nodes WHERE file_path IN (${placeholders})`)
        .all(...chunk) as Array<{ name: string }>;
      for (const row of rows) names.add(row.name);
    }
    return [...names];
  }

  /**
   * Distinct `file\0name` pairs defined by the given files — the shape sync's
   * definition delta needs (CG-33).
   *
   * Deliberately NOT `getNodeNamesByFiles`: a bare name set is taken over the
   * WHOLE changed batch, so a name that moves between two files in one commit
   * (or exists in one changed file and is newly added to another) appears on
   * both sides and cancels out of the symmetric difference — even though a
   * definition genuinely appeared or vanished and every reference to that name
   * repo-wide may now bind elsewhere. Keying by file makes each definition its
   * own fact, so the move is seen as one removal plus one addition.
   */
  getNodeNamePairsByFiles(filePaths: string[]): Set<string> {
    const pairs = new Set<string>();
    if (filePaths.length === 0) return pairs;
    for (let i = 0; i < filePaths.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT DISTINCT file_path, name FROM nodes WHERE file_path IN (${placeholders})`)
        .all(...chunk) as Array<{ file_path: string; name: string }>;
      // NUL-joined: a path or a symbol name can contain a space, never a NUL.
      for (const row of rows) pairs.add(`${row.file_path}\0${row.name}`);
    }
    return pairs;
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Lightweight (nodes, edges) count snapshot. Used around an index/sync
   * run to compute true additions across extraction + resolution +
   * synthesis — the per-phase counter in the orchestrator only sees
   * extraction's contribution, which is why the CLI summary under-reported
   * the edge count (resolution + synthesizer edges were invisible).
   */
  getNodeAndEdgeCount(): { nodes: number; edges: number } {
    return this.db
      .prepare('SELECT (SELECT COUNT(*) FROM nodes) AS nodes, (SELECT COUNT(*) FROM edges) AS edges')
      .get() as { nodes: number; edges: number };
  }

  /**
   * Get graph statistics
   */
  getStats(): GraphStats {
    // Single query for all three aggregate counts
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS node_count,
        (SELECT COUNT(*) FROM edges) AS edge_count,
        (SELECT COUNT(*) FROM files) AS file_count
    `).get() as { node_count: number; edge_count: number; file_count: number };

    const nodesByKind = {} as Record<NodeKind, number>;
    const nodeKindRows = this.db
      .prepare('SELECT kind, COUNT(*) as count FROM nodes GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    for (const row of nodeKindRows) {
      nodesByKind[row.kind as NodeKind] = row.count;
    }

    const edgesByKind = {} as Record<EdgeKind, number>;
    const edgeKindRows = this.db
      .prepare('SELECT kind, COUNT(*) as count FROM edges GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    for (const row of edgeKindRows) {
      edgesByKind[row.kind as EdgeKind] = row.count;
    }

    const filesByLanguage = {} as Record<Language, number>;
    const languageRows = this.db
      .prepare('SELECT language, COUNT(*) as count FROM files GROUP BY language')
      .all() as Array<{ language: string; count: number }>;
    for (const row of languageRows) {
      filesByLanguage[row.language as Language] = row.count;
    }

    return {
      nodeCount: counts.node_count,
      edgeCount: counts.edge_count,
      fileCount: counts.file_count,
      nodesByKind,
      edgesByKind,
      filesByLanguage,
      dbSizeBytes: 0, // Set by caller using DatabaseConnection.getSize()
      walSizeBytes: 0, // Set by caller using DatabaseConnection.getWalSizeBytes()
      lastUpdated: Date.now(),
    };
  }

  // ===========================================================================
  // Project Metadata
  // ===========================================================================

  /**
   * Get a metadata value by key
   */
  getMetadata(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM project_metadata WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Set a metadata key-value pair (upsert)
   */
  setMetadata(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(key, value, Date.now());
  }

  /**
   * Get all metadata as a key-value record
   */
  getAllMetadata(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM project_metadata').all() as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  /**
   * Clear all data from the database
   */
  clear(): void {
    this.nodeCache.clear();
    this.db.transaction(() => {
      this.db.exec('DELETE FROM unresolved_refs');
      this.db.exec('DELETE FROM edges');
      this.db.exec('DELETE FROM nodes');
      this.db.exec('DELETE FROM files');
    })();
  }
}
