import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { CodeGraph } from '../src';
import { decodeSimpleClangdArgv, EffectiveCompileContext } from '../src/semantic/cpp/clangd-client';
import { collectNativeMacroCalls, nativeReplayArguments } from '../src/semantic/cpp/native-callees';
import { resolveCppSemanticRuntimeOptions } from '../src/project-config';

const runtimeAvailable = fs.existsSync('/usr/bin/clangd-19') && fs.existsSync('/usr/bin/python3') &&
  fs.existsSync('/usr/lib/x86_64-linux-gnu/libclang-19.so.19');
const temporary: string[] = [];
afterEach(() => { for (const file of temporary.splice(0)) fs.rmSync(file, { recursive: true, force: true }); });

/**
 * @brief 构造与真实日志一样的单主文件上下文，用于协议拒绝路径测试。
 * @param[in] mainFile 唯一主文件绝对路径
 * @param[in] flags 调整的参数，仅测试校验，不执行编译器
 * @return 具有确定性测试哈希的上下文
 */
function context(mainFile: string, flags: string[] = []): EffectiveCompileContext {
  return { directory: path.dirname(mainFile), argv: ['/usr/bin/cc', ...flags, '--', mainFile],
    triple: 'x86_64-pc-linux-gnu', clangdVersion: '19.1.7', documentVersion: 1,
    sessionId: 'test', hash: 'a'.repeat(64) };
}

