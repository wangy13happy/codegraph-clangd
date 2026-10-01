import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

// 与既有 unknown-I/O 回归一致：普通 FS 全部委托真实实现，只开放一个可定向替换的接口。
vi.mock('fs', async importOriginal => ({ ...await importOriginal<typeof import('fs')>() }));

const runtimeAvailable = fs.existsSync('/usr/bin/clangd-19') && fs.existsSync('/usr/bin/python3') &&
  fs.existsSync('/usr/lib/x86_64-linux-gnu/libclang-19.so.19');
const temporary: string[] = [];
const graphs = new Set<CodeGraph>();
let environment: NodeJS.ProcessEnv;

beforeEach(() => {
  environment = { ...process.env };
  process.env.CODEGRAPH_CLANGD_PATH = '/usr/bin/clangd-19';
  process.env.CODEGRAPH_NATIVE_PYTHON_PATH = '/usr/bin/python3';
  process.env.CODEGRAPH_LIBCLANG_PATH = '/usr/lib/x86_64-linux-gnu/libclang-19.so.19';
  delete process.env.CODEGRAPH_COMPILE_COMMANDS;
  delete process.env.CODEGRAPH_CLANGD_QUERY_DRIVERS;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const graph of graphs) graph.destroy();
  graphs.clear();
  process.env = environment;
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/**
 * @brief 创建独立合成项目和项目根外的依赖声明，启用既有语义修复入口。
 * @param[in] declarations 当前测试实际使用的依赖声明源码
 * @return 项目目录和外部声明文件路径；目录由 afterEach 统一回收
 */
function project(declarations: string): { root: string; external: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-complex-')); temporary.push(parent);
  const root = path.join(parent, 'project'); fs.mkdirSync(root);
  const external = path.join(parent, 'dependency.h'); fs.writeFileSync(external, declarations);
  fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ cppSemanticRepair: { enabled: true } }));
  return { root, external };
}

/**
 * @brief 写入实际编译数据库，以 target 及参数区分真实编译视图。
 * @param[in] root 合成项目根目录
 * @param[in] rows 每个 TU 的文件、target 和实际编译参数
 * @return 无；只写入当前合成项目，不执行编译数据库指定的程序
 */
function commands(root: string, rows: Array<{ file: string; target: string; flags?: string[] }>): void {
  fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify(rows.map(row => ({
    directory: root, file: path.join(root, row.file),
    output: `build/CMakeFiles/${row.target}.dir/${row.file}.o`,
    arguments: ['/usr/bin/cc', ...(row.flags ?? []), '-c', path.join(root, row.file)],
  }))));
}

/**
 * @brief 通过真实产品索引入口建立合成图，并登记资源清理。
 * @param[in] root 合成项目根目录
 * @return 已完成 indexAll 的 CodeGraph；测试失败时仍由 afterEach 释放
 */
async function indexed(root: string): Promise<CodeGraph> {
  const graph = await CodeGraph.init(root, { silent: true }); graphs.add(graph);
  await graph.indexAll();
  return graph;
}

/**
 * @brief 查询唯一合成 caller 的原生宏调用，不让同名检索结果代替语义关系。
 * @param[in] graph 当前合成项目图
 * @param[in] name caller 的完整标识符
 * @return 由 libclang provenance 证明的出边及目标节点
 */
function nativeCalls(graph: CodeGraph, name: string): ReturnType<CodeGraph['getCallees']> {
  const callers = graph.searchNodes(name, { kinds: ['function'] }).filter(item => item.node.name === name);
  expect(callers).toHaveLength(1);
  return graph.getCallees(callers[0]!.node.id).filter(item => item.edge.provenance === 'libclang');
}

/**
 * @brief 读取一条图边完整的宏展开支持，用于核验配置及物理出处。
 * @param[in] call 真实 graph API 返回的调用结果
 * @return 各个展开支持的真实配置身份和物理声明来源
 */
function expansions(call: ReturnType<CodeGraph['getCallees']>[number]):
  Array<{ configId: string; usr: string; declarationFile: string; translationUnit: string }> {
  const evidence = call.edge.metadata?.nativeExpansions;
  expect(Array.isArray(evidence)).toBe(true);
  return evidence as Array<{ configId: string; usr: string; declarationFile: string; translationUnit: string }>;
}

