/** @file C/C++ 语义节点归并、配置 provenance 和保守退役。 */
import * as fs from 'fs';
import * as path from 'path';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { SqliteDatabase } from '../../db/sqlite-adapter';
import { QueryBuilder } from '../../db/queries';
import { getParser, loadGrammarsForLanguages } from '../../extraction/grammars';
import { generateNodeId, semanticCollisionNodeId } from '../../extraction/tree-sitter-helpers';
import { Node } from '../../types';
import { isWithinProject } from './compile-database';
import { SemanticFactCollection } from './index';
import { SemanticSymbolFact, semanticRangesOverlap, assertPairwiseSemanticOverlap,
  StructuralTypedefContext } from './facts';

/**
 * @brief 从既有函数指针 typedef 节点恢复规范名称、条件源码范围，不推断生效分支。
 * @param[in] root 项目真实根目录
 * @param[in] queries 图读写接口；保留既有节点 ID 及关系
 * @return 可供真实 TU definition 引用核验的结构声明清单
 */
export async function reconcileCppStructuralTypedefs(root: string, queries: QueryBuilder):
  Promise<StructuralTypedefContext[]> {
  await loadGrammarsForLanguages(['c']);
  const parser = getParser('c');
  if (!parser) return [];
  const aliases = queries.getNodesByKind('type_alias').filter(node =>
    (node.language === 'c' || node.language === 'cpp') && /\.(?:h|hh|hpp|hxx)$/i.test(node.filePath));
  const contexts: StructuralTypedefContext[] = [];
  for (const file of new Set(aliases.map(node => node.filePath))) {
    let source: string;
    try {
      const real = fs.realpathSync(path.join(root, file));
      if (!isWithinProject(root, real)) continue;
      source = fs.readFileSync(real, 'utf8');
    } catch { continue; }
    const tree = parser.parse(source);
    if (!tree) continue;
    const lines = source.split('\n');
    /**
     * @brief 仅沿声明器链取函数指针名称并记录真实预处理祖先，不解释条件表达式。
     * @param[in] syntax 当前语法节点
     * @return 无；完整且唯一对应已有节点的声明才进入清单
     */
    const visit = (syntax: SyntaxNode): void => {
      if (syntax.type === 'type_definition') {
        let declarator = syntax.childForFieldName('declarator');
        let functionPointer = false;
        let functionDeclarator = false;
        while (declarator && declarator.type !== 'type_identifier' && declarator.type !== 'identifier') {
          functionPointer ||= declarator.type === 'pointer_declarator';
          functionDeclarator ||= declarator.type === 'function_declarator';
          declarator = declarator.childForFieldName('declarator') ?? declarator.namedChild(0);
        }
        if (functionPointer && functionDeclarator && declarator) {
          const matches = aliases.filter(node => node.filePath === file &&
            node.startLine === syntax.startPosition.row + 1 && node.endLine === syntax.endPosition.row + 1);
          if (matches.length === 1) {
            const node = matches[0]!;
            let sourceStartLine = node.startLine;
            let sourceEndLine = node.endLine;
            let sourceConditionFound = false;
            const conditions: string[] = [];
            for (let ancestor = syntax.parent; ancestor; ancestor = ancestor.parent) {
              if (['preproc_if', 'preproc_ifdef', 'preproc_elif', 'preproc_else'].includes(ancestor.type)) {
                conditions.unshift(lines[ancestor.startPosition.row]?.trim() ?? ancestor.type);
                // 最近的完整条件组包含两条 alternatives；外层 include guard 只记条件，
                // 不扩大正文到整份头文件，否则会挤掉真正需要查询的声明。
                if (!sourceConditionFound && (ancestor.type === 'preproc_if' || ancestor.type === 'preproc_ifdef')) {
                  sourceConditionFound = true;
                  sourceStartLine = ancestor.startPosition.row + 1;
                  sourceEndLine = ancestor.endPosition.row + (ancestor.endPosition.column === 0 ? 0 : 1);
                }
              }
            }
            const context: StructuralTypedefContext = { nodeId: node.id, filePath: file,
              name: declarator.text, startLine: node.startLine, endLine: node.endLine,
              sourceStartLine, sourceEndLine, conditions };
            try {
              const previous = JSON.parse(queries.getMetadata(`cpp_typedef:${node.id}`) ?? '{}') as StructuralTypedefContext;
              if (previous.name === context.name && previous.startLine === context.startLine &&
                  previous.endLine === context.endLine) context.confirmedConfigIds = previous.confirmedConfigIds;
            } catch { /* 未确认的旧结构不能补充生效配置。 */ }
            // 结构规范化不改变 baseline ID，也不创建虚构 compile view。
            if (node.name !== context.name) queries.updateNode({ ...node,
              name: context.name, qualifiedName: context.name, updatedAt: Date.now() });
            queries.setMetadata(`cpp_typedef:${node.id}`, JSON.stringify(context));
            contexts.push(context);
          }
        }
      }
      for (const child of syntax.namedChildren) visit(child);
    };
    visit(tree.rootNode);
    tree.delete();
  }
  return contexts;
}

