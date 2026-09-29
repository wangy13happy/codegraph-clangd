/** @file C/C++ 语义节点归并、配置 provenance 和保守退役。 */
import * as path from 'path';
import { SqliteDatabase } from '../../db/sqlite-adapter';
import { QueryBuilder } from '../../db/queries';
import { generateNodeId, semanticCollisionNodeId } from '../../extraction/tree-sitter-helpers';
import { Node } from '../../types';
import { SemanticFactCollection } from './index';
import { SemanticSymbolFact, semanticRangesOverlap, assertPairwiseSemanticOverlap } from './facts';

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
  const complete = hasAuthoritativeCoverage(collection);
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
      if (!complete || !view.success) continue;
      // 单视图只提供其真正覆盖文件的负面证据；其他文件即使未出现也保留。
      for (const file of view.coveredFiles) {
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
    if (complete) {
      // 只有语义创建且已无任何配置归属的身份可以删除；基线与 heuristic 边不受影响。
      for (const row of db.prepare(`
        SELECT id FROM nodes WHERE semantic_origin = 'clangd'
          AND NOT EXISTS (SELECT 1 FROM semantic_node_configs WHERE node_id = nodes.id)
      `).all() as Array<{ id: string }>) queries.deleteNode(row.id);
      db.prepare(`
        DELETE FROM edges WHERE provenance = 'clangd'
          AND NOT EXISTS (SELECT 1 FROM semantic_edge_configs WHERE edge_id = edges.id)
      `).run();
    }
  })();
  used.retryNames = [...retryNames].sort();
  return used;
}
