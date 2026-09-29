import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { generateNodeId } from '../src/extraction/tree-sitter-helpers';
import { reconcileCppSemanticNodes } from '../src/semantic/cpp/reconciler';
import { SemanticFactCollection } from '../src/semantic/cpp';
import { Node } from '../src/types';

describe('C/C++ semantic node reconciliation', () => {
  let directory: string;
  let conn: DatabaseConnection;
  let queries: QueryBuilder;

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
    // 相同行号派生 ID 会碰撞；不安全事实应拒绝写入而不能覆盖首个定义。
    expect(() => reconcileCppSemanticNodes(conn.getDb(), queries,
      collection(['one'], [first, second]))).toThrow(/collides/);
    expect(queries.getNodesByFile('variant.c')).toEqual([]);
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [
      fact('one', 'variant.c', 'static_helper', 2, 3),
      fact('one', 'variant.c', 'static_helper', 8, 9),
    ]));
    expect(queries.getNodesByFile('variant.c')).toHaveLength(2);
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

  it('rejects a disjoint same-ID ordinary replacement without changing old provenance or edges', () => {
    const observed = { ...fact('one', 'variant.c', 'feature', 2, 2), endColumn: 18 };
    reconcileCppSemanticNodes(conn.getDb(), queries, collection(['one'], [observed]));
    const original = queries.getNodesByFile('variant.c')[0]!;
    const caller = baseline('caller.c', 'caller', 30, 40);
    queries.insertNode(caller);
    queries.insertEdge({ source: caller.id, target: original.id, kind: 'references',
      line: 35, column: 8, metadata: { refName: 'feature', refKind: 'function_ref' } });
    const unrelated = { ...baseline('variant.c', 'feature', 2, 2), startColumn: 19, endColumn: 38 };
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
    const unrelated = { ...baseline('variant.c', 'feature', 2, 2), startColumn: 19, endColumn: 38 };
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
});