/**
 * @brief 对账 definition 实际确认的 typedef 视图归属，并保留 partial/advisory 历史证据。
 * @param[in] db 已配置外键的图数据库
 * @param[in] queries 节点查询与元数据接口
 * @param[in] collection 当前 clangd 编译视图与绑定事实
 * @param[in] contexts 本轮完整结构声明候选
 * @return 无；只接受真实节点及当前配置中的正向绑定
 */
export function reconcileCppTypedefBindings(db: SqliteDatabase, queries: QueryBuilder,
  collection: SemanticFactCollection, contexts: StructuralTypedefContext[]): void {
  const candidates = new Map(contexts.map(context => [context.nodeId, context]));
  db.transaction(() => {
    for (const view of collection.views) {
      if (collection.inventory !== 'authoritative' || view.inventory !== 'authoritative' || !view.success) continue;
      for (const context of contexts) db.prepare(
        'DELETE FROM semantic_node_configs WHERE node_id = ? AND config_id = ?').run(context.nodeId, view.id);
    }
    for (const binding of collection.typedefBindings ?? []) {
      const context = candidates.get(binding.nodeId);
      if (!context || !queries.getNodeById(binding.nodeId) || !collection.views.some(view => view.id === binding.configId))
        throw new Error('Invalid C/C++ typedef binding');
      db.prepare(`INSERT INTO semantic_node_configs (node_id,config_id,signature,definition_line,definition_col)
        VALUES (?,?,?,?,?) ON CONFLICT(node_id,config_id) DO UPDATE SET
          signature=excluded.signature,definition_line=excluded.definition_line,definition_col=excluded.definition_col`)
        .run(binding.nodeId, binding.configId, queries.getNodeById(binding.nodeId)?.signature ?? null,
          context.startLine, queries.getNodeById(binding.nodeId)?.startColumn ?? 0);
    }
    for (const context of contexts) {
      const observed = new Set((collection.typedefBindings ?? []).filter(binding => binding.nodeId === context.nodeId)
        .map(binding => binding.configId));
      if (collection.scopeFiles) for (const id of context.confirmedConfigIds ?? []) {
        if (!collection.views.some(view => view.id === id)) observed.add(id);
      }
      queries.setMetadata(`cpp_typedef:${context.nodeId}`, JSON.stringify({ ...context,
        confirmedConfigIds: [...observed].sort() }));
    }
    // 已删除声明的元数据不能在下一轮被重新查询；不触碰其他 project_metadata。
    db.prepare(`DELETE FROM project_metadata WHERE substr(key,1,12) = 'cpp_typedef:' AND
      NOT EXISTS (SELECT 1 FROM nodes WHERE id = substr(project_metadata.key,13))`).run();
  })();
}