describe('same-session native macro targets', () => {
  it('rejects printArgv ambiguity and implicit execution or additional inputs', () => {
    expect(decodeSimpleClangdArgv('/usr/bin/cc -DOK -- /tmp/main.c')).toHaveLength(4);
    for (const unsafe of ['cc "-DA B"', "cc 'file.c'", 'cc -D\\x41', 'cc\nfile.c'])
      expect(decodeSimpleClangdArgv(unsafe)).toBeNull();
    for (const flags of [['@args'], ['-Xclang', '-load'], ['-fplugin=evil.so'], ['other.c'],
      ['-B/tmp/tool'], ['-mllvm', '-load=evil.so'], ['-include-pch', 'evil.pch']])
      expect(() => nativeReplayArguments(context('/tmp/main.c', flags), '/tmp/main.c')).toThrow();
    expect(nativeReplayArguments(context('/tmp/main.c', ['-DOK', '-std=gnu99']), '/tmp/main.c'))
      .toEqual(['/usr/bin/cc', '-DOK', '-std=gnu99', '/tmp/main.c']);
  });

  it('keeps native executable and library authority outside repository paths and repository configuration', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-trust-')); temporary.push(root);
    const executable = path.join(root, 'tool'); fs.writeFileSync(executable, '#!/bin/false\n'); fs.chmodSync(executable, 0o755);
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ cppSemanticRepair: { enabled: true,
      nativePythonPath: executable, nativeLibclangPath: executable } }));
    const runtime = resolveCppSemanticRuntimeOptions({}, { CODEGRAPH_CLANGD_PATH: '/usr/bin/clangd-19',
      CODEGRAPH_NATIVE_PYTHON_PATH: executable, CODEGRAPH_LIBCLANG_PATH: executable }, root);
    expect(runtime.nativePythonPath).toBeNull(); expect(runtime.nativeLibclangPath).toBeNull();
    const relative = resolveCppSemanticRuntimeOptions({}, { CODEGRAPH_NATIVE_PYTHON_PATH: './tool',
      CODEGRAPH_LIBCLANG_PATH: './tool' }, root);
    expect(relative.nativePythonPath).toBeNull(); expect(relative.nativeLibclangPath).toBeNull();
  });

  it.skipIf(!runtimeAvailable)('persists actual external direct targets and two expansions, then converges across sync and removal', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-target-')); temporary.push(parent);
    const root = path.join(parent, 'project'); fs.mkdirSync(root);
    const external = path.join(parent, 'external.h');
    fs.writeFileSync(external, 'extern void foo(int);\nextern void bar(int);\n');
    const header = path.join(root, 'macros.h');
    const source = path.join(root, 'main.c');
    const saved = { ...process.env };
    process.env.CODEGRAPH_CLANGD_PATH = '/usr/bin/clangd-19';
    delete process.env.CODEGRAPH_COMPILE_COMMANDS;
    delete process.env.CODEGRAPH_CLANGD_QUERY_DRIVERS;
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ cppSemanticRepair: { enabled: true } }));
    fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify([{ directory: root, file: source,
      output: 'build/CMakeFiles/app.dir/main.c.o', arguments: ['/usr/bin/cc', '-c', source] }]));
    fs.writeFileSync(header, `#include "${external}"\n#define EMIT(x) do { foo(x); foo(x); } while(0)\n`);
    fs.writeFileSync(source, '#include "macros.h"\nvoid run(void) { EMIT(1); }\n');
    let graph = await CodeGraph.init(root, { silent: true });
    try {
      await graph.indexAll();
      // 新增声明依赖是本轮正向事实，而不是下一次无变更同步应重试的输入漂移。
      expect(graph.getCppSemanticRepairStatus()?.state).toBe('complete');
      const caller = graph.searchNodes('run')[0]!.node;
      const foo = graph.searchNodes('foo', { kinds: ['function'] }).find(result => result.node.name === 'foo')!.node;
      expect(foo).toMatchObject({ filePath: external, semanticOrigin: 'libclang', startLine: 1 });
      expect(graph.getCallees(caller.id).map(item => item.node.name)).toContain('foo');
      fs.writeFileSync(path.join(root, 'local.c'), 'void foo(int value) { (void)value; }\n');
      await graph.sync();
      const collision = graph.searchNodes('foo', { kinds: ['function'] }).filter(result => result.node.name === 'foo');
      expect(collision.map(result => result.node.filePath)).toEqual(['local.c', external]);
      expect(graph.getCallees(caller.id).filter(item => item.node.name === 'foo').map(item => item.node.filePath))
        .toEqual([external]);
      fs.unlinkSync(path.join(root, 'local.c')); await graph.sync();
      const edge = graph.getCallees(caller.id).find(item => item.edge.provenance === 'libclang')!.edge;
      expect(edge.metadata?.nativeExpansions).toHaveLength(2);
      process.env.CODEGRAPH_NATIVE_PYTHON_PATH = path.join(parent, 'unavailable-interpreter');
      await graph.sync();
      expect(graph.getCppSemanticRepairStatus()).toMatchObject({ state: 'partial', translationUnits: 1, viewsFailed: 0,
        native: { attemptedTus: 1, failedTus: 1 } });
      const partialStatus = graph.getCppSemanticRepairStatus();
      await graph.sync({ skipPartialSemanticRetry: true });
      expect(graph.getCppSemanticRepairStatus()).toEqual(partialStatus);
      expect(graph.getCallees(caller.id).find(item => item.node.name === 'foo')!.edge.metadata?.nativeExpansions)
        .toHaveLength(2);
      delete process.env.CODEGRAPH_NATIVE_PYTHON_PATH;
      fs.writeFileSync(header, `#include "${external}"\n#define EMIT(x) bar(x)\n`);
      await graph.sync();
      expect(graph.searchNodes('foo', { kinds: ['function'] }).filter(result => result.node.name === 'foo')).toEqual([]);
      expect(graph.getCallees(caller.id).map(item => item.node.name)).toContain('bar');
      const barId = graph.searchNodes('bar', { kinds: ['function'] })[0]!.node.id;
      await graph.sync(); expect(graph.searchNodes('bar', { kinds: ['function'] })[0]!.node.id).toBe(barId);
      graph.destroy(); graph = await CodeGraph.recreate(root);
      await graph.indexAll(); expect(graph.searchNodes('bar', { kinds: ['function'] })[0]!.node.id).toBe(barId);
      fs.unlinkSync(external);
      await graph.sync();
      expect(graph.getCppSemanticRepairStatus()?.state).toBe('partial');
      expect(graph.searchNodes('bar', { kinds: ['function'] }).filter(result => result.node.name === 'bar')).toEqual([]);
      fs.writeFileSync(source, 'void run(void) {}\n'); fs.unlinkSync(header);
      await graph.sync();
      expect(graph.searchNodes('bar', { kinds: ['function'] }).filter(result => result.node.name === 'bar')).toEqual([]);
    } finally { graph.destroy(); process.env = saved; }
  }, 30_000);

  it.skipIf(!runtimeAvailable)('exports only physical macro direct calls, not callback arguments, fnptrs or ordinary external calls', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-boundaries-')); temporary.push(parent);
    const root = path.join(parent, 'project'); fs.mkdirSync(root);
    const external = path.join(parent, 'external.h');
    fs.writeFileSync(external, 'extern void direct_sink(int);\nextern void ordinary_sink(int);\nextern void accept(void (*)(void));\n');
    fs.writeFileSync(path.join(root, 'macros.h'), `#include "${external}"\n` +
      '#define LOG(x) direct_sink(x)\n#define SEND(fn) accept(fn)\n#define INDIRECT(fn) fn()\n');
    const source = path.join(root, 'main.c');
    fs.writeFileSync(source, '#include "macros.h"\nvoid callback(void) {}\n' +
      'void run(void (*pointer)(void)) { ordinary_sink(1); LOG(2); SEND(callback); INDIRECT(pointer); }\n');
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ cppSemanticRepair: { enabled: true } }));
    fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify([{ directory: root, file: source,
      output: 'build/CMakeFiles/app.dir/main.c.o', arguments: ['/usr/bin/cc', '-c', source] }]));
    const saved = { ...process.env }; process.env.CODEGRAPH_CLANGD_PATH = '/usr/bin/clangd-19';
    delete process.env.CODEGRAPH_COMPILE_COMMANDS; delete process.env.CODEGRAPH_CLANGD_QUERY_DRIVERS;
    const graph = await CodeGraph.init(root, { silent: true });
    try {
      await graph.indexAll();
      const caller = graph.searchNodes('run', { kinds: ['function'] })[0]!.node;
      const native = graph.getCallees(caller.id).filter(item => item.edge.provenance === 'libclang');
      expect(native.map(item => item.node.name).sort()).toEqual(['accept', 'direct_sink']);
      expect(graph.searchNodes('ordinary_sink', { kinds: ['function'] }).filter(item =>
        item.node.semanticOrigin === 'libclang')).toEqual([]);
      expect(graph.getCppSemanticRepairStatus()?.native?.attemptedTus).toBe(1);
      expect(graph.getCppSemanticRepairStatus()?.native?.visited).toBeLessThan(10000);
    } finally { graph.destroy(); process.env = saved; }
  }, 30_000);

  it.skipIf(!runtimeAvailable)('marks unsupported Paren, scratch and nested macro identities partial without guessing targets', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-unknown-')); temporary.push(parent);
    const root = path.join(parent, 'project'); fs.mkdirSync(root);
    const external = path.join(parent, 'external.h');
    fs.writeFileSync(external, 'extern void direct_sink(void);\n#define DECL(n) extern void n##_sink(void)\nDECL(paste);\n');
    fs.writeFileSync(path.join(root, 'macros.h'), `#include "${external}"\n` +
      '#define PAREN(fn) ((fn)())\n#define SCRATCH() paste_sink()\n#define INNER() direct_sink()\n#define OUTER() INNER()\n');
    const source = path.join(root, 'main.c');
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ cppSemanticRepair: { enabled: true } }));
    fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify([{ directory: root, file: source,
      output: 'build/CMakeFiles/app.dir/main.c.o', arguments: ['/usr/bin/cc', '-c', source] }]));
    const saved = { ...process.env }; process.env.CODEGRAPH_CLANGD_PATH = '/usr/bin/clangd-19';
    delete process.env.CODEGRAPH_COMPILE_COMMANDS; delete process.env.CODEGRAPH_CLANGD_QUERY_DRIVERS;
    let graph: CodeGraph | undefined;
    try {
      for (const [call, reason] of [['PAREN(direct_sink)', 'macro call target unresolved'],
        ['SCRATCH()', 'physical identity'], ['OUTER()', 'definition not represented']] as const) {
        fs.writeFileSync(source, `#include "macros.h"\nvoid run(void) { ${call}; }\n`);
        graph = fs.existsSync(path.join(root, '.codegraph')) ? await CodeGraph.recreate(root) :
          await CodeGraph.init(root, { silent: true });
        await graph.indexAll();
        expect(graph.getCppSemanticRepairStatus()).toMatchObject({ state: 'partial', translationUnits: 1, viewsFailed: 0 });
        expect(graph.getCppSemanticRepairStatus()?.native?.reasons.join('; ')).toContain(reason);
        const caller = graph.searchNodes('run', { kinds: ['function'] })[0]!.node;
        expect(graph.getCallees(caller.id).filter(item => item.edge.provenance === 'libclang')).toEqual([]);
        graph.destroy(); graph = undefined;
      }
    } finally { graph?.destroy(); process.env = saved; }
  }, 30_000);

  it.skipIf(!runtimeAvailable)('bounds native traversal and request candidates without treating exhaustion as absence', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-budget-')); temporary.push(parent);
    const root = path.join(parent, 'project'); fs.mkdirSync(root);
    const external = path.join(parent, 'external.h');
    fs.writeFileSync(external, Array.from({ length: 11000 }, (_unused, index) => `extern void sink_${index}(void);`).join('\n'));
    const header = path.join(root, 'macros.h'); fs.writeFileSync(header, `#include "${external}"\n#define CALL() sink_0()\n`);
    const source = path.join(root, 'main.c'); fs.writeFileSync(source, '#include "macros.h"\nvoid run(void) { CALL(); }\n');
    const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    const runtime = { clangdPath: '/usr/bin/clangd-19', queryDrivers: [], nativePythonPath: '/usr/bin/python3',
      nativeLibclangPath: '/usr/lib/x86_64-linux-gnu/libclang-19.so.19' };
    const macros = [{ id: 'macro', kind: 'constant' as const, name: 'CALL', qualifiedName: 'CALL', language: 'c',
      filePath: 'macros.h', startLine: 2, endLine: 2, startColumn: 0, endColumn: 23, updatedAt: 1 }];
    const result = await collectNativeMacroCalls(root, 'view', source, hash, context(source), runtime, macros,
      [{ line: 2, column: 18 }], []);
    expect(result.complete).toBe(false); expect(result.reason).toContain('AST budget'); expect(result.visited).toBe(10001);
    const tooMany = await collectNativeMacroCalls(root, 'view', source, hash, context(source), runtime,
      Array.from({ length: 513 }, () => macros[0]!), [], []);
    expect(tooMany.reason).toContain('candidate budget'); expect(tooMany.calls).toEqual([]);
    const oversized = await collectNativeMacroCalls(root, 'view', source, hash,
      context(source, Array.from({ length: 2000 }, (_unused, index) => `-DNAME_${index}=${'x'.repeat(150)}`)), runtime, [], [], []);
    expect(oversized.reason).toContain('request byte budget'); expect(oversized.calls).toEqual([]);
  }, 30_000);

  it.skipIf(!runtimeAvailable)('keeps malformed, cancelled and timed-out native output non-authoritative', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-protocol-')); temporary.push(parent);
    const root = path.join(parent, 'project'); fs.mkdirSync(root);
    const source = path.join(root, 'main.c'); fs.writeFileSync(source, 'void run(void) {}\n');
    const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    const interpreter = path.join(parent, 'interpreter');
    const runtime = { clangdPath: '/usr/bin/clangd-19', queryDrivers: [], nativePythonPath: interpreter,
      nativeLibclangPath: '/usr/lib/x86_64-linux-gnu/libclang-19.so.19' };
    for (const [body, expected] of [['print("broken")', 'malformed'],
      ['print("{}")', 'identity or version mismatch'],
      ['print("x" * (3 * 1024 * 1024))', 'byte budget'],
      ['import time; time.sleep(10)', 'timed out']] as const) {
      fs.writeFileSync(interpreter, `#!/usr/bin/python3\n${body}\n`); fs.chmodSync(interpreter, 0o755);
      const result = await collectNativeMacroCalls(root, 'view', source, hash, context(source), runtime, [], [], []);
      expect(result.complete).toBe(false); expect(result.reason).toContain(expected); expect(result.calls).toEqual([]);
    }
    const abort = new AbortController();
    const pending = collectNativeMacroCalls(root, 'view', source, hash, context(source), runtime, [], [], [], abort.signal);
    abort.abort(); expect((await pending).reason).toContain('cancelled');
  }, 15_000);
});