describe('complex PR6 semantic lifecycle regressions', () => {
  it.skipIf(!runtimeAvailable)('retargets conditional macros across two TUs and views without retiring independent support', async () => {
    const { root, external } = project('extern void alpha_sink(int);\nextern void beta_sink(int);\n');
    fs.writeFileSync(path.join(root, 'dispatch.h'), `#include "${external}"\n#if CHOICE\n` +
      '#define DISPATCH(x) alpha_sink(x)\n#else\n#define DISPATCH(x) beta_sink(x)\n#endif\n');
    for (const file of ['left', 'right']) fs.writeFileSync(path.join(root, `${file}.c`),
      `#include "dispatch.h"\nvoid ${file}(void) { DISPATCH(1); }\n`);
    const rows = [0, 1].flatMap(choice => ['left.c', 'right.c'].map(file => ({
      file, target: `choice${choice}`, flags: [`-DCHOICE=${choice}`],
    })));
    commands(root, rows);
    const graph = await indexed(root);
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('complete');
    const stable = new Map<string, number>();
    for (const caller of ['left', 'right']) {
      const calls = nativeCalls(graph, caller);
      expect(calls.map(call => call.node.name).sort()).toEqual(['alpha_sink', 'beta_sink']);
      expect(calls.every(call => call.node.filePath === external)).toBe(true);
      expect(calls.every(call => expansions(call).length === 1)).toBe(true);
      expect(new Set(calls.flatMap(call => expansions(call).map(item => item.configId))).size).toBe(2);
      stable.set(caller, calls.find(call => call.node.name === 'beta_sink')!.edge.id);
    }
    expect(graph.searchNodes('alpha_sink', { kinds: ['function'] })).toHaveLength(1);
    expect(graph.searchNodes('beta_sink', { kinds: ['function'] })).toHaveLength(1);

    // 改动一个真实 view 的参数：旧目标退役，原未变 view 的边及新的独立支持同时存活。
    commands(root, rows.map(row => ({ ...row, flags: ['-DCHOICE=0'] })));
    await graph.sync();
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('complete');
    expect(graph.searchNodes('alpha_sink', { kinds: ['function'] })).toEqual([]);
    for (const caller of ['left', 'right']) {
      const calls = nativeCalls(graph, caller);
      expect(calls).toHaveLength(1); expect(calls[0]!.node.name).toBe('beta_sink');
      expect(calls[0]!.edge.id).toBe(stable.get(caller));
      expect(expansions(calls[0]!)).toHaveLength(2);
      expect(new Set(expansions(calls[0]!).map(item => item.configId)).size).toBe(2);
    }
    commands(root, rows.filter(row => row.target === 'choice0'));
    await graph.sync();
    for (const caller of ['left', 'right']) {
      const calls = nativeCalls(graph, caller);
      expect(calls).toHaveLength(1); expect(calls[0]!.edge.id).toBe(stable.get(caller));
      expect(expansions(calls[0]!)).toHaveLength(1);
    }
  }, 30_000);

  it.skipIf(!runtimeAvailable)('retires a shared external stub only after its last caller, preserving a local same-name definition', async () => {
    const { root, external } = project('extern void shared_sink(int);\n');
    fs.writeFileSync(path.join(root, 'emit.h'), `#include "${external}"\n#define EMIT(x) shared_sink(x)\n`);
    for (const file of ['first', 'second']) fs.writeFileSync(path.join(root, `${file}.c`),
      `#include "emit.h"\nvoid ${file}(void) { EMIT(1); }\n`);
    fs.writeFileSync(path.join(root, 'local.c'), 'void shared_sink(int value) { (void)value; }\n');
    commands(root, ['first.c', 'second.c'].map(file => ({ file, target: 'shared' })));
    const graph = await indexed(root);
    const matches = graph.searchNodes('shared_sink', { kinds: ['function'] });
    expect(matches.map(match => match.node.filePath)).toEqual(['local.c', external]);
    const localId = matches[0]!.node.id, stubId = matches[1]!.node.id;
    expect(nativeCalls(graph, 'first').map(call => call.node.id)).toEqual([stubId]);
    const surviving = nativeCalls(graph, 'second');
    expect(surviving.map(call => call.node.id)).toEqual([stubId]);
    const edgeId = surviving[0]!.edge.id;

    fs.writeFileSync(path.join(root, 'first.c'), '#include "emit.h"\nvoid first(void) {}\n');
    await graph.sync();
    expect(nativeCalls(graph, 'first')).toEqual([]);
    expect(nativeCalls(graph, 'second').map(call => [call.node.id, call.edge.id])).toEqual([[stubId, edgeId]]);
    expect(graph.searchNodes('shared_sink', { kinds: ['function'] }).map(match => match.node.id)).toEqual([localId, stubId]);
    fs.writeFileSync(path.join(root, 'second.c'), '#include "emit.h"\nvoid second(void) {}\n');
    await graph.sync();
    expect(nativeCalls(graph, 'second')).toEqual([]);
    expect(graph.searchNodes('shared_sink', { kinds: ['function'] }).map(match => match.node.id)).toEqual([localId]);
  }, 30_000);

  it.skipIf(!runtimeAvailable)('removes and restores only the affected canonical USR at one external physical declaration', async () => {
    const { root, external } = project('#if WIDE\ntypedef long number;\n#else\ntypedef int number;\n#endif\nextern void typed_sink(number);\n');
    fs.writeFileSync(path.join(root, 'call.h'), `#include "${external}"\n#define SEND(x) typed_sink(x)\n`);
    fs.writeFileSync(path.join(root, 'caller.cpp'), '#include "call.h"\nvoid caller() { SEND(1); }\n');
    const rows = [0, 1].map(wide => ({ file: 'caller.cpp', target: `width${wide}`, flags: [`-DWIDE=${wide}`] }));
    commands(root, rows);
    let graph = await indexed(root);
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('complete');
    const original = nativeCalls(graph, 'caller');
    expect(original).toHaveLength(2);
    expect(original.every(call => call.node.filePath === external && call.node.startLine === 6)).toBe(true);
    const usrs = original.map(call => expansions(call)[0]!.usr);
    expect(usrs.every(usr => usr.length > 0)).toBe(true); expect(new Set(usrs).size).toBe(2);
    const identities = original.map(call => call.node.id).sort();

    commands(root, [rows[0]!]); await graph.sync();
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('complete');
    const single = nativeCalls(graph, 'caller');
    expect(single).toHaveLength(1);
    expect(identities).toContain(single[0]!.node.id);
    const survivingId = single[0]!.node.id, survivingEdge = single[0]!.edge.id;
    expect(graph.searchNodes('typed_sink', { kinds: ['function'] }).map(match => match.node.id)).toEqual([survivingId]);
    commands(root, rows); await graph.sync();
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('complete');
    expect(nativeCalls(graph, 'caller').map(call => call.node.id).sort()).toEqual(identities);
    expect(nativeCalls(graph, 'caller').find(call => call.node.id === survivingId)!.edge.id).toBe(survivingEdge);

    // 同一数据库生命周期重建须收敛到同一语义身份集合，而非靠当前插入顺序维持。
    graph.destroy(); graphs.delete(graph); graph = await CodeGraph.recreate(root); graphs.add(graph);
    await graph.indexAll();
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('complete');
    expect(nativeCalls(graph, 'caller').map(call => call.node.id).sort()).toEqual(identities);
    expect(new Set(nativeCalls(graph, 'caller').map(call => expansions(call)[0]!.usr)).size).toBe(2);
  }, 30_000);

  it.skipIf(!runtimeAvailable)('keeps three conditional typedef alternatives while -D and -U activate only the real bindings', async () => {
    const { root } = project('');
    const header = path.join(root, 'events.h');
    const source = '#ifndef EVENTS_H\n#define EVENTS_H\n#if defined(OLD_API)\n' +
      'typedef void (*Callback)(int);\n#elif defined(WIDE_API)\ntypedef void (*Callback)(long);\n' +
      '#else\ntypedef void (*Callback)(int, const char *);\n#endif\n#endif\n';
    fs.writeFileSync(header, source);
    fs.writeFileSync(path.join(root, 'client.c'), '#include "events.h"\nCallback handler;\n');
    const rows = [
      { file: 'client.c', target: 'selected', flags: ['-DOLD_API', '-DWIDE_API', '-UOLD_API'] },
      { file: 'client.c', target: 'default', flags: [] as string[] },
    ];
    commands(root, rows);
    const graph = await indexed(root);
    const alternatives = graph.searchNodes('Callback', { kinds: ['type_alias'] }).filter(match => match.node.name === 'Callback');
    expect(alternatives).toHaveLength(3);
    const contexts = alternatives.map(match => graph.getCppTypedefContext(match.node.id)!).sort((a, b) => a.startLine - b.startLine);
    expect(contexts.every(item => item !== null)).toBe(true);
    expect(contexts.map(item => item.startLine)).toEqual([4, 6, 8]);
    expect(contexts.map(item => [item.sourceStartLine, item.sourceEndLine])).toEqual([[3, 9], [3, 9], [3, 9]]);
    expect(contexts[0]!.conditions).toContain('#if defined(OLD_API)');
    expect(contexts[1]!.conditions).toContain('#elif defined(WIDE_API)');
    expect(contexts[2]!.conditions).toContain('#else');
    expect(contexts.map(item => item.activeConfigIds.length)).toEqual([0, 1, 1]);
    expect(contexts.every(item => item.retainedConfigIds.length === 0)).toBe(true);
    expect(new Set(contexts.flatMap(item => item.activeConfigIds)).size).toBe(2);
    const wideId = contexts[1]!.nodeId;
    commands(root, [{ ...rows[0]!, flags: ['-DOLD_API'] }, rows[1]!]); await graph.sync();
    expect(contexts.map(item => graph.getCppTypedefContext(item.nodeId)!.activeConfigIds.length)).toEqual([1, 0, 1]);
    expect(contexts.map(item => graph.getCppTypedefContext(item.nodeId)!.retainedConfigIds.length)).toEqual([0, 0, 0]);

    // 删除 inactive alternative 时保留其余声明的物理行号，明确验证旧结构事实被清理。
    fs.writeFileSync(header, source.replace('#elif defined(WIDE_API)\ntypedef void (*Callback)(long);', '\n'));
    await graph.sync();
    expect(graph.getCppTypedefContext(wideId)).toBeNull();
    const remaining = graph.searchNodes('Callback', { kinds: ['type_alias'] }).filter(match => match.node.name === 'Callback');
    expect(remaining).toHaveLength(2);
    expect(remaining.map(match => graph.getCppTypedefContext(match.node.id)!.activeConfigIds.length)).toEqual([1, 1]);
  }, 30_000);

  it.skipIf(!runtimeAvailable)('retains shared external support through declaration EACCES and unavailable native runtime, then recovers', async () => {
    const { root, external } = project('extern void observed_sink(int);\n');
    fs.writeFileSync(path.join(root, 'observe.h'), `#include "${external}"\n#define OBSERVE(x) observed_sink(x)\n`);
    for (const file of ['observer_a', 'observer_b']) fs.writeFileSync(path.join(root, `${file}.c`),
      `#include "observe.h"\nvoid ${file}(void) { OBSERVE(1); }\n`);
    commands(root, ['observer_a.c', 'observer_b.c'].map(file => ({ file, target: 'observe' })));
    const graph = await indexed(root);
    const before = ['observer_a', 'observer_b'].map(name => nativeCalls(graph, name));
    expect(before.every(calls => calls.length === 1)).toBe(true);
    expect(new Set(before.map(calls => calls[0]!.node.id)).size).toBe(1);
    const stat = fs.statSync;
    // 不改物理字节。用户侧 runtime 不可用改变已知索引输入，触发真实 sync 补证；
    // 声明核验同时遇到 EACCES，不能把这两个 unknown 当作依赖不存在而清空共享支持。
    process.env.CODEGRAPH_NATIVE_PYTHON_PATH = path.join(path.dirname(root), 'unavailable-interpreter');
    const denied = vi.spyOn(fs, 'statSync').mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
      if (args[0] === external) throw Object.assign(new Error('synthetic declaration access denied'), { code: 'EACCES' });
      return Reflect.apply(stat, fs, args);
    }) as typeof fs.statSync);
    try {
      for (let retry = 0; retry < 2; retry++) {
        await graph.sync();
        // 采集发生 native 局部失败；公开状态还会核验当前声明指纹，EACCES 使其显示 stale。
        // 不能把正向旧证据仍存在误标为 complete，也不能只检查存在而忽略失败覆盖统计。
        expect(graph.getCppSemanticRepairStatus()).toMatchObject({ state: 'stale', viewsFailed: 0,
          native: { attemptedTus: 2, failedTus: 2 } });
        expect(graph.getCppSemanticRepairStatus()?.reason).toBe('semantic repair inputs changed; run codegraph sync');
        expect(denied.mock.calls.some(([file]) => file === external)).toBe(true);
        for (const [index, name] of ['observer_a', 'observer_b'].entries()) {
          const calls = nativeCalls(graph, name);
          expect(calls).toHaveLength(1);
          expect([calls[0]!.node.id, calls[0]!.edge.id]).toEqual([before[index]![0]!.node.id, before[index]![0]!.edge.id]);
          expect(expansions(calls[0]!)).toEqual(expansions(before[index]![0]!));
        }
      }
    } finally {
      denied.mockRestore();
      process.env.CODEGRAPH_NATIVE_PYTHON_PATH = '/usr/bin/python3';
    }
    await graph.sync();
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('complete');
    expect(graph.searchNodes('observed_sink', { kinds: ['function'] })).toHaveLength(1);
    for (const name of ['observer_a', 'observer_b']) expect(expansions(nativeCalls(graph, name)[0]!)).toHaveLength(1);
    for (const file of ['observer_a', 'observer_b']) fs.writeFileSync(path.join(root, `${file}.c`), `void ${file}(void) {}\n`);
    await graph.sync();
    expect(graph.searchNodes('observed_sink', { kinds: ['function'] })).toEqual([]);
  }, 30_000);

  it('uses row, column and ID tie-breaks after filtering large candidate sets in either insertion order', () => {
    for (const reverse of [false, true]) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-complex-ranking-')); temporary.push(directory);
      const connection = DatabaseConnection.initialize(path.join(directory, 'graph.db'));
      try {
        const queries = new QueryBuilder(connection.getDb());
        const indices = Array.from({ length: 150 }, (_unused, index) => index);
        const order = reverse ? [...indices].reverse() : indices;
        for (const index of order) queries.insertNode({
          id: `candidate-${String(index).padStart(3, '0')}`, name: 'ValidatePacketDigest', qualifiedName: 'ValidatePacketDigest',
          filePath: 'shared.ts', kind: 'function', language: 'typescript',
          startLine: Math.floor(index / 6) + 1, endLine: 30, startColumn: Math.floor((index % 6) / 2), endColumn: 40, updatedAt: 1,
        });
        // 干扰候选名称完全相同且路径优先；只有 kind/language 的真实过滤能阻止预算饥饿。
        for (let index = 0; index < 250; index++) queries.insertNode({
          id: `noise-${index}`, name: 'ValidatePacketDigest', qualifiedName: 'ValidatePacketDigest',
          filePath: `a-noise-${index}.${index % 2 ? 'ts' : 'c'}`,
          kind: index % 2 ? 'type_alias' : 'function', language: index % 2 ? 'typescript' : 'c',
          startLine: 1, endLine: 2, startColumn: 0, endColumn: 20, updatedAt: 1,
        });
        for (const limit of [1, 5, 25]) {
          const expected = indices.slice(0, limit).map(index => `candidate-${String(index).padStart(3, '0')}`);
          const query = 'kind:function lang:typescript Digest';
          expect(queries.searchNodes(query, { limit }).map(result => result.node.id)).toEqual(expected);
          expect(queries.searchNodes(query, { limit }).map(result => result.node.id)).toEqual(expected);
          expect(queries.searchNodes('Digest', { limit, kinds: ['function'], languages: ['typescript'] })
            .map(result => result.node.id)).toEqual(expected);
        }
        queries.updateNode({ ...queries.getNodeById('candidate-149')!, startLine: 1, startColumn: 0 });
        expect(queries.searchNodes('kind:function lang:typescript Digest', { limit: 5 }).map(result => result.node.id))
          .toEqual(['candidate-000', 'candidate-001', 'candidate-149', 'candidate-002', 'candidate-003']);
      } finally { connection.close(); }
    }
  });
});