/**
 * @brief 为编译 TU 直接包含且实际使用的本地头文件宏保存完整结构范围。
 * @param[in] root 项目根目录，读取前会校验真实文件仍在根目录内
 * @param[in] db 当前语义修复事务使用的数据库连接
 * @param[in] queries 当前图节点读写接口
 * @param[in] translationUnits 编译数据库中的项目相对 TU 路径；不会扫描依赖 TU 或递归 include
 * @param[in] allowRetirement 权威采集完整时允许退役不再有结构候选的旧宏
 * @return 本轮新建的宏定义节点数量；缺失语法或文件时跳过相应文件
 */
export async function reconcileCppStructuralMacros(root: string, db: SqliteDatabase,
  queries: QueryBuilder, translationUnits: string[], allowRetirement = false): Promise<number> {
  // 普通提取运行在解析 worker；主线程需为此 opt-in 阶段单独加载 C 语法。
  await loadGrammarsForLanguages(['c']);
  const parser = getParser('c');
  if (!parser) return 0;
  let added = 0;
  let complete = true;
  const referenced = new Map<string, Set<string>>();
  const tracked = new Map(queries.getAllFiles().map(file => [file.path, file]));
  for (const unit of new Set(translationUnits)) {
    let source: string;
    try {
      const absolute = fs.realpathSync(path.join(root, unit));
      if (!isWithinProject(root, absolute) || !fs.statSync(absolute).isFile()) { complete = false; continue; }
      source = fs.readFileSync(absolute, 'utf8');
    } catch { complete = false; continue; }
    const tree = parser.parse(source);
    if (!tree) { complete = false; continue; }
    const names = new Set<string>();
    const headers = new Set<string>();
    /**
     * @brief 收集 TU 的语法标识符与直接本地 include，避免依赖宏全集污染主图。
     * @param[in] syntax 当前 Tree-sitter 节点
     * @return 无；名字仅筛选结构候选，不证明宏绑定或预处理分支生效
     */
    const collect = (syntax: SyntaxNode): void => {
      if (syntax.type === 'identifier') names.add(syntax.text);
      if (syntax.type === 'preproc_include') {
        const included = syntax.childForFieldName('path');
        // 仅解析引号 include 的包含文件相对路径；不猜测 -I 搜索顺序或遍历 SDK。
        if (included?.type === 'string_literal') {
          try {
            const absolute = fs.realpathSync(path.resolve(root, path.dirname(unit), included.text.slice(1, -1)));
            const relative = path.relative(root, absolute).replace(/\\/g, '/');
            if (isWithinProject(root, absolute) && tracked.has(relative)) headers.add(relative);
          } catch { complete = false; }
        }
      }
      for (const child of syntax.namedChildren) collect(child);
    };
    collect(tree.rootNode);
    tree.delete();
    for (const header of headers) {
      const used = referenced.get(header) ?? new Set<string>();
      for (const name of names) used.add(name);
      referenced.set(header, used);
    }
  }
  const retained = new Set<string>();
  for (const file of queries.getAllFiles()) {
    const usedNames = referenced.get(file.path);
    if (!usedNames || (file.language !== 'c' && file.language !== 'cpp') || !/\.(?:h|hh|hpp|hxx)$/i.test(file.path)) continue;
    let source: string;
    try {
      const absolute = fs.realpathSync(path.join(root, file.path));
      if (!isWithinProject(root, absolute) || !fs.statSync(absolute).isFile()) { complete = false; continue; }
      source = fs.readFileSync(absolute, 'utf8');
    } catch { complete = false; continue; }
    const lines = source.split('\n');
    const existing = new Map(queries.getNodesByFile(file.path).map(node => [node.id, node]));
    const tree = parser.parse(source);
    if (!tree) { complete = false; continue; }
    /**
     * @brief 遍历 C 结构预处理定义并保留宏真实源码跨度。
     * @param[in] syntax 当前 Tree-sitter 节点
     * @return 无；仅将完整名称与位置构成的节点加入待写入集合
     */
    const visit = (syntax: SyntaxNode): void => {
      if (syntax.type === 'preproc_def' || syntax.type === 'preproc_function_def') {
        const identifier = syntax.namedChild(0);
        if (identifier?.type === 'identifier' && usedNames.has(identifier.text)) {
          const name = identifier.text;
          const startLine = syntax.startPosition.row + 1;
          const id = generateNodeId(file.path, 'constant', name, startLine);
          retained.add(id);
          if (!existing.has(id) || existing.get(id)?.semanticOrigin === 'source-structure') {
            // Tree-sitter 的结束位置为半开区间；行首结束不能包含下一行源码。
            const endLine = syntax.endPosition.row + (syntax.endPosition.column === 0 ? 0 : 1);
            const node: Node = { id, kind: 'constant', name, qualifiedName: name,
              filePath: file.path, language: file.language,
              startLine, startColumn: syntax.startPosition.column,
              endLine: Math.max(startLine, endLine), endColumn: syntax.endPosition.column,
              signature: lines[syntax.startPosition.row]?.trimEnd(),
              semanticOrigin: 'source-structure', updatedAt: Date.now() };
            if (existing.has(id)) queries.updateNode(node);
            else { queries.insertNode(node); added++; }
            existing.set(id, node);
          }
        }
      }
      for (const child of syntax.namedChildren) visit(child);
    };
    db.transaction(() => visit(tree.rootNode))();
    tree.delete();
  }
  if (complete && allowRetirement) {
    // 结构退役只作用于本路径创建的宏；任何 TU/头文件读取失败时保留旧正向事实。
    for (const row of db.prepare("SELECT id FROM nodes WHERE semantic_origin = 'source-structure' AND kind = 'constant'")
      .all() as Array<{ id: string }>) {
      if (!retained.has(row.id)) queries.deleteNode(row.id);
    }
  }
  return added;
}

