import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadCompilationDatabase } from '../src/semantic/cpp/compile-database';
import { ClangdClient } from '../src/semantic/cpp/clangd-client';
import { buildCompileViews, collectCppSemanticFacts, materializeCompileView, projectFileFromUri } from '../src/semantic/cpp';
import { normalizeLspPosition } from '../src/semantic/cpp/facts';
import { pathToFileURL } from 'url';

const fixture = path.join(__dirname, 'fixtures', 'cpp-semantic-repair');
const realClangd = ['/usr/bin/clangd-19', '/usr/bin/clangd', '/usr/local/bin/clangd']
  .find(candidate => fs.existsSync(candidate));

describe('C/C++ semantic fact collector', () => {
  let root: string;
  let executable: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-facts-'));
    for (const name of ['variant.c', 'static-a.c', 'static-b.c', 'static-conditional.c',
      'callee.c', 'caller.c', 'fake-clangd.cjs']) {
      fs.copyFileSync(path.join(fixture, name), path.join(root, name));
    }
    executable = path.join(root, 'fake-clangd.cjs');
    fs.chmodSync(executable, 0o755);
  });

  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  /**
   * @brief 构造具有 CMake target 证据的测试编译命令。
   * @param[in] file 测试源文件名
   * @param[in] target 构建目标名
   * @param[in] flags 编译宏参数
   * @return compilation database 的单条命令
   */
  function entry(file: string, target: string, flags: string[] = []) {
    const output = `build/CMakeFiles/${target}.dir/${file}.o`;
    return { directory: root, file, arguments: ['nonexistent-cross-gcc', ...flags, '-c', file, '-o', output], output };
  }

  /**
   * @brief 写入测试数据库并通过 PR1 共享解析器加载。
   * @param[in] rows 编译命令数组
   * @return 已验证并过滤项目源文件的数据库
   */
  function database(rows: ReturnType<typeof entry>[]) {
    fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify(rows));
    const parsed = loadCompilationDatabase(root);
    expect(parsed).not.toBeNull();
    return parsed!;
  }

  it('preserves compile variants, duplicate commands, conditional signatures, static identity and invocation positions', async () => {
    const db = database([entry('variant.c', 'one', ['-DVARIANT_ONE']),
      entry('variant.c', 'one', ['-DVARIANT_ONE']), entry('static-a.c', 'one'),
      entry('variant.c', 'two', ['-DVARIANT_TWO']), entry('static-b.c', 'two')]);
    expect(db.inventory).toBe('authoritative');
    const views = buildCompileViews(db);
    expect(views).toHaveLength(2);
    expect(views.find(v => v.key === 'cmake:one')?.entries).toHaveLength(3);
    const generated = materializeCompileView(root, views[0]!);
    expect(JSON.parse(fs.readFileSync(path.join(generated, 'compile_commands.json'), 'utf8'))).toHaveLength(3);
    expect(buildCompileViews({ ...db, entries: [...db.entries].reverse() }).map(v => v.id)).toEqual(views.map(v => v.id));

    const result = await collectCppSemanticFacts(root, db, { clangdPath: executable, queryDrivers: [] });
    expect(result.views.map(v => v.success)).toEqual([true, true]);
    expect(result.views.map(v => v.analyzedTuCount)).toEqual([2, 2]);
    expect(result.symbols.filter(s => s.name === 'feature').map(s => s.signature).sort())
      .toEqual(['int feature(int value)', 'int feature(void)']);
    expect(result.symbols.filter(s => s.name === 'helper').map(s => s.filePath).sort())
      .toEqual(['static-a.c', 'static-b.c']);
    expect(result.symbols.some(s => s.name === 'only_declaration')).toBe(false);
    expect(result.calls).toHaveLength(2);
    for (const call of result.calls) {
      expect(call.caller.name).toBe('invoke');
      expect(call.callee.name).toBe('feature');
      expect(call.callLine).toBeGreaterThan(1);
      expect(call.callColumn).toBe(call.callLine === 18 ? 24 : 11);
      expect(call.callee.startLine).toBeGreaterThan(1);
      expect(call.caller.filePath).toBe('variant.c');
    }
    for (const view of result.views) {
      const pid = Number(fs.readFileSync(path.join(root, '.codegraph', 'semantic', 'compile-db', view.id, 'fake.pid'), 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
    }
  });

  it('classifies conflicting target/TU commands and fallback grouping as non-destructive advisory', () => {
    const db = database([entry('variant.c', 'same', ['-DVARIANT_ONE']),
      entry('variant.c', 'same', ['-DVARIANT_TWO']),
      { directory: root, file: 'static-a.c', arguments: ['nonexistent-cross-gcc', '-c', 'static-a.c'], output: '' }]);
    expect(db.inventory).toBe('advisory');
    const views = buildCompileViews(db);
    expect(views).toHaveLength(3);
    expect(views.every(v => v.inventory === 'advisory')).toBe(true);
    expect(views.filter(v => v.key.startsWith('cmake:same:'))).toHaveLength(2);
    expect(views.find(v => v.key.startsWith('flags:'))?.grouping).toBe('semantic-flags');
  });

  it.skipIf(!realClangd)('keeps conditional same-file static identities at distinct source ranges', async () => {
    const db = database([entry('static-conditional.c', 'one', ['-DVARIANT_ONE']),
      entry('static-conditional.c', 'two', ['-DVARIANT_TWO'])]);
    const result = await collectCppSemanticFacts(root, db, { clangdPath: realClangd!, queryDrivers: [] },
      { requestTimeoutMs: 8000 });
    expect(result.views.every(v => v.success)).toBe(true);
    expect(result.symbols.filter(s => s.name === 'helper').map(s => [s.filePath, s.startLine]).sort())
      .toEqual([['static-conditional.c', 2], ['static-conditional.c', 4]]);
  }, 30_000);

  it.skipIf(!realClangd)('resolves incoming calls between TUs in one build target', async () => {
    const db = database([entry('callee.c', 'shared'), entry('caller.c', 'shared')]);
    const result = await collectCppSemanticFacts(root, db, { clangdPath: realClangd!, queryDrivers: [] },
      { requestTimeoutMs: 8000 });
    expect(result.views[0]?.success).toBe(true);
    expect(result.calls.filter(c => c.callee.name === 'external_target'))
      .toMatchObject([{ caller: { filePath: 'caller.c', name: 'from_other' }, callLine: 2, callColumn: 30 }]);
  }, 30_000);

  it('waits for delayed cross-TU indexing before treating empty incoming calls as coverage', async () => {
    const db = database([entry('callee.c', 'shared', ['-DDELAY_INDEX']), entry('caller.c', 'shared')]);
    const directory = materializeCompileView(root, buildCompileViews(db)[0]!);
    const client = new ClangdClient(root, directory, { clangdPath: executable, queryDrivers: [] }, undefined, 2000);
    const callee = pathToFileURL(path.join(root, 'callee.c')).href;
    const caller = pathToFileURL(path.join(root, 'caller.c')).href;
    try {
      await client.start();
      client.didOpen(callee, 'c', fs.readFileSync(path.join(root, 'callee.c'), 'utf8'));
      client.didOpen(caller, 'c', fs.readFileSync(path.join(root, 'caller.c'), 'utf8'));
      const [symbol] = await client.documentSymbols(callee);
      if (!symbol || !('selectionRange' in symbol)) throw new Error('Fixture did not provide a hierarchical function symbol');
      const [item] = await client.prepareCallHierarchy(callee, symbol.selectionRange.start);
      expect(await client.incomingCalls(item!)).toEqual([]);
      await client.waitForIndex();
      expect(client.hasCleanDiagnostics(callee)).toBe(true);
      expect(client.hasCleanDiagnostics(caller)).toBe(true);
      expect((await client.incomingCalls(item!))[0]?.from.name).toBe('from_other');
    } finally { await client.close(); }
    const result = await collectCppSemanticFacts(root, db, { clangdPath: executable, queryDrivers: [] });
    expect(result.views[0]?.success).toBe(true);
    expect(result.views[0]?.coveredFiles).toEqual(['callee.c', 'caller.c']);
    expect(result.calls.filter(c => c.callee.name === 'external_target'))
      .toMatchObject([{ caller: { filePath: 'caller.c', name: 'from_other' }, callLine: 2, callColumn: 30 }]);
  }, 10_000);

  it('retains positive facts but rejects negative coverage without sync or with errors', async () => {
    for (const flag of ['-DNO_SYNC', '-DDIAG_ERROR']) {
      const db = database([entry('variant.c', 'one', [flag])]);
      const result = await collectCppSemanticFacts(root, db, { clangdPath: executable, queryDrivers: [] });
      expect(result.views[0]?.success).toBe(false);
      expect(result.views[0]?.failedFiles).toEqual(['variant.c']);
      expect(result.symbols.some(s => s.name === 'feature')).toBe(true);
      expect(result.calls.some(c => c.callee.name === 'feature')).toBe(true);
    }
  });

  it('treats warning-only diagnostics as a completed scope', async () => {
    const db = database([entry('variant.c', 'one', ['-DDIAG_WARNING'])]);
    const result = await collectCppSemanticFacts(root, db, { clangdPath: executable, queryDrivers: [] });
    expect(result.views[0]?.success).toBe(true);
    expect(result.views[0]?.coveredFiles).toEqual(['variant.c']);
  });

  it('limits diagnostic errors to the affected TU while retaining other covered files', async () => {
    const db = database([entry('callee.c', 'shared'), entry('caller.c', 'shared', ['-DDIAG_ERROR'])]);
    const result = await collectCppSemanticFacts(root, db, { clangdPath: executable, queryDrivers: [] });
    expect(result.views[0]?.success).toBe(false);
    expect(result.views[0]?.coveredFiles).toEqual(['callee.c']);
    expect(result.views[0]?.failedFiles).toEqual(['caller.c']);
    expect(result.calls.some(c => c.caller.filePath === 'caller.c')).toBe(true);
  });

  it('bounds a hung sync request and marks the affected view incomplete', async () => {
    const db = database([entry('variant.c', 'good'), entry('variant.c', 'hung', ['-DHANG_SYNC'])]);
    const started = Date.now();
    const result = await collectCppSemanticFacts(root, db, { clangdPath: executable, queryDrivers: [] },
      { requestTimeoutMs: 250 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.views.find(v => v.key === 'cmake:good')?.success).toBe(true);
    expect(result.views.find(v => v.key === 'cmake:hung')?.success).toBe(false);
    expect(result.views.find(v => v.key === 'cmake:hung')?.failedFiles).toEqual(['variant.c']);
    expect(result.symbols.some(s => s.configId === result.views.find(v => v.key === 'cmake:good')?.id)).toBe(true);
  });

  it('keeps sync bounded without truncating an explicit budget across two sequential idle phases', async () => {
    const db = database([entry('variant.c', 'multi', ['-DMULTI_STAGE_SYNC'])]);
    const directory = materializeCompileView(root, buildCompileViews(db)[0]!);
    const client = new ClangdClient(root, directory, { clangdPath: executable, queryDrivers: [] }, undefined, 90_000);
    try {
      await client.start();
      const uri = pathToFileURL(path.join(root, 'variant.c')).href;
      client.didOpen(uri, 'c', fs.readFileSync(path.join(root, 'variant.c'), 'utf8'));
      const timer = vi.spyOn(globalThis, 'setTimeout');
      try {
        await client.waitForIndex();
        // 旧实现会把 90_000ms 截断到 65_000ms；只监视这一条 sync 请求的计时器。
        expect(timer.mock.calls.some(call => call[1] === 90_000)).toBe(true);
      } finally { timer.mockRestore(); }
    } finally { await client.close(); }

    const defaultClient = new ClangdClient(root, directory, { clangdPath: executable, queryDrivers: [] });
    try {
      await defaultClient.start();
      const timer = vi.spyOn(globalThis, 'setTimeout');
      try {
        await defaultClient.waitForIndex();
        expect(timer.mock.calls.some(call => typeof call[1] === 'number' &&
          call[1] >= 8 * 60_000 && call[1] <= 10 * 60_000)).toBe(true);
      } finally { timer.mockRestore(); }
    } finally { await defaultClient.close(); }

    const started = Date.now();
    const result = await collectCppSemanticFacts(root, db, { clangdPath: executable, queryDrivers: [] },
      { requestTimeoutMs: 500 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(result.views[0]?.success).toBe(true);
    expect(result.views[0]?.coveredFiles).toEqual(['variant.c']);
  }, 10_000);

  it('keeps positive facts and marks only the failed view incomplete', async () => {
    const db = database([entry('variant.c', 'good', ['-DVARIANT_ONE']),
      entry('variant.c', 'bad', ['-DFAIL_VIEW'])]);
    const result = await collectCppSemanticFacts(root, db, { clangdPath: executable, queryDrivers: [] });
    expect(result.views.map(v => v.success).sort()).toEqual([false, true]);
    expect(result.views.find(v => !v.success)?.failedFiles).toEqual(['variant.c']);
    expect(result.views.find(v => !v.success)?.failedTuCount).toBe(1);
    expect(result.symbols.some(s => s.name === 'feature')).toBe(true);
  });

  it('bounds hung requests, propagates cancellation and reaps the process', async () => {
    const db = database([entry('variant.c', 'hung', ['-DHANG_VIEW'])]);
    const start = Date.now();
    const result = await collectCppSemanticFacts(root, db, { clangdPath: executable, queryDrivers: [] },
      { requestTimeoutMs: 100 });
    expect(Date.now() - start).toBeLessThan(3000);
    expect(result.views[0]?.success).toBe(false);
    expect(result.views[0]?.failedFiles).toEqual(['variant.c']);
    const pid = Number(fs.readFileSync(path.join(root, '.codegraph', 'semantic', 'compile-db', result.views[0]!.id, 'fake.pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 35);
    const cancelled = await collectCppSemanticFacts(root, db, { clangdPath: executable, queryDrivers: [] },
      { signal: controller.signal, requestTimeoutMs: 1000 });
    expect(cancelled.views[0]?.success).toBe(false);
  });

  it('marks every skipped view incomplete when cancelled before starting, without PATH fallback', async () => {
    const db = database([entry('variant.c', 'one'), entry('variant.c', 'two', ['-DVARIANT_TWO'])]);
    const cancelled = new AbortController();
    cancelled.abort();
    const result = await collectCppSemanticFacts(root, db, { clangdPath: executable, queryDrivers: [] },
      { signal: cancelled.signal });
    expect(result.views).toHaveLength(2);
    expect(result.views.every(v => !v.success && v.failedTuCount === 1)).toBe(true);
    expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
    const missing = await collectCppSemanticFacts(root, db, { clangdPath: null, queryDrivers: [] });
    expect(missing.views.every(v => !v.success && v.error?.includes('unavailable'))).toBe(true);
  });

  it('bounds the initialize handshake and early process exit', async () => {
    for (const flag of ['-DHANG_INITIALIZE', '-DEXIT_EARLY']) {
      const db = database([entry('variant.c', 'one', [flag])]);
      const start = Date.now();
      const result = await collectCppSemanticFacts(root, db, { clangdPath: executable, queryDrivers: [] },
        { requestTimeoutMs: 100 });
      expect(Date.now() - start).toBeLessThan(3000);
      expect(result.views[0]?.success).toBe(false);
      expect(result.views[0]?.failedFiles).toEqual(['variant.c']);
    }
  });

  it('rejects generated-directory symlink escapes and external LSP source URIs', () => {
    const db = database([entry('variant.c', 'one')]);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'other.c'), 'int external(void) { return 0; }\n');
      fs.symlinkSync(path.join(outside, 'other.c'), path.join(root, 'external-link.c'));
      fs.symlinkSync(outside, path.join(root, '.codegraph'));
      expect(() => materializeCompileView(root, buildCompileViews(db)[0]!)).toThrow(/Unsafe/);
      expect(projectFileFromUri(fs.realpathSync(root), pathToFileURL(path.join(outside, 'other.c')).href)).toBeNull();
      expect(projectFileFromUri(fs.realpathSync(root), pathToFileURL(path.join(root, 'external-link.c')).href)).toBeNull();
      fs.unlinkSync(path.join(root, '.codegraph'));
      expect(() => materializeCompileView(root, { ...buildCompileViews(db)[0]!, entries: [
        { ...db.entries[0]!, file: '../outside.c' },
      ] })).toThrow(/escapes/);
      expect(normalizeLspPosition({ line: 0, character: 7 })).toEqual({ line: 1, column: 7 });
      expect(normalizeLspPosition({ line: -1, character: 0 })).toBeNull();
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  it.skipIf(!realClangd)('collects real clangd facts from conditional signatures and same-name static definitions', async () => {
    const db = database([entry('variant.c', 'one', ['-DVARIANT_ONE']), entry('static-a.c', 'one'),
      entry('variant.c', 'two', ['-DVARIANT_TWO']), entry('static-b.c', 'two')]);
    const result = await collectCppSemanticFacts(root, db, { clangdPath: realClangd!, queryDrivers: [] },
      { requestTimeoutMs: 8000 });
    expect(result.views.map(v => v.success)).toEqual([true, true]);
    expect(result.symbols.filter(s => s.name === 'feature').map(s => s.startLine).sort()).toEqual([2, 4]);
    expect(result.symbols.filter(s => s.name === 'helper').map(s => s.filePath).sort())
      .toEqual(['static-a.c', 'static-b.c']);
    expect(result.symbols.some(s => s.name === 'only_declaration')).toBe(false);
    expect(result.calls.filter(c => c.callee.name === 'feature').map(c => c.caller.name))
      .toEqual(['invoke', 'invoke']);
    expect(result.calls.filter(c => c.callee.name === 'feature').map(c => c.callLine).sort())
      .toEqual([16, 18]);
    expect(result.calls.filter(c => c.callee.name === 'feature').map(c => c.callColumn).sort())
      .toEqual([11, 24]);
  }, 30_000);
});
