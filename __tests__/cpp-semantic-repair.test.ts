import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { generateNodeId, semanticCollisionNodeId } from '../src/extraction/tree-sitter-helpers';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { reconcileCppSemanticNodes } from '../src/semantic/cpp/reconciler';
import { collectCppSemanticFacts, SemanticFactCollection } from '../src/semantic/cpp';
import { createResolver } from '../src/resolution';
import { Node } from '../src/types';
import { CodeGraph } from '../src';

vi.mock('../src/semantic/cpp', async importOriginal => ({
  ...await importOriginal<typeof import('../src/semantic/cpp')>(),
  collectCppSemanticFacts: vi.fn(),
}));

describe('C/C++ semantic node reconciliation', () => {
  let directory: string;
  let conn: DatabaseConnection;
  let queries: QueryBuilder;

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['c', 'cpp']);
  });

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-repair-'));
    conn = DatabaseConnection.initialize(path.join(directory, 'graph.db'));
    queries = new QueryBuilder(conn.getDb());
  });

  afterEach(() => {
    conn.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  /**
   * @brief 构造带有明确清单权威性与运行时覆盖证据的合成采集结果。
   * @param[in] ids 编译配置标识
   * @param[in] facts 源码符号事实
   * @param[in] authority 清单权威性
   * @return 能独立控制视图成功或失败的测试输入
   */
  function collection(ids: string[], facts: SemanticFactCollection['symbols'],
    authority: 'authoritative' | 'advisory' = 'authoritative'): SemanticFactCollection {
    return { inventory: authority, grouping: 'cmake-target', symbols: facts, calls: [],
      views: ids.map(id => ({ id, key: `cmake:${id}`, inventory: authority,
        compiler: 'cross-gcc', flagsHash: createHash('sha256').update(JSON.stringify([JSON.stringify([`-D${id}`])])).digest('hex'),
        grouping: 'cmake-target', success: true, coveredFiles: ['variant.c'],
        failedFiles: [], analyzedTuCount: 1, failedTuCount: 0, durationMs: 1 })) };
  }

  /**
   * @brief 构造一条函数定义事实，按起始行区分配置中的不同签名。
   * @param[in] configId 配置标识
   * @param[in] filePath 相对文件路径
   * @param[in] name 函数简单名
   * @param[in] startLine 定义起始行
   * @param[in] endLine 共享函数体结束行
   * @return 可用于归并和 membership 断言的符号事实
   */
  function fact(configId: string, filePath: string, name: string, startLine: number,
    endLine: number): SemanticFactCollection['symbols'][number] {
    return { configId, filePath, kind: 'function', name, startLine, endLine,
      startColumn: 0, endColumn: 1, signature: `int ${name}(${configId})` };
  }

  /**
   * @brief 用普通提取 API 构造基线函数并保留真实的行号派生 ID。
   * @param[in] filePath 源文件路径
   * @param[in] name 函数名
   * @param[in] line 起始行
   * @param[in] endLine 结束行
   * @return 新写入图中的基线身份
   */
  function baseline(filePath: string, name: string, line: number, endLine: number): Node {
    return { id: generateNodeId(filePath, 'function', name, line), filePath,
      kind: 'function', name, qualifiedName: name, language: 'c', startLine: line,
      endLine, startColumn: 0, endColumn: 1, updatedAt: 1 };
  }

  it('merges conditional signatures and their shared body into one identity', () => {
    const input = collection(['one', 'two'], [fact('one', 'variant.c', 'feature', 2, 12),
      fact('two', 'variant.c', 'feature', 5, 12)]);
    reconcileCppSemanticNodes(conn.getDb(), queries, input);
    const nodes = queries.getNodesByFile('variant.c');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.id).toBe(generateNodeId('variant.c', 'function', 'feature', 2));
    expect(nodes[0]!.startLine).toBe(2);
    expect(nodes[0]!.endLine).toBe(12);
    expect(nodes[0]!.semanticOrigin).toBe('clangd');
    const rows = conn.getDb().prepare('SELECT config_id,signature,definition_line FROM semantic_node_configs ORDER BY config_id').all();
    expect(rows).toEqual([
      { config_id: 'one', signature: 'int feature(one)', definition_line: 2 },
      { config_id: 'two', signature: 'int feature(two)', definition_line: 5 },
    ]);
    const configs = conn.getDb().prepare('SELECT id,compiler,flags_hash FROM semantic_configs ORDER BY id').all();
    expect(configs).toEqual(input.views.map(view => ({ id: view.id,
      compiler: view.compiler, flags_hash: view.flagsHash })));
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['two'], [fact('two', 'variant.c', 'feature', 5, 12)]));
    expect(queries.getNodesByFile('variant.c').map(node => node.id)).toEqual([nodes[0]!.id]);
    expect(conn.getDb().prepare('SELECT config_id FROM semantic_node_configs').all()).toEqual([{ config_id: 'two' }]);
  });

  it('keeps same-name static functions from different files distinct', () => {
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [
      fact('one', 'static-a.c', 'helper', 3, 6), fact('one', 'static-b.c', 'helper', 3, 6),
    ]));
    const rows = conn.getDb().prepare('SELECT id,file_path FROM nodes ORDER BY file_path').all() as Array<{ id: string; file_path: string }>;
    expect(rows.map(row => row.file_path)).toEqual(['static-a.c', 'static-b.c']);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
  });

  it('stores nullable compiler without mistaking a target key for semantic flags', () => {
    const input = collection(['target'], [fact('target', 'variant.c', 'helper', 3, 8)]);
    input.views[0]!.compiler = undefined;
    reconcileCppSemanticNodes(conn.getDb(), queries, input);
    expect(conn.getDb().prepare('SELECT compiler,flags_hash FROM semantic_configs').all())
      .toEqual([{ compiler: null, flags_hash: input.views[0]!.flagsHash }]);
    expect(input.views[0]!.flagsHash).not.toBe(createHash('sha256').update(input.views[0]!.key).digest('hex'));
  });

  it('does not conflate disjoint same-name definitions in one file, including adjacent columns', () => {
    const first = { ...fact('one', 'variant.c', 'static_helper', 1, 1), endColumn: 18 };
    const second = { ...fact('one', 'variant.c', 'static_helper', 1, 1),
      startColumn: 18, endColumn: 38 };
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [second, first]));
    const nodes = queries.getNodesByFile('variant.c').sort((a, b) => a.startColumn - b.startColumn);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.id).toBe(generateNodeId('variant.c', 'function', 'static_helper', 1));
    expect(nodes[1]!.id).not.toBe(nodes[0]!.id);
    expect(conn.getDb().prepare(`
      SELECT n.start_column AS col, c.node_id FROM semantic_node_configs c
      JOIN nodes n ON n.id = c.node_id ORDER BY n.start_column
    `).all()).toEqual([{ col: 0, node_id: nodes[0]!.id }, { col: 18, node_id: nodes[1]!.id }]);
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [first, second]));
    expect(queries.getNodesByFile('variant.c').sort((a, b) => a.startColumn - b.startColumn)
      .map(node => node.id)).toEqual(nodes.map(node => node.id));
  });

  it.each(['single', 'batch'] as const)(
    'lets the second same-line definition take the original ID through %s baseline write', mode => {
      const first = { ...fact('one', 'variant.c', 'feature', 1, 1), endColumn: 18 };
      const second = { ...fact('one', 'variant.c', 'feature', 1, 1), startColumn: 18, endColumn: 38 };
      reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [first, second]));
      const [left, right] = queries.getNodesByFile('variant.c').sort((a, b) => a.startColumn - b.startColumn);
      const aCaller = baseline('caller.c', 'aCaller', 20, 22);
      const bCaller = baseline('caller.c', 'bCaller', 24, 26);
      const target = baseline('target.c', 'target', 30, 33);
      queries.insertNodes([aCaller, bCaller, target]);
      queries.insertEdge({ source: aCaller.id, target: left!.id, kind: 'references', line: 21,
        metadata: { refName: 'feature', refKind: 'function_ref' } });
      queries.insertEdge({ source: bCaller.id, target: right!.id, kind: 'references', line: 25,
        metadata: { refName: 'feature', refKind: 'function_ref' } });
      queries.insertEdge({ source: bCaller.id, target: right!.id, kind: 'references', line: 26 });
      queries.insertEdge({ source: left!.id, target: target.id, kind: 'calls', line: 1, provenance: 'clangd' });
      queries.insertEdge({ source: left!.id, target: target.id, kind: 'calls', line: 2, provenance: 'heuristic' });
      queries.insertEdge({ source: right!.id, target: target.id, kind: 'calls', line: 3, provenance: 'heuristic' });
      const trackedEdge = conn.getDb().prepare('SELECT id FROM edges WHERE source = ? AND line = 1')
        .get(left!.id) as { id: number };
      conn.getDb().prepare('INSERT INTO semantic_edge_configs (edge_id,config_id) VALUES (?,?)')
        .run(trackedEdge.id, 'one');
      queries.insertUnresolvedRef({ fromNodeId: left!.id, referenceName: 'target',
        referenceKind: 'calls', line: 1, column: 4, filePath: 'variant.c', language: 'c' });

      const recovered = { ...baseline('variant.c', 'feature', 1, 1), startColumn: 18, endColumn: 38 };
      if (mode === 'single') queries.insertNode(recovered);
      else queries.insertNodes([baseline('variant.c', 'other', 4, 5), recovered]);
      const nodes = queries.getNodesByFile('variant.c').filter(node => node.name === 'feature')
        .sort((a, b) => a.startColumn - b.startColumn);
      expect(nodes).toHaveLength(2);
      expect(nodes[0]).toMatchObject({ semanticOrigin: 'clangd', startColumn: 0 });
      expect(nodes[0]!.id).not.toBe(left!.id);
      expect(nodes[1]).toMatchObject({ id: recovered.id, startColumn: 18 });
      expect(nodes[1]!.semanticOrigin).toBeUndefined();
      expect(conn.getDb().prepare(`
        SELECT n.start_column AS col, c.node_id, c.definition_col FROM semantic_node_configs c
        JOIN nodes n ON n.id = c.node_id ORDER BY n.start_column
      `).all()).toEqual([
        { col: 0, node_id: nodes[0]!.id, definition_col: 0 },
        { col: 18, node_id: recovered.id, definition_col: 18 },
      ]);
      expect(conn.getDb().prepare('SELECT source,target,line,provenance FROM edges ORDER BY line').all())
        .toEqual([
          { source: nodes[0]!.id, target: target.id, line: 1, provenance: 'clangd' },
          { source: nodes[0]!.id, target: target.id, line: 2, provenance: 'heuristic' },
          { source: aCaller.id, target: nodes[0]!.id, line: 21, provenance: null },
          { source: bCaller.id, target: recovered.id, line: 25, provenance: null },
        ]);
      expect(conn.getDb().prepare('SELECT edge_id FROM semantic_edge_configs').all())
        .toEqual([{ edge_id: trackedEdge.id }]);
      expect(conn.getDb().prepare('SELECT from_node_id FROM unresolved_refs').all())
        .toEqual([{ from_node_id: nodes[0]!.id }]);
      reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [second, first]));
      expect(queries.getNodesByFile('variant.c').filter(node => node.name === 'feature')
        .sort((a, b) => a.startColumn - b.startColumn).map(node => node.id))
        .toEqual([nodes[0]!.id, recovered.id]);
    }
  );

  it('rejects an occupied column ID without migrating the old identity', () => {
    const first = { ...fact('one', 'variant.c', 'feature', 1, 1), endColumn: 18 };
    const second = { ...fact('one', 'variant.c', 'feature', 1, 1), startColumn: 18, endColumn: 38 };
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [first, second]));
    const occupied = { ...baseline('other.c', 'unrelated', 5, 5),
      id: semanticCollisionNodeId(first) };
    queries.insertNode(occupied);
    const before = conn.getDb().prepare('SELECT id,file_path,start_column,semantic_origin FROM nodes ORDER BY id').all();
    expect(() => queries.insertNode({ ...baseline('variant.c', 'feature', 1, 1),
      startColumn: 18, endColumn: 38 })).toThrow(/collides/);
    expect(conn.getDb().prepare('SELECT id,file_path,start_column,semantic_origin FROM nodes ORDER BY id').all())
      .toEqual(before);
    expect(conn.getDb().prepare('SELECT node_id FROM semantic_node_configs ORDER BY node_id').all())
      .toEqual(queries.getNodesByFile('variant.c').map(node => node.id).sort()
        .map(node_id => ({ node_id })));
  });

  it('does not use column disambiguation when an unrelated node occupies the row ID', () => {
    const observed = fact('one', 'variant.c', 'feature', 1, 1);
    const occupied = { ...baseline('other.c', 'unrelated', 5, 5),
      id: generateNodeId('variant.c', 'function', 'feature', 1) };
    queries.insertNode(occupied);
    expect(() => reconcileCppSemanticNodes(conn.getDb(), queries,
      collection(['one'], [observed]))).toThrow(/collides/);
    expect(queries.getNodesByFile('variant.c')).toEqual([]);
    expect(queries.getNodeById(occupied.id)).toMatchObject({ name: 'unrelated', filePath: 'other.c' });
    expect(conn.getDb().prepare('SELECT * FROM semantic_configs').all()).toEqual([]);
  });

  it.each([false, true])('keeps both same-line baseline definitions in a batch (reverse=%s)', reverse => {
    const first = { ...fact('one', 'variant.c', 'feature', 1, 1), endColumn: 18 };
    const second = { ...fact('one', 'variant.c', 'feature', 1, 1), startColumn: 18, endColumn: 38 };
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [first, second]));
    const left = { ...baseline('variant.c', 'feature', 1, 1), endColumn: 18 };
    const right = { ...baseline('variant.c', 'feature', 1, 1), startColumn: 18, endColumn: 38 };
    const caller = baseline('caller.c', 'caller', 20, 21);
    queries.insertNode(caller);
    queries.insertEdge({ source: caller.id, target: left.id, kind: 'references', line: 20,
      metadata: { refName: 'feature', refKind: 'function_ref' } });
    queries.insertNodes(reverse ? [right, left] : [left, right]);
    const nodes = queries.getNodesByFile('variant.c').sort((a, b) => a.startColumn - b.startColumn);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ id: left.id, startColumn: 0 });
    expect(nodes[1]).toMatchObject({ id: semanticCollisionNodeId(second), startColumn: 18 });
    expect(nodes.map(node => node.semanticOrigin)).toEqual([undefined, undefined]);
    expect(conn.getDb().prepare(`
      SELECT n.start_column AS col, c.node_id FROM semantic_node_configs c
      JOIN nodes n ON n.id = c.node_id ORDER BY n.start_column
    `).all()).toEqual([{ col: 0, node_id: nodes[0]!.id }, { col: 18, node_id: nodes[1]!.id }]);
    expect(conn.getDb().prepare('SELECT target FROM edges WHERE kind = ?').get('references'))
      .toEqual({ target: nodes[0]!.id });
  });

  it('keeps the first baseline and its references when the second baseline takes over', () => {
    const left = { ...baseline('variant.c', 'feature', 1, 1), endColumn: 18 };
    queries.insertNode(left);
    const caller = baseline('caller.c', 'caller', 20, 21);
    queries.insertNode(caller);
    queries.insertEdge({ source: caller.id, target: left.id, kind: 'references', line: 20,
      metadata: { refName: 'feature', refKind: 'function_ref' } });
    const rightFact = { ...fact('one', 'variant.c', 'feature', 1, 1), startColumn: 18, endColumn: 38 };
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [rightFact]));
    const right = { ...baseline('variant.c', 'feature', 1, 1), startColumn: 18, endColumn: 38 };
    queries.insertNode(right);
    const nodes = queries.getNodesByFile('variant.c').sort((a, b) => a.startColumn - b.startColumn);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ id: left.id, startColumn: 0 });
    expect(nodes[1]).toMatchObject({ id: semanticCollisionNodeId(rightFact), startColumn: 18 });
    expect(nodes.map(node => node.semanticOrigin)).toEqual([undefined, undefined]);
    expect(conn.getDb().prepare('SELECT node_id FROM semantic_node_configs').all())
      .toEqual([{ node_id: nodes[1]!.id }]);
    expect(conn.getDb().prepare('SELECT target FROM edges WHERE kind = ?').get('references'))
      .toEqual({ target: left.id });
  });

  it('remaps a file bundle when an existing baseline owns the other same-line definition', () => {
    const right = { ...baseline('variant.c', 'feature', 1, 1), startColumn: 18, endColumn: 38 };
    queries.insertNode(right);
    const caller = baseline('caller.c', 'caller', 20, 21);
    queries.insertNode(caller);
    queries.insertEdge({ source: caller.id, target: right.id, kind: 'references', line: 20,
      metadata: { refName: 'feature', refKind: 'function_ref' } });
    const left = { ...baseline('variant.c', 'feature', 1, 1), endColumn: 18 };
    const extractedRight = { ...right, id: semanticCollisionNodeId(right) };
    const file = { ...baseline('variant.c', 'variant.c', 1, 1), id: 'file:variant.c', kind: 'file' as const };
    queries.storeFileBundle({ nodes: [file, left, extractedRight],
      edges: [{ source: file.id, target: left.id, kind: 'contains' },
        { source: file.id, target: extractedRight.id, kind: 'contains' }],
      refs: [{ fromNodeId: left.id, referenceName: 'leftTarget', referenceKind: 'calls', line: 1, column: 4 },
        { fromNodeId: extractedRight.id, referenceName: 'rightTarget', referenceKind: 'calls', line: 1, column: 24 }],
      file: { path: 'variant.c', contentHash: 'test', language: 'c', size: 38, modifiedAt: 1, indexedAt: 1, nodeCount: 3 },
    });
    const nodes = queries.getNodesByFile('variant.c').filter(node => node.kind === 'function')
      .sort((a, b) => a.startColumn - b.startColumn);
    expect(nodes).toHaveLength(2);
    expect(nodes.map(node => node.id)).toEqual([semanticCollisionNodeId(left), right.id]);
    expect(conn.getDb().prepare('SELECT reference_name,from_node_id FROM unresolved_refs ORDER BY col').all())
      .toEqual([{ reference_name: 'leftTarget', from_node_id: nodes[0]!.id },
        { reference_name: 'rightTarget', from_node_id: right.id }]);
    expect(conn.getDb().prepare('SELECT target FROM edges WHERE kind = ? ORDER BY id').all('contains'))
      .toEqual(nodes.map(node => ({ target: node.id })));
    expect(conn.getDb().prepare('SELECT target FROM edges WHERE kind = ?').get('references'))
      .toEqual({ target: right.id });
  });

  it('rolls back an extraction bundle with ambiguous duplicate-ID endpoints instead of guessing', () => {
    const left = { ...baseline('variant.c', 'feature', 1, 1), endColumn: 18 };
    const right = { ...left, startColumn: 18, endColumn: 38 };
    expect(() => queries.storeFileBundle({ nodes: [left, right], edges: [],
      refs: [{ fromNodeId: left.id, referenceName: 'target', referenceKind: 'calls', line: 1, column: 4 }],
      file: { path: 'variant.c', contentHash: 'test', language: 'c', size: 38, modifiedAt: 1, indexedAt: 1, nodeCount: 2 },
    })).toThrow(/Ambiguous C\/C\+\+ extraction endpoint/);
    expect(queries.getNodesByFile('variant.c')).toEqual([]);
    expect(conn.getDb().prepare('SELECT * FROM unresolved_refs').all()).toEqual([]);
    expect(queries.getFileByPath('variant.c')).toBeNull();
  });

  it.each([false, true])('takes over both semantic definitions from a real C++ extraction bundle (reverse=%s)', reverse => {
    const result = extractFromSource('variant.cpp',
      'int feature() { leftTarget(); return 1; } int feature(int x) { rightTarget(); return x; }\n', 'cpp');
    expect(result.errors).toEqual([]);
    const definitions = result.nodes.filter(node => node.kind === 'function' && node.name === 'feature')
      .sort((a, b) => a.startColumn - b.startColumn);
    const input = collection(['one'], definitions.map(node => ({ ...node, kind: 'function' as const, configId: 'one' })));
    input.views[0]!.coveredFiles = ['variant.cpp'];
    reconcileCppSemanticNodes(conn.getDb(), queries, input);
    queries.storeFileBundle({ nodes: reverse ? [...result.nodes].reverse() : result.nodes,
      edges: result.edges, refs: result.unresolvedReferences,
      file: { path: 'variant.cpp', contentHash: 'test', language: 'cpp', size: 80, modifiedAt: 1, indexedAt: 1,
        nodeCount: result.nodes.length },
    });
    const stored = queries.getNodesByFile('variant.cpp').filter(node => node.name === 'feature')
      .sort((a, b) => a.startColumn - b.startColumn);
    expect(stored.map(node => node.id)).toEqual(definitions.map(node => node.id));
    expect(stored.map(node => node.semanticOrigin)).toEqual([undefined, undefined]);
    expect(conn.getDb().prepare('SELECT node_id,definition_col FROM semantic_node_configs ORDER BY definition_col').all())
      .toEqual(stored.map(node => ({ node_id: node.id, definition_col: node.startColumn })));
    expect(conn.getDb().prepare(`
      SELECT from_node_id,reference_name FROM unresolved_refs
      WHERE reference_name IN ('leftTarget','rightTarget') ORDER BY col
    `).all()).toEqual([{ from_node_id: stored[0]!.id, reference_name: 'leftTarget' },
      { from_node_id: stored[1]!.id, reference_name: 'rightTarget' }]);
  });

  it('rolls back ID relocation when the following ordinary write fails', () => {
    const first = { ...fact('one', 'variant.c', 'feature', 1, 1), endColumn: 18 };
    const second = { ...fact('one', 'variant.c', 'feature', 1, 1), startColumn: 18, endColumn: 38 };
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [first, second]));
    const before = queries.getNodesByFile('variant.c');
    conn.getDb().prepare(`
      CREATE TRIGGER reject_baseline BEFORE INSERT ON nodes
      WHEN NEW.semantic_origin IS NULL AND NEW.start_column = 18
      BEGIN SELECT RAISE(ABORT, 'injected baseline failure'); END
    `).run();
    const recovered = { ...baseline('variant.c', 'feature', 1, 1), startColumn: 18, endColumn: 38 };
    expect(() => queries.insertNode(recovered)).toThrow(/injected baseline failure/);
    expect(queries.getNodesByFile('variant.c')).toEqual(before);
    expect(conn.getDb().prepare('SELECT node_id FROM semantic_node_configs ORDER BY node_id').all())
      .toEqual(before.map(node => node.id).sort().map(node_id => ({ node_id })));
  });

  it('transfers memberships when later extraction chooses a different baseline ID', () => {
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [fact('one', 'variant.c', 'feature', 2, 12)]));
    const original = queries.getNodesByFile('variant.c')[0]!;
    const recovered = baseline('variant.c', 'feature', 5, 12);
    expect(recovered.id).not.toBe(original.id);
    queries.insertNode(recovered);
    expect(queries.getNodesByFile('variant.c').map(node => node.id)).toEqual([recovered.id]);
    expect(conn.getDb().prepare('SELECT node_id FROM semantic_node_configs').all()).toEqual([{ node_id: recovered.id }]);
    expect(queries.getNodeById(recovered.id)?.semanticOrigin).toBeUndefined();
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [fact('one', 'variant.c', 'feature', 2, 12)]));
    expect(queries.getNodesByFile('variant.c').map(node => node.id)).toEqual([recovered.id]);
  });

  it('preserves membership and graph edges when extraction takes over the same ID', () => {
    const observed = fact('one', 'variant.c', 'feature', 2, 12);
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [observed]));
    const original = queries.getNodesByFile('variant.c')[0]!;
    queries.insertNode(baseline('variant.c', 'other', 14, 17));
    queries.insertEdge({ source: original.id, target: generateNodeId('variant.c', 'function', 'other', 14), kind: 'calls' });
    queries.insertNode(baseline('variant.c', 'feature', 2, 12));
    expect(conn.getDb().prepare('SELECT node_id FROM semantic_node_configs').all()).toEqual([{ node_id: original.id }]);
    expect(conn.getDb().prepare('SELECT source FROM edges').all()).toEqual([{ source: original.id }]);
    expect(queries.getNodeById(original.id)?.semanticOrigin).toBeUndefined();
  });

  it('rejects a forged same-ID ordinary replacement without changing old provenance or edges', () => {
    const observed = { ...fact('one', 'variant.c', 'feature', 2, 2), endColumn: 18 };
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [observed]));
    const original = queries.getNodesByFile('variant.c')[0]!;
    const caller = baseline('caller.c', 'caller', 30, 40);
    queries.insertNode(caller);
    queries.insertEdge({ source: caller.id, target: original.id, kind: 'references',
      line: 35, column: 8, metadata: { refName: 'feature', refKind: 'function_ref' } });
    const unrelated = { ...baseline('variant.c', 'feature', 3, 3), id: original.id,
      startColumn: 19, endColumn: 38 };
    expect(unrelated.id).toBe(original.id);
    expect(() => queries.insertNode(unrelated)).toThrow(/semantic node ID/);
    expect(queries.getNodeById(original.id)).toMatchObject({
      semanticOrigin: 'clangd', startColumn: 0, endColumn: 18,
    });
    expect(conn.getDb().prepare('SELECT node_id FROM semantic_node_configs').all())
      .toEqual([{ node_id: original.id }]);
    expect(conn.getDb().prepare('SELECT source,target,line,col FROM edges').all())
      .toEqual([{ source: caller.id, target: original.id, line: 35, col: 8 }]);
  });

  it('rolls back a batch when one ordinary node conflicts with a disjoint semantic identity', () => {
    const observed = { ...fact('one', 'variant.c', 'feature', 2, 2), endColumn: 18 };
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [observed]));
    const unrelated = { ...baseline('variant.c', 'feature', 3, 3),
      id: generateNodeId('variant.c', 'function', 'feature', 2), startColumn: 19, endColumn: 38 };
    expect(() => queries.insertNodes([baseline('variant.c', 'other', 8, 9), unrelated]))
      .toThrow(/semantic node ID/);
    expect(queries.getNodesByFile('variant.c')).toMatchObject([{
      name: 'feature', startColumn: 0, semanticOrigin: 'clangd',
    }]);
    expect(conn.getDb().prepare('SELECT node_id FROM semantic_node_configs').all())
      .toEqual([{ node_id: unrelated.id }]);
  });

  it('keeps a verified ordinary function reference across a different-ID baseline takeover', () => {
    reconcileCppSemanticNodes(conn.getDb(), queries,
      collection(['one'], [fact('one', 'variant.c', 'feature', 2, 12)]));
    const original = queries.getNodesByFile('variant.c')[0]!;
    const caller = baseline('caller.c', 'caller', 30, 40);
    queries.insertNode(caller);
    const metadata = { confidence: 1, resolvedBy: 'function-ref',
      refName: 'feature', refKind: 'function_ref', fnRef: true };
    queries.insertEdge({ source: caller.id, target: original.id, kind: 'references',
      line: 35, column: 8, metadata });
    queries.insertEdge({ source: caller.id, target: original.id, kind: 'references',
      line: 36, column: 9 });
    queries.insertEdge({ source: caller.id, target: original.id, kind: 'references',
      line: 39, column: 12, metadata: { refName: 'other' } });
    queries.insertEdge({ source: caller.id, target: original.id, kind: 'references',
      line: 40, column: 13, metadata: { refName: 'feature', resolvedBy: 'name-match' } });
    queries.insertEdge({ source: caller.id, target: original.id, kind: 'references',
      line: 37, column: 10, metadata, provenance: 'heuristic' });
    queries.insertEdge({ source: caller.id, target: original.id, kind: 'calls',
      line: 38, column: 11, metadata: { refName: 'feature' }, provenance: 'clangd' });
    const recovered = baseline('variant.c', 'feature', 5, 12);
    queries.insertNodes([recovered]);
    expect(queries.getNodesByFile('variant.c').map(node => node.id)).toEqual([recovered.id]);
    const edges = conn.getDb().prepare('SELECT source,target,kind,line,col,metadata,provenance FROM edges').all();
    expect(edges).toEqual([
      { source: caller.id, target: recovered.id, kind: 'references',
        line: 35, col: 8, metadata: JSON.stringify(metadata), provenance: null },
      { source: caller.id, target: recovered.id, kind: 'references',
        line: 40, col: 13, metadata: JSON.stringify({ refName: 'feature', resolvedBy: 'name-match' }), provenance: null },
    ]);
    expect(conn.getDb().prepare('SELECT * FROM unresolved_refs').all()).toEqual([]);
    expect(conn.getDb().prepare('SELECT node_id FROM semantic_node_configs').all())
      .toEqual([{ node_id: recovered.id }]);
  });

  it('rejects a bridging fact rather than rebinding references between disjoint definitions', () => {
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [
      fact('one', 'variant.c', 'feature', 2, 6),
      fact('one', 'variant.c', 'feature', 7, 11),
    ]));
    const [first, second] = queries.getNodesByFile('variant.c');
    const caller = baseline('caller.c', 'caller', 30, 40);
    queries.insertNode(caller);
    queries.insertEdge({ source: caller.id, target: second!.id, kind: 'references',
      line: 35, column: 8, metadata: { refName: 'feature', refKind: 'function_ref' } });
    expect(() => reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [
      fact('one', 'variant.c', 'feature', 4, 9),
    ]))).toThrow(/semantic identity/);
    expect(queries.getNodesByFile('variant.c').map(node => node.id)).toEqual([first!.id, second!.id]);
    expect(conn.getDb().prepare('SELECT source,target,line,col FROM edges').all()).toEqual([
      { source: caller.id, target: second!.id, line: 35, col: 8 },
    ]);
    expect(conn.getDb().prepare('SELECT node_id FROM semantic_node_configs ORDER BY node_id').all())
      .toEqual([first!.id, second!.id].sort().map(node_id => ({ node_id })));
  });

  it('retains a verified reference when two existing semantic identities directly overlap', () => {
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [
      fact('one', 'variant.c', 'feature', 2, 12),
    ]));
    const original = queries.getNodesByFile('variant.c')[0]!;
    const duplicate = { ...original, id: generateNodeId('variant.c', 'function', 'feature', 5),
      startLine: 5 };
    queries.insertNode(duplicate);
    const caller = baseline('caller.c', 'caller', 30, 40);
    queries.insertNode(caller);
    queries.insertEdge({ source: caller.id, target: duplicate.id, kind: 'references',
      line: 35, column: 8, metadata: { refName: 'feature', refKind: 'function_ref' } });
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [
      fact('one', 'variant.c', 'feature', 2, 12),
    ]));
    expect(queries.getNodesByFile('variant.c').map(node => node.id)).toEqual([original.id]);
    expect(conn.getDb().prepare('SELECT source,target,line,col FROM edges').all()).toEqual([
      { source: caller.id, target: original.id, line: 35, col: 8 },
    ]);
    expect(conn.getDb().prepare('SELECT node_id FROM semantic_node_configs').all())
      .toEqual([{ node_id: original.id }]);
  });

  it('rejects a baseline spanning two disjoint semantic definitions without merging either', () => {
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [
      fact('one', 'variant.c', 'feature', 2, 6),
      fact('one', 'variant.c', 'feature', 7, 11),
    ]));
    const [first, second] = queries.getNodesByFile('variant.c');
    const caller = baseline('caller.c', 'caller', 30, 40);
    queries.insertNode(caller);
    queries.insertEdge({ source: caller.id, target: second!.id, kind: 'references',
      line: 35, column: 8, metadata: { refName: 'feature', refKind: 'function_ref' } });
    const bridge = baseline('variant.c', 'feature', 4, 9);
    expect(() => queries.insertNodes([bridge])).toThrow(/semantic identity/);
    expect(queries.getNodeById(bridge.id)).toBeNull();
    expect(queries.getNodesByFile('variant.c').map(node => node.id)).toEqual([first!.id, second!.id]);
    expect(conn.getDb().prepare('SELECT source,target FROM edges').all())
      .toEqual([{ source: caller.id, target: second!.id }]);
    expect(conn.getDb().prepare('SELECT node_id FROM semantic_node_configs ORDER BY node_id').all())
      .toEqual([first!.id, second!.id].sort().map(node_id => ({ node_id })));
  });

  it('transfers ownership in the bulk ordinary extraction path as well', () => {
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [fact('one', 'variant.c', 'feature', 2, 12)]));
    const extracted = baseline('variant.c', 'feature', 5, 12);
    queries.insertNodes([extracted, baseline('variant.c', 'other', 18, 20)]);
    expect(queries.getNodesByFile('variant.c').map(node => node.id)).toEqual([extracted.id,
      generateNodeId('variant.c', 'function', 'other', 18)]);
    expect(conn.getDb().prepare('SELECT node_id FROM semantic_node_configs').all()).toEqual([{ node_id: extracted.id }]);
  });

  it('reuses baseline ownership before semantic-only overlap and never removes heuristic edges', () => {
    const ordinary = baseline('variant.c', 'feature', 5, 12);
    queries.insertNode(ordinary);
    const caller = baseline('variant.c', 'caller', 18, 24);
    queries.insertNode(caller);
    queries.insertEdge({ source: caller.id, target: ordinary.id, kind: 'calls', provenance: 'heuristic' });
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [fact('one', 'variant.c', 'feature', 2, 12)]));
    expect(queries.getNodesByFile('variant.c').filter(node => node.name === 'feature').map(node => node.id))
      .toEqual([ordinary.id]);
    reconcileCppSemanticNodes(conn.getDb(), queries, collection([], []));
    expect(queries.getNodeById(ordinary.id)?.semanticOrigin).toBeUndefined();
    expect(conn.getDb().prepare('SELECT provenance FROM edges').all()).toEqual([{ provenance: 'heuristic' }]);
  });

  it('only an authoritative fully covered snapshot retires removed configs and orphan clangd facts', () => {
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one', 'two'], [
      fact('one', 'variant.c', 'feature', 2, 12), fact('two', 'variant.c', 'extra', 15, 18),
    ]));
    queries.insertNode(baseline('variant.c', 'baseline_only', 22, 24));
    const keep = collection(['one'], [fact('one', 'variant.c', 'feature', 2, 12)]);
    reconcileCppSemanticNodes(conn.getDb(), queries, { ...keep, inventory: 'advisory',
      views: keep.views.map(view => ({ ...view, inventory: 'advisory' })) });
    expect(queries.getNodesByFile('variant.c')).toHaveLength(3);
    expect(conn.getDb().prepare('SELECT id FROM semantic_configs').all()).toHaveLength(2);
    reconcileCppSemanticNodes(conn.getDb(), queries, { ...keep,
      views: keep.views.map(view => ({ ...view, success: false, failedFiles: ['variant.c'] })) });
    expect(queries.getNodesByFile('variant.c')).toHaveLength(3);
    reconcileCppSemanticNodes(conn.getDb(), queries, keep);
    expect(queries.getNodesByFile('variant.c').map(node => node.name).sort()).toEqual(['baseline_only', 'feature']);
    expect(conn.getDb().prepare('SELECT id FROM semantic_configs').all()).toEqual([{ id: 'one' }]);
  });

  it('retire configs first recorded by advisory only after a later full authoritative snapshot', () => {
    reconcileCppSemanticNodes(conn.getDb(), queries,
      collection(['advisory'], [fact('advisory', 'variant.c', 'obsolete', 2, 6)], 'advisory'));
    expect(queries.getNodesByFile('variant.c').map(node => node.name)).toEqual(['obsolete']);
    reconcileCppSemanticNodes(conn.getDb(), queries, collection([], [], 'advisory'));
    expect(conn.getDb().prepare('SELECT id FROM semantic_configs').all()).toEqual([{ id: 'advisory' }]);
    reconcileCppSemanticNodes(conn.getDb(), queries, collection([], []));
    expect(conn.getDb().prepare('SELECT id FROM semantic_configs').all()).toEqual([]);
    expect(queries.getNodesByFile('variant.c')).toEqual([]);
  });

  it('retires orphan clangd edges without deleting ordinary heuristic relations', () => {
    const caller = baseline('variant.c', 'caller', 2, 9);
    const target = baseline('variant.c', 'target', 12, 18);
    queries.insertNodes([caller, target]);
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], []));
    queries.insertEdge({ source: caller.id, target: target.id, kind: 'calls', line: 4,
      provenance: 'clangd' });
    queries.insertEdge({ source: caller.id, target: target.id, kind: 'calls', line: 5,
      provenance: 'heuristic' });
    const edge = conn.getDb().prepare("SELECT id FROM edges WHERE provenance = 'clangd'").get() as { id: number };
    conn.getDb().prepare('INSERT INTO semantic_edge_configs (edge_id,config_id) VALUES (?,?)').run(edge.id, 'one');
    reconcileCppSemanticNodes(conn.getDb(), queries, collection([], [], 'advisory'));
    expect(conn.getDb().prepare('SELECT provenance FROM edges ORDER BY line').all())
      .toEqual([{ provenance: 'clangd' }, { provenance: 'heuristic' }]);
    reconcileCppSemanticNodes(conn.getDb(), queries, collection([], []));
    expect(conn.getDb().prepare('SELECT provenance FROM edges').all()).toEqual([{ provenance: 'heuristic' }]);
  });

  it('rolls back both graph changes and retired memberships when a fact fails', () => {
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [fact('one', 'variant.c', 'feature', 2, 12)]));
    const before = conn.getDb().prepare('SELECT * FROM semantic_node_configs').all();
    // 注入写入故障，确保先退役旧配置再失败时外层事务仍原样恢复。
    conn.getDb().exec(`
      CREATE TRIGGER fail_new_semantic_fact BEFORE INSERT ON semantic_node_configs
      WHEN NEW.config_id = 'two' BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;
    `);
    expect(() => reconcileCppSemanticNodes(conn.getDb(), queries,
      collection(['two'], [fact('two', 'variant.c', 'extra', 20, 23)]))).toThrow(/simulated write failure/);
    expect(conn.getDb().prepare('SELECT * FROM semantic_node_configs').all()).toEqual(before);
    expect(conn.getDb().prepare('SELECT id FROM semantic_configs').all()).toEqual([{ id: 'one' }]);
    expect(queries.getNodesByFile('variant.c').map(node => node.name)).toEqual(['feature']);
  });

  it('retries only failed refs to a repaired function after invalidating resolver caches', async () => {
    fs.writeFileSync(path.join(directory, 'caller.c'), 'int caller(void) { return feature(); }\n');
    fs.writeFileSync(path.join(directory, 'variant.c'), 'int feature(void) { return 1; }\n');
    const caller = baseline('caller.c', 'caller', 1, 1);
    queries.insertNode(caller);
    queries.insertUnresolvedRefsBatch([
      { fromNodeId: caller.id, referenceName: 'feature', referenceKind: 'calls',
        line: 1, column: 26, filePath: 'caller.c', language: 'c' },
      { fromNodeId: caller.id, referenceName: 'unrelated', referenceKind: 'calls',
        line: 1, column: 30, filePath: 'caller.c', language: 'c' },
    ]);
    const resolver = createResolver(directory, queries);
    await resolver.resolveAndPersistBatched(undefined, 2, undefined, undefined, true);
    expect(queries.getRetryableFailedReferences(['feature'])).toHaveLength(1);
    const repaired = reconcileCppSemanticNodes(conn.getDb(), queries,
      collection(['one'], [fact('one', 'variant.c', 'feature', 1, 1)]));
    expect(repaired.retryNames).toEqual(['feature']);
    resolver.clearCaches();
    await resolver.resolveAndPersistListYielding(queries.getRetryableFailedReferences(repaired.retryNames));
    expect(queries.getRetryableFailedReferences(['feature'])).toEqual([]);
    expect(queries.getRetryableFailedReferences(['unrelated'])).toHaveLength(1);
    expect(queries.getOutgoingEdges(caller.id).filter(edge => edge.kind === 'calls'))
      .toMatchObject([{ target: generateNodeId('variant.c', 'function', 'feature', 1) }]);
  });

  it('preserves exact baseline edge IDs and all verified call-site coordinates across views', () => {
    const caller = baseline('caller.c', 'caller', 10, 30);
    const target = baseline('variant.c', 'feature', 2, 8);
    queries.insertNodes([caller, target]);
    queries.insertEdge({ source: caller.id, target: target.id, kind: 'calls', line: 14,
      column: 4, provenance: 'tree-sitter' });
    queries.insertEdge({ source: caller.id, target: target.id, kind: 'calls', line: 18,
      column: 0, provenance: 'tree-sitter' });
    const original = conn.getDb().prepare('SELECT id FROM edges WHERE line = 14').get() as { id: number };
    const input = collection(['one', 'two'], ['one', 'two'].flatMap(id => [
      fact(id, 'caller.c', 'caller', 10, 30), fact(id, 'variant.c', 'feature', 2, 8),
    ]));
    for (const view of input.views) {
      view.coveredFiles = ['caller.c', 'variant.c'];
      view.analyzedTuCount = 2;
    }
    input.calls = [
      { configId: 'one', caller: fact('one', 'caller.c', 'caller', 10, 30),
        callee: fact('one', 'variant.c', 'feature', 2, 8), callLine: 14, callColumn: 4 },
      { configId: 'two', caller: fact('two', 'caller.c', 'caller', 10, 30),
        callee: fact('two', 'variant.c', 'feature', 2, 8), callLine: 14, callColumn: 4 },
      { configId: 'one', caller: fact('one', 'caller.c', 'caller', 10, 30),
        callee: fact('one', 'variant.c', 'feature', 2, 8), callLine: 18, callColumn: 7 },
      { configId: 'two', caller: fact('two', 'caller.c', 'caller', 10, 30),
        callee: fact('two', 'variant.c', 'feature', 2, 8), callLine: 21, callColumn: 9 },
    ];
    reconcileCppSemanticNodes(conn.getDb(), queries, input);
    const repositioned: number[] = [];
    expect(queries.reconcileCppSemanticCalls(input, count => repositioned.push(count)))
      .toEqual({ added: 2, removed: 1 });
    expect(repositioned).toEqual([1]);
    expect(conn.getDb().prepare('SELECT id,line,col,provenance FROM edges ORDER BY line').all())
      .toEqual([{ id: original.id, line: 14, col: 4, provenance: 'tree-sitter' },
        { id: expect.any(Number), line: 18, col: 7, provenance: 'clangd' },
        { id: expect.any(Number), line: 21, col: 9, provenance: 'clangd' }]);
    expect(conn.getDb().prepare('SELECT config_id FROM semantic_edge_configs WHERE edge_id = ? ORDER BY config_id')
      .all(original.id)).toEqual([{ config_id: 'one' }, { config_id: 'two' }]);
    expect(queries.reconcileCppSemanticCalls(input)).toEqual({ added: 0, removed: 0 });
    input.calls = input.calls.filter(call => call.configId !== 'two' || call.callLine !== 14);
    expect(queries.reconcileCppSemanticCalls({ ...input, inventory: 'advisory' })).toEqual({ added: 0, removed: 0 });
    expect(conn.getDb().prepare('SELECT config_id FROM semantic_edge_configs WHERE edge_id = ? ORDER BY config_id')
      .all(original.id)).toEqual([{ config_id: 'one' }, { config_id: 'two' }]);
    expect(queries.reconcileCppSemanticCalls(input)).toEqual({ added: 0, removed: 0 });
    expect(conn.getDb().prepare('SELECT config_id FROM semantic_edge_configs WHERE edge_id = ?')
      .all(original.id)).toEqual([{ config_id: 'one' }]);
  });

  it('corrects a wrong static target only with complete coverage and retains heuristic dispatch', () => {
    const caller = baseline('caller.c', 'caller', 10, 30);
    const correct = baseline('right.c', 'helper', 2, 7);
    const wrong = baseline('wrong.c', 'helper', 2, 7);
    queries.insertNodes([caller, correct, wrong]);
    queries.insertEdge({ source: caller.id, target: wrong.id, kind: 'calls', line: 16, column: 4 });
    queries.insertEdge({ source: caller.id, target: wrong.id, kind: 'calls', line: 17,
      column: 0, provenance: 'heuristic' });
    const input = collection(['one', 'wrong-view'], [fact('one', 'caller.c', 'caller', 10, 30),
      fact('one', 'right.c', 'helper', 2, 7)]);
    input.views[0]!.coveredFiles = ['caller.c', 'right.c'];
    input.views[0]!.analyzedTuCount = 2;
    input.views[1]!.coveredFiles = [];
    input.views[1]!.failedFiles = ['wrong.c'];
    input.views[1]!.failedTuCount = 1;
    input.views[1]!.analyzedTuCount = 0;
    input.views[1]!.success = false;
    input.calls = [{ configId: 'one', caller: fact('one', 'caller.c', 'caller', 10, 30),
      callee: fact('one', 'right.c', 'helper', 2, 7), callLine: 16, callColumn: 4 }];
    reconcileCppSemanticNodes(conn.getDb(), queries, input);
    const partial = { ...input, inventory: 'advisory' as const };
    expect(queries.reconcileCppSemanticCalls(partial)).toEqual({ added: 1, removed: 0 });
    expect(queries.getOutgoingEdges(caller.id, ['calls'])).toHaveLength(3);
    expect(queries.reconcileCppSemanticCalls(input)).toEqual({ added: 0, removed: 0 });
    input.views[1]!.success = true;
    input.views[1]!.failedFiles = [];
    input.views[1]!.failedTuCount = 0;
    input.views[1]!.coveredFiles = ['wrong.c'];
    input.views[1]!.analyzedTuCount = 1;
    const repositioned: number[] = [];
    expect(queries.reconcileCppSemanticCalls(input, count => repositioned.push(count)))
      .toEqual({ added: 0, removed: 1 });
    expect(repositioned).toEqual([0]);
    expect(queries.getOutgoingEdges(caller.id, ['calls'])).toMatchObject([
      { target: wrong.id, provenance: 'heuristic' },
      { target: correct.id, provenance: 'clangd' },
    ]);
  });

  it('deletes an absent ordinary call only when its caller and callee are both represented and covered', () => {
    const caller = baseline('caller.c', 'caller', 10, 30);
    const target = baseline('variant.c', 'feature', 2, 8);
    queries.insertNodes([caller, target]);
    queries.insertEdge({ source: caller.id, target: target.id, kind: 'calls', line: 16, column: 0 });
    const input = collection(['one'], [fact('one', 'caller.c', 'caller', 10, 30),
      fact('one', 'variant.c', 'feature', 2, 8)]);
    input.views[0]!.coveredFiles = ['caller.c', 'variant.c'];
    input.views[0]!.analyzedTuCount = 2;
    reconcileCppSemanticNodes(conn.getDb(), queries, input);
    input.views[0]!.success = false;
    input.views[0]!.failedFiles = ['caller.c'];
    expect(queries.reconcileCppSemanticCalls(input).removed).toBe(0);
    input.views[0]!.success = true;
    input.views[0]!.failedFiles = [];
    expect(queries.reconcileCppSemanticCalls(input).removed).toBe(1);
    expect(queries.getOutgoingEdges(caller.id, ['calls'])).toEqual([]);
  });

  it('keeps an old call when a callee-only view has symbols but its incoming hierarchy failed', () => {
    const caller = baseline('caller.c', 'caller', 10, 30);
    const target = baseline('callee.c', 'callee', 2, 8);
    const observed = baseline('other.c', 'observed', 2, 8);
    queries.insertNodes([caller, target, observed]);
    queries.insertEdge({ source: caller.id, target: target.id, kind: 'calls', line: 16, column: 4,
      provenance: 'tree-sitter', metadata: { refName: 'callee' } });
    const input = collection(['caller-view', 'callee-view'], [
      fact('caller-view', 'caller.c', 'caller', 10, 30),
      fact('caller-view', 'other.c', 'observed', 2, 8),
      fact('callee-view', 'callee.c', 'callee', 2, 8),
    ]);
    input.views[0]!.coveredFiles = ['caller.c', 'other.c'];
    input.views[0]!.analyzedTuCount = 2;
    input.views[1]!.coveredFiles = [];
    input.views[1]!.failedFiles = ['callee.c'];
    input.views[1]!.failedTuCount = 1;
    input.views[1]!.analyzedTuCount = 0;
    input.views[1]!.success = false;
    input.calls = [{ configId: 'caller-view', caller: fact('caller-view', 'caller.c', 'caller', 10, 30),
      callee: fact('caller-view', 'other.c', 'observed', 2, 8), callLine: 18, callColumn: 3 }];
    reconcileCppSemanticNodes(conn.getDb(), queries, input);
    const original = conn.getDb().prepare('SELECT id FROM edges WHERE target = ?').get(target.id) as { id: number };
    conn.getDb().prepare('INSERT INTO semantic_edge_configs (edge_id,config_id) VALUES (?,?)')
      .run(original.id, 'callee-view');
    expect(queries.reconcileCppSemanticCalls(input)).toEqual({ added: 1, removed: 0 });
    expect(queries.getOutgoingEdges(caller.id, ['calls']))
      .toMatchObject([{ target: target.id, line: 16 }, { target: observed.id, line: 18 }]);
    expect(conn.getDb().prepare('SELECT edge_id,config_id FROM semantic_edge_configs WHERE edge_id = ?').all(original.id))
      .toEqual([{ edge_id: original.id, config_id: 'callee-view' }]);
    // 被调视图成功但不与 caller 的配置相交，仍不能用其零 incoming 推断 caller-view 的边不存在。
    input.views[1]!.success = true;
    input.views[1]!.failedFiles = [];
    input.views[1]!.failedTuCount = 0;
    input.views[1]!.coveredFiles = ['callee.c'];
    input.views[1]!.analyzedTuCount = 1;
    expect(queries.reconcileCppSemanticCalls(input)).toEqual({ added: 0, removed: 0 });
    expect(conn.getDb().prepare('SELECT id FROM edges WHERE target = ?').get(target.id)).toEqual(original);
    expect(queries.getOutgoingEdges(caller.id, ['calls']).find(edge => edge.target === target.id))
      .toMatchObject({ provenance: 'tree-sitter', metadata: { refName: 'callee' } });
  });

  it('does not let an unrelated failed view block an otherwise complete call-site correction', () => {
    const caller = baseline('caller.c', 'caller', 10, 30);
    const target = baseline('callee.c', 'callee', 2, 8);
    queries.insertNodes([caller, target]);
    queries.insertEdge({ source: caller.id, target: target.id, kind: 'calls', line: 16, column: 0 });
    const input = collection(['complete', 'unrelated'], [
      fact('complete', 'caller.c', 'caller', 10, 30),
      fact('complete', 'callee.c', 'callee', 2, 8),
    ]);
    input.views[0]!.coveredFiles = ['caller.c', 'callee.c'];
    input.views[0]!.analyzedTuCount = 2;
    input.views[1]!.coveredFiles = [];
    input.views[1]!.failedFiles = ['unrelated.c'];
    input.views[1]!.failedTuCount = 1;
    input.views[1]!.analyzedTuCount = 0;
    input.views[1]!.success = false;
    input.calls = [{ configId: 'complete', caller: fact('complete', 'caller.c', 'caller', 10, 30),
      callee: fact('complete', 'callee.c', 'callee', 2, 8), callLine: 16, callColumn: 6 }];
    reconcileCppSemanticNodes(conn.getDb(), queries, input);
    expect(queries.reconcileCppSemanticCalls(input)).toEqual({ added: 1, removed: 1 });
    expect(queries.getOutgoingEdges(caller.id, ['calls']))
      .toMatchObject([{ target: target.id, line: 16, column: 6, provenance: 'clangd' }]);
  });

  it('never overwrites an exact heuristic call when its identity matches semantic evidence', () => {
    const caller = baseline('caller.c', 'caller', 10, 30);
    const target = baseline('variant.c', 'feature', 2, 8);
    queries.insertNodes([caller, target]);
    queries.insertEdge({ source: caller.id, target: target.id, kind: 'calls', line: 16,
      column: 4, provenance: 'heuristic' });
    const input = collection(['one'], [fact('one', 'caller.c', 'caller', 10, 30),
      fact('one', 'variant.c', 'feature', 2, 8)]);
    input.views[0]!.coveredFiles = ['caller.c', 'variant.c'];
    input.views[0]!.analyzedTuCount = 2;
    input.calls = [{ configId: 'one', caller: fact('one', 'caller.c', 'caller', 10, 30),
      callee: fact('one', 'variant.c', 'feature', 2, 8), callLine: 16, callColumn: 4 }];
    reconcileCppSemanticNodes(conn.getDb(), queries, input);
    expect(queries.reconcileCppSemanticCalls(input)).toEqual({ added: 0, removed: 0 });
    expect(queries.getOutgoingEdges(caller.id, ['calls']))
      .toMatchObject([{ provenance: 'heuristic', line: 16, column: 4 }]);
    expect(conn.getDb().prepare('SELECT * FROM semantic_edge_configs').all()).toEqual([]);
  });

  it('rolls back a newly inserted semantic edge if membership persistence fails', () => {
    const caller = baseline('caller.c', 'caller', 10, 30);
    const target = baseline('variant.c', 'feature', 2, 8);
    queries.insertNodes([caller, target]);
    const input = collection(['one'], [fact('one', 'caller.c', 'caller', 10, 30),
      fact('one', 'variant.c', 'feature', 2, 8)]);
    input.views[0]!.coveredFiles = ['caller.c', 'variant.c'];
    input.views[0]!.analyzedTuCount = 2;
    input.calls = [{ configId: 'one', caller: fact('one', 'caller.c', 'caller', 10, 30),
      callee: fact('one', 'variant.c', 'feature', 2, 8), callLine: 16, callColumn: 4 }];
    reconcileCppSemanticNodes(conn.getDb(), queries, input);
    conn.getDb().exec(`
      CREATE TRIGGER fail_semantic_edge BEFORE INSERT ON semantic_edge_configs
      BEGIN SELECT RAISE(ABORT, 'simulated edge membership failure'); END;
    `);
    expect(() => queries.reconcileCppSemanticCalls(input)).toThrow(/simulated edge membership failure/);
    expect(queries.getOutgoingEdges(caller.id, ['calls'])).toEqual([]);
    expect(conn.getDb().prepare('SELECT * FROM semantic_edge_configs').all()).toEqual([]);
  });

  it('runs semantic calls before C function-pointer synthesis in an opted-in full index', async () => {
    const source = [
      'struct ops { int (*fn)(void); };',
      '#if FLAG',
      'static int',
      '#else',
      'static long',
      '#endif',
      'handler(void) { return 1; }',
      'static struct ops table = { .fn = handler };',
      'int dispatch(struct ops *o) {',
      '  handler();',
      '  return o->fn();',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(directory, 'test.c'), source);
    fs.writeFileSync(path.join(directory, 'codegraph.json'), JSON.stringify({ cppSemanticRepair: { enabled: true } }));
    fs.writeFileSync(path.join(directory, 'compile_commands.json'), JSON.stringify([{
      directory, file: path.join(directory, 'test.c'), arguments: ['cc', '-c', 'test.c', '-o', 'CMakeFiles/demo.dir/test.c.o'],
      output: 'CMakeFiles/demo.dir/test.c.o',
    }]));
    const extracted = extractFromSource('test.c', source, 'c');
    const handler = fact('one', 'test.c', 'handler', 3, 7);
    const dispatch = extracted.nodes.find(node => node.name === 'dispatch' && node.kind === 'function')!;
    expect(extracted.nodes.some(node => node.name === 'handler' && node.kind === 'function')).toBe(false);
    expect(dispatch).toBeDefined();
    const input = collection(['one'], [
      handler,
      { ...dispatch, kind: 'function', configId: 'one' },
    ]);
    input.views[0]!.coveredFiles = ['test.c'];
    input.calls = [{ configId: 'one',
      caller: { ...dispatch, kind: 'function' }, callee: handler,
      callLine: 10, callColumn: 2 }];
    vi.mocked(collectCppSemanticFacts).mockResolvedValueOnce(input);
    const previous = process.env.CODEGRAPH_CLANGD_PATH;
    process.env.CODEGRAPH_CLANGD_PATH = process.execPath;
    let graph: CodeGraph | undefined;
    try {
      graph = await CodeGraph.init(directory, { silent: true });
      const indexed = await graph.indexAll();
      expect(indexed.success).toBe(true);
      expect(vi.mocked(collectCppSemanticFacts)).toHaveBeenCalledOnce();
      const graphDb = (graph as unknown as { db: DatabaseConnection }).db.getDb();
      expect(graphDb.prepare(`
        SELECT e.line,e.col,e.provenance,json_extract(e.metadata,'$.synthesizedBy') synthesized,
          EXISTS(SELECT 1 FROM semantic_edge_configs c WHERE c.edge_id=e.id) verified
        FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
        WHERE s.name='dispatch' AND t.name='handler' AND e.kind='calls' ORDER BY e.line
      `).all()).toEqual(expect.arrayContaining([
        { line: 10, col: 2, provenance: null, synthesized: null, verified: 1 },
        { line: expect.any(Number), col: null, provenance: 'heuristic', synthesized: 'fn-pointer-dispatch', verified: 0 },
      ]));
    } finally {
      graph?.close();
      if (previous === undefined) delete process.env.CODEGRAPH_CLANGD_PATH;
      else process.env.CODEGRAPH_CLANGD_PATH = previous;
    }
  });

  it('keeps the ordinary resolver synthesis and statistics when semantic repair is disabled', async () => {
    fs.writeFileSync(path.join(directory, 'ordinary.c'), [
      'static int handler(void) { return 1; }',
      'struct ops { int (*fn)(void); };',
      'static struct ops table = { .fn = handler };',
      'int dispatch(struct ops *o) { return o->fn(); }',
      '',
    ].join('\n'));
    vi.mocked(collectCppSemanticFacts).mockClear();
    const graph = await CodeGraph.init(directory, { silent: true });
    try {
      const resolver = (graph as unknown as { resolver: ReturnType<typeof createResolver> }).resolver;
      const base = vi.spyOn(resolver, 'resolveAndPersistBatched');
      const delayed = vi.spyOn(resolver, 'synthesizeDynamicEdges');
      expect((await graph.indexAll()).success).toBe(true);
      expect(base).toHaveBeenCalledOnce();
      expect(base.mock.calls[0]![4]).toBe(false);
      expect(base.mock.results[0]?.type).toBe('return');
      const resolved = await base.mock.results[0]!.value;
      const graphDb = (graph as unknown as { db: DatabaseConnection }).db.getDb();
      const synthesized = graphDb.prepare(`
        SELECT COUNT(*) count FROM edges WHERE provenance = 'heuristic'
          AND json_extract(metadata, '$.synthesizedBy') = 'fn-pointer-dispatch'
      `).get() as { count: number };
      expect(synthesized.count).toBeGreaterThan(0);
      expect(resolved.stats.byMethod['callback-synthesis']).toBeGreaterThan(0);
      expect(delayed).not.toHaveBeenCalled();
      expect(collectCppSemanticFacts).not.toHaveBeenCalled();
    } finally {
      graph.close();
    }
  });
});