/**
 * @brief 拒绝未能安全映射到图节点的事实，避免部分 SQL 更新后被当作完整清单提交。
 * @param[in] fact clangd 返回的 C/C++ 定义事实
 * @param[in] viewIds 当前清单中已知的配置 ID
 * @return 无；坐标、配置或项目相对路径非法时抛错并回滚事务
 */
function validateFact(fact: SemanticSymbolFact, viewIds: ReadonlySet<string>): void {
  if (!viewIds.has(fact.configId) || !fact.filePath || path.isAbsolute(fact.filePath) ||
      fact.filePath.split(/[\\/]/).includes('..') || !fact.name ||
      (fact.kind !== 'function' && fact.kind !== 'method') ||
      !Number.isSafeInteger(fact.startLine) || fact.startLine < 1 ||
      !Number.isSafeInteger(fact.endLine) || fact.endLine < fact.startLine ||
      !Number.isSafeInteger(fact.startColumn) || fact.startColumn < 0 ||
      !Number.isSafeInteger(fact.endColumn) || fact.endColumn < 0 ||
      (fact.startLine === fact.endLine && fact.endColumn < fact.startColumn)) {
    throw new Error('Invalid C/C++ semantic symbol fact');
  }
}

/**
 * @brief 判断采集结果是否既有权威清单又完成全部视图覆盖。
 * @param[in] collection 带有独立权威性和运行时成功证据的采集结果
 * @return 可安全根据缺失信息做删除时返回 true，否则只允许正向写入
 */
function hasAuthoritativeCoverage(collection: SemanticFactCollection): boolean {
  return collection.inventory === 'authoritative' && collection.views.every(view =>
    view.inventory === 'authoritative' && view.success && view.failedFiles.length === 0 &&
    view.failedTuCount === 0 && view.coveredFiles.length === view.analyzedTuCount);
}

/**
 * @brief 给重叠候选排序，优先保留基线身份，其次选相同 body 终点及最大范围交叠。
 * @param[in] left 候选节点
 * @param[in] right 候选节点
 * @param[in] fact 当前配置中的定义
 * @return 稳定的排序结果，ID 为最后的确定性决胜键
 */
function compareCandidate(left: Node, right: Node, fact: SemanticSymbolFact): number {
  if (!!left.semanticOrigin !== !!right.semanticOrigin) return left.semanticOrigin ? 1 : -1;
  if ((left.endLine === fact.endLine) !== (right.endLine === fact.endLine)) {
    return left.endLine === fact.endLine ? -1 : 1;
  }
  const overlap = (node: Node): number =>
    Math.min(node.endLine, fact.endLine) - Math.max(node.startLine, fact.startLine) + 1;
  return overlap(right) - overlap(left) ||
    Math.abs(left.startLine - fact.startLine) - Math.abs(right.startLine - fact.startLine) ||
    left.id.localeCompare(right.id);
}

/**
 * @brief 在单次事务里写入配置事实并按权威覆盖门槛退役孤立 clangd 身份。
 * @param[in] db CodeGraph 已配置外键的 SQLite 连接
 * @param[in] queries 同一连接的图读写接口，用于一致地失效节点缓存
 * @param[in] collection PR2 采集的按配置分组的正向事实及覆盖状态
 * @return 本轮新增及基线复用节点数量、需要重试失败引用的名称；错误时整体回滚
 */
export function reconcileCppSemanticNodes(db: SqliteDatabase, queries: QueryBuilder,
  collection: SemanticFactCollection): { nodesAdded: number; nodesReused: number; retryNames: string[] } {
  const ids = new Set(collection.views.map(view => view.id));
  if (ids.size !== collection.views.length || collection.views.some(view =>
    !view.id || !view.key || !/^[a-f0-9]{64}$/.test(view.flagsHash))) {
    throw new Error('Invalid C/C++ semantic view inventory');
  }
  for (const fact of collection.symbols) validateFact(fact, ids);
  const complete = !collection.scopeFiles && hasAuthoritativeCoverage(collection);
  const scoped = new Set(collection.scopeFiles ?? []);
  /**
   * @brief 仅当目标文件在所有关联视图均成功覆盖时允许撤销旧归属。
   * @param[in] file 项目相对源码文件路径
   * @return 当前清单足以对该文件提供负面证据时为 true
   */
  const canRefresh = (file: string): boolean => {
    if (complete) return true;
    if (!collection.scopeFiles || collection.inventory !== 'authoritative' || !scoped.has(file)) return false;
    const expected = collection.expectedViewsByFile?.[file] ?? [];
    return expected.length > 0 && expected.every(id => collection.views.some(view =>
      view.id === id && view.inventory === 'authoritative' && view.success &&
      view.failedFiles.length === 0 && view.coveredFiles.includes(file)));
  };
  const sorted = [...collection.symbols].sort((a, b) =>
    a.filePath.localeCompare(b.filePath) || a.kind.localeCompare(b.kind) ||
    a.name.localeCompare(b.name) || a.startLine - b.startLine ||
    a.startColumn - b.startColumn || a.endLine - b.endLine ||
    a.configId.localeCompare(b.configId) || (a.signature ?? '').localeCompare(b.signature ?? ''));
  const used = { nodesAdded: 0, nodesReused: 0, retryNames: [] as string[] };
  const retryNames = new Set<string>();
  db.transaction(() => {
    if (complete) {
      // 当前权威完整快照确认配置全集，故以前仅靠 advisory 建立的过期配置也可退役；
      // 若当前仅有 advisory 或视图未完整覆盖，则完全不能根据缺失清理旧配置。
      for (const row of db.prepare('SELECT id FROM semantic_configs').all() as Array<{ id: string }>) {
        if (!ids.has(row.id)) db.prepare('DELETE FROM semantic_configs WHERE id = ?').run(row.id);
      }
    }
    const now = Date.now();
    for (const view of collection.views) {
      const authority = collection.inventory === 'authoritative' && view.inventory === 'authoritative'
        ? 'authoritative' : 'advisory';
      db.prepare(`
        INSERT INTO semantic_configs (id,label,compiler,flags_hash,authority,metadata,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          label=excluded.label, compiler=excluded.compiler, flags_hash=excluded.flags_hash,
          authority=excluded.authority, metadata=excluded.metadata, updated_at=excluded.updated_at
      `).run(view.id, view.key, view.compiler ?? null, view.flagsHash,
        authority, JSON.stringify({ grouping: view.grouping }), now);
      if (!view.success) continue;
      // 单视图只提供其真正覆盖文件的负面证据；其他文件即使未出现也保留。
      for (const file of view.coveredFiles) {
        if (!canRefresh(file)) continue;
        db.prepare(`
          DELETE FROM semantic_node_configs WHERE config_id = ?
            AND node_id IN (SELECT id FROM nodes WHERE file_path = ?)
        `).run(view.id, file);
      }
    }
    for (const fact of sorted) {
      const candidates = queries.getNodesByFile(fact.filePath)
        .filter(node => node.kind === fact.kind && node.name === fact.name &&
          semanticRangesOverlap(node, fact))
        .sort((a, b) => compareCandidate(a, b, fact));
      assertPairwiseSemanticOverlap(candidates);
      let winner = candidates[0];
      if (!winner) {
        let id = generateNodeId(fact.filePath, fact.kind, fact.name, fact.startLine);
        const occupant = queries.getNodeById(id);
        if (occupant) {
          if (occupant.filePath !== fact.filePath || occupant.kind !== fact.kind ||
              occupant.name !== fact.name || occupant.startLine !== fact.startLine) {
            throw new Error('Semantic node ID collides with existing identity');
          }
          // 仅真实行号 ID 碰撞时消歧；列号目标也被别的身份占用则拒写并回滚。
          id = semanticCollisionNodeId(fact);
          if (queries.getNodeById(id)) throw new Error('Semantic node ID collides with existing identity');
        }
        winner = { id,
          kind: fact.kind, name: fact.name, qualifiedName: fact.name,
          filePath: fact.filePath, language: /\.(?:c|h|i)$/i.test(fact.filePath) ? 'c' : 'cpp',
          startLine: fact.startLine, startColumn: fact.startColumn,
          endLine: fact.endLine, endColumn: fact.endColumn,
          signature: fact.signature, semanticOrigin: 'clangd', updatedAt: now };
        queries.insertNode(winner);
        used.nodesAdded++;
        retryNames.add(fact.name);
      } else {
        used.nodesReused++;
        for (const loser of candidates.slice(1)) {
          if (loser.semanticOrigin) {
            queries.mergeSemanticNode(winner.id, loser.id);
            retryNames.add(fact.name);
          }
        }
        if (winner.semanticOrigin) {
          // 多配置签名起始行不同，但 canonical ID 不因后续配置集变化而重算。
          const updated = { ...winner,
            startLine: Math.min(winner.startLine, fact.startLine),
            endLine: Math.max(winner.endLine, fact.endLine) };
          if (updated.startLine !== winner.startLine || updated.endLine !== winner.endLine) {
            queries.updateNode(updated);
          }
        }
      }
      db.prepare(`
        INSERT INTO semantic_node_configs (node_id,config_id,signature,definition_line,definition_col)
        VALUES (?,?,?,?,?) ON CONFLICT(node_id,config_id) DO UPDATE SET
          signature=excluded.signature, definition_line=excluded.definition_line,
          definition_col=excluded.definition_col
      `).run(winner.id, fact.configId, fact.signature ?? null, fact.startLine, fact.startColumn);
    }
    if (complete || [...scoped].some(canRefresh)) {
      // 只有语义创建且已无任何配置归属的身份可以删除；基线与 heuristic 边不受影响。
      for (const row of db.prepare(`
        SELECT id FROM nodes WHERE semantic_origin = 'clangd'
          AND NOT EXISTS (SELECT 1 FROM semantic_node_configs WHERE node_id = nodes.id)
      `).all() as Array<{ id: string }>) {
        const node = queries.getNodeById(row.id);
        if (node && canRefresh(node.filePath)) queries.deleteNode(row.id);
      }
      if (complete) db.prepare(`
          DELETE FROM edges WHERE provenance = 'clangd'
            AND NOT EXISTS (SELECT 1 FROM semantic_edge_configs WHERE edge_id = edges.id)
        `).run();
    }
  })();
  used.retryNames = [...retryNames].sort();
  return used;
}
