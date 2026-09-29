/**
 * Incremental sync must converge to a full rebuild (CG-33).
 *
 * A long-lived, auto-synced index silently diverged from a clean rebuild of the
 * identical tree: 4.3% of distinct edges wrong, in BOTH directions, on
 * codegraph's own repo. Two mechanisms, both exercised here:
 *
 * 1. Resolution binds a reference to one of the same-named definitions
 *    PROJECT-WIDE, so adding or removing a definition changes the answer for
 *    references in files the sync never touches. Those references resolved once
 *    and their rows were deleted, so nothing revisited them — the index kept an
 *    answer that was only correct against an older graph.
 * 2. When nothing disambiguated the candidates, the winner was whichever row
 *    the index scan reached first — i.e. the order files were WRITTEN. A full
 *    index writes in scan order; a sync appends each file as it changes, so the
 *    same tree resolved differently depending on how the index was built.
 *
 * The assertions here compare the whole edge SET, never counts: the divergence
 * is bidirectional and nets out of a total (raw rows differed by 0.7% while
 * 4.3% of edges were wrong), so a count check passes on a broken index.
 *
 * ---
 *
 * THIS SUITE MUST FAIL WITH `CODEGRAPH_NO_REBIND=1` (CG-35).
 *
 * That environment variable is the kill switch on the rebind half of the fix
 * (`src/index.ts`, guarding `resurrectStaleResolutionEdges`). The convergence
 * cases below are the only coverage that half has, so the check is the suite's
 * own regression test:
 *
 *     CODEGRAPH_NO_REBIND=1 npx vitest run __tests__/sync-rebuild-convergence.test.ts
 *
 * must report failures, and an unset run must be green. If you change a case
 * here, re-run both. A version of this suite passed under the kill switch
 * because `rebuildEdgeSet` was not rebuilding anything — see the note there.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { createDatabase } from '../src/db/sqlite-adapter';
import { collectCppSemanticFacts, type SemanticFactCollection } from '../src/semantic/cpp';
import { ToolHandler } from '../src/mcp/tools';

vi.mock('../src/semantic/cpp', async importOriginal => ({
  ...await importOriginal<typeof import('../src/semantic/cpp')>(),
  collectCppSemanticFacts: vi.fn(),
}));

describe('Incremental sync converges to a full rebuild (CG-33)', () => {
  let testDir: string;
  let cg: CodeGraph;

  const write = (rel: string, content: string) => {
    const full = path.join(testDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  /**
   * Every edge as a `source|target|kind` triple, read from the database with a
   * second read-only connection. Node ids are `sha256(filePath:kind:name:line)`,
   * so for an identical tree they are identical across a sync and a rebuild —
   * which is what makes the two sets directly comparable.
   */
  const edgeSet = (): Set<string> => {
    const { db } = createDatabase(path.join(testDir, '.codegraph', 'codegraph.db'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT source, target, kind FROM edges').all() as Array<{
        source: string;
        target: string;
        kind: string;
      }>;
      return new Set(rows.map((r) => `${r.source}|${r.target}|${r.kind}`));
    } finally {
      db.close();
    }
  };

  /**
   * Run `fn` against a second, WRITABLE connection to the same database. Used
   * by the two rule tests below to plant edge shapes the extractor cannot
   * produce on demand — an edge from an engine older than the refName stamp,
   * and a synthesized dispatch edge.
   */
  const withDb = <T>(fn: (db: ReturnType<typeof createDatabase>['db']) => T): T => {
    const { db } = createDatabase(path.join(testDir, '.codegraph', 'codegraph.db'));
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  /** Human-readable diff, so a failure names the edges instead of just a count. */
  const describeDiff = (synced: Set<string>, rebuilt: Set<string>): string => {
    const missing = [...rebuilt].filter((e) => !synced.has(e));
    const stale = [...synced].filter((e) => !rebuilt.has(e));
    return `missing from synced: ${missing.length}, stale in synced: ${stale.length}`;
  };

  /**
   * Rebuild the index from scratch over the CURRENT tree and return its edge
   * set — the ground truth a user gets from `codegraph index`.
   *
   * It must go through `CodeGraph.recreate`, which is what the CLI's `index`
   * command does: it DELETES the database file and builds an empty one. Calling
   * `indexAll` on the live handle instead is not a rebuild at all — every file
   * hashes identical, so the store writes nothing (`nodesCreated: 0`), no
   * reference is re-created, and every existing edge survives untouched. The
   * comparison then reads the synced index against ITSELF and can never fail,
   * which is exactly how this suite passed with `CODEGRAPH_NO_REBIND=1` (CG-35).
   */
  const rebuildEdgeSet = async (): Promise<Set<string>> => {
    // Close the live handle first: `recreate` unlinks the database file, and a
    // held handle makes that EBUSY on Windows.
    cg.destroy();
    cg = await CodeGraph.recreate(testDir);
    await cg.indexAll();
    return edgeSet();
  };

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cg33-'));
  });

  afterEach(() => {
    cg?.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  /**
   * The originating shape. `caller.ts` calls `pct` with no import, so it binds
   * by name; at index time `zeta.ts` is the only definition. A later sync adds
   * `alpha.ts`, which sorts FIRST and is therefore the rebuild's answer — but
   * `caller.ts` never changes, so nothing re-resolves it.
   */
  it('rebinds references in UNCHANGED files when a sync adds a competing definition', async () => {
    write('src/caller.ts', `export function run(): number {\n  return pct(1);\n}\n`);
    write('src/zeta.ts', `export function pct(n: number): number {\n  return n;\n}\n`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    write('src/alpha.ts', `export function pct(n: number): number {\n  return n * 2;\n}\n`);
    const result = await cg.sync();
    expect(result.filesAdded).toBe(1);
    expect(result.definitionDelta).toContain('pct');

    const synced = edgeSet();
    const rebuilt = await rebuildEdgeSet();
    expect(describeDiff(synced, rebuilt)).toBe('missing from synced: 0, stale in synced: 0');
  });

  /**
   * The mirror direction: removing a definition narrows the candidate set too,
   * so the delta must include names the sync DROPPED, not just names it added.
   *
   * This one already converged before the fix — a removal cascades the edge
   * away and the #1240 removal path resurrects it, so the reference gets
   * re-resolved for free. It is here as a standing guard on the invariant, and
   * because the removal half of the delta has no other coverage: an
   * implementation that only sampled post-sync names would still pass every
   * other test in this file.
   */
  it('rebinds references in UNCHANGED files when a sync removes a competing definition', async () => {
    write('src/caller.ts', `export function run(): number {\n  return pct(1);\n}\n`);
    write('src/alpha.ts', `export function pct(n: number): number {\n  return n;\n}\n`);
    write('src/zeta.ts', `export function pct(n: number): number {\n  return n * 2;\n}\n`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    fs.rmSync(path.join(testDir, 'src', 'alpha.ts'));
    const result = await cg.sync();
    expect(result.filesRemoved).toBe(1);

    const synced = edgeSet();
    const rebuilt = await rebuildEdgeSet();
    expect(describeDiff(synced, rebuilt)).toBe('missing from synced: 0, stale in synced: 0');
  });

  /**
   * The delta must be computed per FILE. Comparing one name set across the whole
   * changed batch cancels a name that is added in one changed file while another
   * changed file already defined it — which is precisely the shape a commit that
   * splits a module out has, and it was the largest residual class in the first
   * measurement of this fix.
   */
  it('flags a name added in one changed file even when another changed file already defines it', async () => {
    write('src/caller.ts', `export function run(): number {\n  return pct(1);\n}\n`);
    write('src/zeta.ts', `export function pct(n: number): number {\n  return n;\n}\nexport function keep(): number {\n  return 0;\n}\n`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    // One commit: a NEW file gains `pct`, and the file that already had `pct`
    // is edited too (so a batch-wide name set would see `pct` on both sides).
    write('src/alpha.ts', `export function pct(n: number): number {\n  return n * 2;\n}\n`);
    write('src/zeta.ts', `export function pct(n: number): number {\n  return n + 1;\n}\nexport function keep(): number {\n  return 0;\n}\n`);
    const result = await cg.sync();
    expect(result.definitionDelta).toContain('pct');

    const synced = edgeSet();
    const rebuilt = await rebuildEdgeSet();
    expect(describeDiff(synced, rebuilt)).toBe('missing from synced: 0, stale in synced: 0');
  });

  /**
   * The realistic case the issue was filed from: many edits driven through sync
   * one after another, the way a watcher or a `git pull` applies them. Drift
   * accumulated across syncs, so a single-edit test would not have caught it.
   */
  it('stays converged across a sequence of adds, edits, renames and deletes', async () => {
    write('src/caller.ts', `export function run(): number {\n  return pct(1) + fmt(2) + collect(3);\n}\n`);
    write('src/util/zeta.ts', `export function pct(n: number): number {\n  return n;\n}\n`);
    write('src/util/omega.ts', `export function fmt(n: number): number {\n  return n;\n}\n`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    // 1. add a competing `pct` that sorts before the existing one
    write('src/util/alpha.ts', `export function pct(n: number): number {\n  return n * 2;\n}\n`);
    await cg.sync();

    // 2. body-only edit — must produce NO definition delta, so the common sync
    //    pays nothing for this machinery
    write('src/util/alpha.ts', `export function pct(n: number): number {\n  return n * 3;\n}\n`);
    const bodyOnly = await cg.sync();
    expect(bodyOnly.filesModified).toBe(1);
    expect(bodyOnly.definitionDelta).toBeUndefined();

    // 3. a rename: `fmt` moves out of omega.ts into a file that sorts first
    write('src/util/omega.ts', `export function other(n: number): number {\n  return n;\n}\n`);
    write('src/util/beta.ts', `export function fmt(n: number): number {\n  return n;\n}\n`);
    await cg.sync();

    // 4. a symbol appears for a reference that never resolved at all
    write('src/util/gamma.ts', `export function collect(n: number): number {\n  return n;\n}\n`);
    await cg.sync();

    // 5. delete the current `pct` winner, so the reference must fall back...
    fs.rmSync(path.join(testDir, 'src', 'util', 'alpha.ts'));
    await cg.sync();

    // 6. ...and then a later sync introduces a new winner ahead of it again.
    //    Ending here rather than on the delete matters: after the delete the
    //    binding happens to land back where it started, which a broken index
    //    also reaches. The final state must be one only re-resolution reaches.
    write('src/util/aaa.ts', `export function pct(n: number): number {\n  return n * 5;\n}\n`);
    await cg.sync();

    const synced = edgeSet();
    expect(synced.size).toBeGreaterThan(0);
    const rebuilt = await rebuildEdgeSet();
    expect(describeDiff(synced, rebuilt)).toBe('missing from synced: 0, stale in synced: 0');
  });

  /**
   * The rebind pass DELETES an edge and re-inserts the reference behind it, so
   * it may only touch edges it can reconstruct. Two shapes it must leave alone,
   * both of which it would otherwise destroy permanently:
   *
   * - an edge with no `metadata.refName` — written by an engine older than the
   *   stamp. Rebuilding a reference from the target's plain name would strip the
   *   receiver context the original text carried (`h.greet` → `greet`);
   * - a synthesized dispatch edge (`provenance='heuristic'`), which is not
   *   resolution output at all: nothing would re-create it, and the synthesizer
   *   that wired it does not run again on this sync.
   *
   * Both are planted directly, since extraction cannot be asked to emit them.
   * The sync then changes the answer for `pct`, which is exactly the condition
   * that makes the pass want to re-open every edge targeting `pct`.
   */
  it('never deletes an edge it cannot reconstruct — no refName stamp, or synthesized', async () => {
    write('src/caller.ts', `export function run(): number {\n  return pct(1);\n}\n`);
    write('src/other.ts', `export function other(): number {\n  return 0;\n}\n`);
    write('src/zeta.ts', `export function pct(n: number): number {\n  return n;\n}\n`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    const planted = withDb((db) => {
      const pct = db.prepare("SELECT id FROM nodes WHERE name = 'pct'").get() as { id: string };
      const other = db.prepare("SELECT id FROM nodes WHERE name = 'other'").get() as { id: string };

      // 1. Strip the stamp off the real edge, leaving the rest of its metadata
      //    intact — the shape an index built before the stamp existed has.
      db.prepare(
        `UPDATE edges SET metadata = json_remove(metadata, '$.refName')
         WHERE target = ? AND kind = 'calls'`
      ).run(pct.id);

      // 2. A synthesized edge that DOES carry a stamp, so only the provenance
      //    rule can save it.
      db.prepare(
        `INSERT INTO edges (source, target, kind, metadata, line, col, provenance)
         VALUES (?, ?, 'calls', ?, 1, 0, 'heuristic')`
      ).run(other.id, pct.id, JSON.stringify({ refName: 'pct', synthesizedBy: 'cg35-test' }));

      return {
        unstamped: `${(db.prepare("SELECT source FROM edges WHERE target = ? AND provenance IS NULL AND kind = 'calls'").get(pct.id) as { source: string }).source}|${pct.id}|calls`,
        synthesized: `${other.id}|${pct.id}|calls`,
      };
    });

    const before = edgeSet();
    expect(before.has(planted.unstamped)).toBe(true);
    expect(before.has(planted.synthesized)).toBe(true);

    write('src/alpha.ts', `export function pct(n: number): number {\n  return n * 2;\n}\n`);
    const result = await cg.sync();
    expect(result.definitionDelta).toContain('pct');

    // Both survive: the pass considered them (their target is `pct`) and
    // declined. Drift is the acceptable outcome here; an edge that no pass can
    // ever restore is not.
    const after = edgeSet();
    expect(after.has(planted.unstamped)).toBe(true);
    expect(after.has(planted.synthesized)).toBe(true);
  });

  /**
   * The per-name ceiling in `getResolutionEdgesByTargetName` (500 by default).
   * Above it a name is generic — `push`, `get`, `join` — one new definition
   * won't flip most of its references, and rebinding an arbitrary subset would
   * manufacture wrong edges while costing the most work. It must DECLINE the
   * name outright, and declining must be lossless.
   *
   * The rare name in the same sync is the control: it proves the pass ran and
   * that the ceiling is what spared the generic one, not a dead rebind pass.
   */
  it('declines a name over the per-name ceiling instead of rebinding an arbitrary subset', async () => {
    // Must exceed the 500 default in getResolutionEdgesByTargetName.
    const OVER_CEILING = 501;
    const callers = Array.from(
      { length: OVER_CEILING },
      (_, i) => `export function hot${i}(): number {\n  return push(${i});\n}\n`
    ).join('');
    write('src/hot.ts', callers);
    write('src/rare.ts', `export function rare(): number {\n  return tug(1);\n}\n`);
    write(
      'src/zzz_defs.ts',
      `export function push(n: number): number {\n  return n;\n}\nexport function tug(n: number): number {\n  return n;\n}\n`
    );
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    const targetsOf = (name: string): string[] =>
      withDb((db) =>
        (
          db
            .prepare(
              `SELECT t.file_path AS file FROM edges e
               JOIN nodes t ON t.id = e.target
               JOIN nodes s ON s.id = e.source
               WHERE t.name = ? AND e.kind = 'calls'`
            )
            .all(name) as Array<{ file: string }>
        ).map((r) => r.file)
      );

    expect(targetsOf('push')).toHaveLength(OVER_CEILING);
    expect(new Set(targetsOf('push'))).toEqual(new Set(['src/zzz_defs.ts']));
    expect(targetsOf('tug')).toEqual(['src/zzz_defs.ts']);

    // One sync adds a competing definition of BOTH names, in a file that sorts
    // first and is therefore the rebuild's answer for each.
    write(
      'src/aaa.ts',
      `export function push(n: number): number {\n  return n * 2;\n}\nexport function tug(n: number): number {\n  return n * 2;\n}\n`
    );
    const result = await cg.sync();
    expect(result.definitionDelta).toContain('push');
    expect(result.definitionDelta).toContain('tug');

    // `push` is untouched — every edge still there, still on the old target.
    // This is knowingly divergent from a rebuild; see "Don't chase the
    // residual" in docs/benchmarks/index-drift-cg33.md.
    const pushTargets = targetsOf('push');
    expect(pushTargets).toHaveLength(OVER_CEILING);
    expect(new Set(pushTargets)).toEqual(new Set(['src/zzz_defs.ts']));

    // `tug` — the control — rebound.
    expect(targetsOf('tug')).toEqual(['src/aaa.ts']);
  });

  /**
   * Guards the escape hatch itself: with the rebind pass off, the same sequence
   * must still produce a structurally sound index (no lost or orphaned edges) —
   * just a drifted one. If this ever fails, the pass is doing something the
   * kill switch cannot undo.
   */
  it('CODEGRAPH_NO_REBIND=1 disables the pass without corrupting the index', async () => {
    write('src/caller.ts', `export function run(): number {\n  return pct(1);\n}\n`);
    write('src/zeta.ts', `export function pct(n: number): number {\n  return n;\n}\n`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    const before = edgeSet();

    process.env.CODEGRAPH_NO_REBIND = '1';
    try {
      write('src/alpha.ts', `export function pct(n: number): number {\n  return n * 2;\n}\n`);
      await cg.sync();
    } finally {
      delete process.env.CODEGRAPH_NO_REBIND;
    }

    const after = edgeSet();
    // Every edge that existed before is still there — the pass is the only
    // thing that would have re-opened them, and it did not run.
    for (const edge of before) expect(after.has(edge)).toBe(true);
  });
});

describe('C/C++ semantic sync convergence', () => {
  let root: string;
  let graph: CodeGraph;
  let priorClangd: string | undefined;

  /**
   * @brief 构造受控的单视图符号及精确调用位置，模拟 clangd 成功采集。
   * @param[in] targetLine 目标定义在源码中的行号
   * @return 完整权威事实及两处真实调用坐标
   */
  function semanticFacts(targetLine: number): SemanticFactCollection {
    const target = { configId: 'one', filePath: 'a.c', kind: 'function' as const,
      name: 'target', startLine: targetLine, endLine: targetLine,
      startColumn: 0, endColumn: 29, signature: 'int target(void)' };
    const caller = { configId: 'one', filePath: 'b.c', kind: 'function' as const,
      name: 'caller', startLine: 2, endLine: 2, startColumn: 0, endColumn: 53,
      signature: 'int caller(void)' };
    return { inventory: 'authoritative', grouping: 'cmake-target', symbols: [target, caller],
      calls: [25, 36].map(callColumn => ({ configId: 'one', caller, callee: target,
        callLine: 2, callColumn })),
      views: [{ id: 'one', key: 'cmake:app', flagsHash: 'a'.repeat(64),
        inventory: 'authoritative', grouping: 'cmake-target', success: true,
        coveredFiles: ['a.c', 'b.c'], failedFiles: [], analyzedTuCount: 2,
        failedTuCount: 0, durationMs: 1 }] };
  }

  /**
   * @brief 读取图中语义节点、直接调用、精确坐标和配置归属的稳定集合。
   * @return 可逐项与完整重建比较的实际数据库记录
   */
  function snapshot(): object {
    const { db } = createDatabase(path.join(root, '.codegraph', 'codegraph.db'), { readOnly: true });
    try {
      return {
        nodes: db.prepare("SELECT id,file_path,name,start_line,semantic_origin FROM nodes WHERE language IN ('c','cpp') ORDER BY id").all(),
        calls: db.prepare("SELECT source,target,line,col,provenance FROM edges WHERE kind='calls' AND COALESCE(provenance,'') != 'heuristic' ORDER BY source,target,line,col").all(),
        memberships: db.prepare('SELECT node_id,config_id,definition_line FROM semantic_node_configs ORDER BY node_id,config_id').all(),
        edgeMemberships: db.prepare(`SELECT e.source,e.target,e.line,e.col,m.config_id
          FROM semantic_edge_configs m JOIN edges e ON e.id=m.edge_id
          ORDER BY e.source,e.target,e.line,e.col,m.config_id`).all(),
      };
    } finally { db.close(); }
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-semantic-sync-'));
    priorClangd = process.env.CODEGRAPH_CLANGD_PATH;
    process.env.CODEGRAPH_CLANGD_PATH = process.execPath;
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ cppSemanticRepair: { enabled: true } }));
    fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify(['a.c', 'b.c'].map(file => ({
      directory: root, file, arguments: ['cc', '-c', file], output: `CMakeFiles/app.dir/${file}.o`,
    }))));
    fs.writeFileSync(path.join(root, 'a.c'), 'int target(void) { return 1; }\n');
    fs.writeFileSync(path.join(root, 'b.c'), 'int target(void);\nint caller(void) { return target() + target(); }\n');
    vi.mocked(collectCppSemanticFacts).mockReset();
  });

  afterEach(() => {
    graph?.destroy();
    if (priorClangd === undefined) delete process.env.CODEGRAPH_CLANGD_PATH;
    else process.env.CODEGRAPH_CLANGD_PATH = priorClangd;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('converges after targeted sync and repeated sync to a fresh full index', async () => {
    vi.mocked(collectCppSemanticFacts).mockImplementation(async (_root, _db, _runtime, options) => {
      if (options?.scopeFiles) expect(options.scopeFiles).toEqual(['a.c']);
      const facts = semanticFacts(fs.readFileSync(path.join(root, 'a.c'), 'utf8').startsWith('//') ? 2 : 1);
      return options?.scopeFiles ? { ...facts, scopeFiles: options.scopeFiles,
        expectedViewsByFile: { 'a.c': ['one'], 'b.c': ['one'] } } : facts;
    });
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    expect(graph.getCppSemanticRepairStatus()).toMatchObject({ state: 'complete', viewCount: 1,
      translationUnits: 2 });
    fs.writeFileSync(path.join(root, 'a.c'), '// shifted\nint target(void) { return 1; }\n');
    await graph.sync();
    expect(vi.mocked(collectCppSemanticFacts).mock.lastCall?.[3]?.scopeFiles).toEqual(['a.c']);
    const synced = snapshot();
    await graph.sync();
    expect(snapshot()).toEqual(synced);
    graph.destroy();
    graph = await CodeGraph.recreate(root);
    await graph.indexAll();
    expect(snapshot()).toEqual(synced);
  });

  it('rebuilds every view on header and compilation database changes without source edits', async () => {
    vi.mocked(collectCppSemanticFacts).mockResolvedValue(semanticFacts(1));
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    fs.writeFileSync(path.join(root, 'config.h'), '#define FEATURE 1\n');
    await graph.sync();
    expect(vi.mocked(collectCppSemanticFacts).mock.lastCall?.[3]?.scopeFiles).toBeUndefined();
    vi.mocked(collectCppSemanticFacts).mockClear();
    fs.writeFileSync(path.join(root, 'compile_commands.json'), fs.readFileSync(path.join(root, 'compile_commands.json'), 'utf8') + ' ');
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('stale');
    await graph.sync();
    expect(vi.mocked(collectCppSemanticFacts)).toHaveBeenCalledOnce();
    expect(vi.mocked(collectCppSemanticFacts).mock.lastCall?.[3]?.scopeFiles).toBeUndefined();
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('complete');

    vi.mocked(collectCppSemanticFacts).mockClear();
    const configPath = path.join(root, 'codegraph.json');
    fs.writeFileSync(configPath, JSON.stringify({ cppSemanticRepair: {
      enabled: true, compileCommands: 'compile_commands.json',
    } }));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(configPath, later, later);
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('stale');
    await graph.sync();
    expect(vi.mocked(collectCppSemanticFacts).mock.lastCall?.[3]?.scopeFiles).toBeUndefined();
    if (fs.existsSync('/usr/bin/clangd-19')) {
      vi.mocked(collectCppSemanticFacts).mockClear();
      process.env.CODEGRAPH_CLANGD_PATH = '/usr/bin/clangd-19';
      expect(graph.getCppSemanticRepairStatus()?.state).toBe('stale');
      await graph.sync();
      expect(vi.mocked(collectCppSemanticFacts)).toHaveBeenCalledOnce();
      expect(vi.mocked(collectCppSemanticFacts).mock.lastCall?.[3]?.scopeFiles).toBeUndefined();
    }
  });

  it('keeps the ordinary index complete while reporting a failed semantic view', async () => {
    const partial = semanticFacts(1);
    partial.views[0]!.success = false;
    partial.views[0]!.failedFiles = ['a.c'];
    partial.views[0]!.coveredFiles = ['b.c'];
    partial.views[0]!.failedTuCount = 1;
    vi.mocked(collectCppSemanticFacts).mockResolvedValue(partial);
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    expect(graph.getIndexState()).toBe('complete');
    expect(graph.getCppSemanticRepairStatus()).toMatchObject({ state: 'partial', viewsFailed: 1 });
    vi.mocked(collectCppSemanticFacts).mockResolvedValue(semanticFacts(1));
    await graph.sync();
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('complete');
  });

  /**
   * @brief 启动时无变更的 catch-up 不重试未覆盖视图，显式同步及头文件变更仍重试。
   * @return 无；断言热查询门控不触发语义采集但修复入口保持可用
   */
  it('avoids repeating an unchanged partial repair during MCP catch-up', async () => {
    const partial = semanticFacts(1);
    partial.views[0]!.success = false;
    partial.views[0]!.failedFiles = ['a.c'];
    partial.views[0]!.coveredFiles = ['b.c'];
    partial.views[0]!.failedTuCount = 1;
    vi.mocked(collectCppSemanticFacts).mockResolvedValue(partial);
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('partial');
    vi.mocked(collectCppSemanticFacts).mockClear();
    await graph.sync({ skipPartialSemanticRetry: true });
    expect(vi.mocked(collectCppSemanticFacts)).not.toHaveBeenCalled();
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('partial');
    const handler = new ToolHandler(graph);
    handler.setCatchUpGate(graph.sync({ skipPartialSemanticRetry: true }).then(() => undefined));
    const query = await handler.execute('codegraph_search', { query: 'caller' });
    expect(query.isError).toBeFalsy();
    expect(query.content[0]?.text).toContain('caller');
    expect(vi.mocked(collectCppSemanticFacts)).not.toHaveBeenCalled();
    vi.mocked(collectCppSemanticFacts).mockResolvedValue(semanticFacts(1));
    fs.writeFileSync(path.join(root, 'config.h'), '#define ENABLED 1\n');
    await graph.sync({ skipPartialSemanticRetry: true });
    expect(vi.mocked(collectCppSemanticFacts)).toHaveBeenCalledOnce();
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('complete');
  });

  it('does not retire membership when a targeted view fails or another relevant view was skipped', async () => {
    const initial = semanticFacts(1);
    const phantom = { ...initial.symbols[0]!, name: 'phantom', startColumn: 32, endColumn: 45 };
    initial.symbols.push(phantom);
    initial.calls.push({ configId: 'one', caller: initial.symbols[1]!, callee: phantom,
      callLine: 2, callColumn: 44 });
    vi.mocked(collectCppSemanticFacts).mockResolvedValue(initial);
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    const before = snapshot();
    expect(JSON.stringify(before)).toContain('phantom');
    expect(JSON.stringify(before)).toContain('clangd');
    fs.writeFileSync(path.join(root, 'a.c'), 'int target(void) { return 2; }\n');
    const incomplete = semanticFacts(1);
    incomplete.scopeFiles = ['a.c'];
    incomplete.expectedViewsByFile = { 'a.c': ['one', 'two'], 'b.c': ['one'] };
    incomplete.symbols = [];
    incomplete.calls = [];
    vi.mocked(collectCppSemanticFacts).mockResolvedValue(incomplete);
    await graph.sync();
    expect(snapshot()).toEqual(before);
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('partial');
    // 未选视图不能提供负面证据；该断言锁住的是图事实而非诊断计数。
  });

  it('keeps disjoint same-line identities through a partial view then converges after full coverage', async () => {
    const initial = semanticFacts(1);
    initial.symbols.push({ ...initial.symbols[0]!, name: 'phantom', startColumn: 0,
      endColumn: 18, signature: 'int phantom(void)' });
    vi.mocked(collectCppSemanticFacts).mockResolvedValueOnce(initial);
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    fs.writeFileSync(path.join(root, 'a.c'),
      'int target(void) { return 2; } int phantom(void) { return 3; }\n');
    const partial = semanticFacts(1);
    partial.symbols = [];
    partial.calls = [];
    partial.views[0]!.success = false;
    partial.views[0]!.coveredFiles = ['b.c'];
    partial.views[0]!.failedFiles = ['a.c'];
    partial.views[0]!.failedTuCount = 1;
    vi.mocked(collectCppSemanticFacts).mockResolvedValueOnce(partial)
      .mockResolvedValue(semanticFacts(1));
    await graph.sync();
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('partial');
    const interim = snapshot() as { nodes: Array<{ id: string; name: string; semantic_origin: string | null }> };
    expect(interim.nodes.filter(node => node.name === 'phantom')).toHaveLength(2);
    expect(interim.nodes.filter(node => node.name === 'phantom' && node.semantic_origin === 'clangd'))
      .toHaveLength(1);
    await graph.sync();
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('complete');
    const synced = snapshot();
    expect((synced as typeof interim).nodes.filter(node => node.name === 'phantom')).toHaveLength(1);
    graph.destroy();
    graph = await CodeGraph.recreate(root);
    await graph.indexAll();
    expect(snapshot()).toEqual(synced);
  });

  it('removes source memberships and dangling calls on deletion before full repair', async () => {
    vi.mocked(collectCppSemanticFacts).mockImplementation(async () => {
      const facts = semanticFacts(1);
      if (!fs.existsSync(path.join(root, 'a.c'))) {
        facts.symbols = facts.symbols.filter(symbol => symbol.filePath === 'b.c');
        facts.calls = [];
        facts.views[0]!.coveredFiles = ['b.c'];
        facts.views[0]!.analyzedTuCount = 1;
      }
      return facts;
    });
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    fs.unlinkSync(path.join(root, 'a.c'));
    fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify([{
      directory: root, file: 'b.c', arguments: ['cc', '-c', 'b.c'],
      output: 'CMakeFiles/app.dir/b.c.o',
    }]));
    await graph.sync();
    expect(vi.mocked(collectCppSemanticFacts).mock.lastCall?.[3]?.scopeFiles).toBeUndefined();
    const synced = snapshot();
    expect(JSON.stringify(synced)).not.toContain('a.c');
    graph.destroy();
    graph = await CodeGraph.recreate(root);
    await graph.indexAll();
    expect(snapshot()).toEqual(synced);
  });

  it.skipIf(!fs.existsSync('/usr/bin/clangd-19'))('matches a fresh index with real clangd after source edits', async () => {
    process.env.CODEGRAPH_CLANGD_PATH = '/usr/bin/clangd-19';
    const real = await vi.importActual<typeof import('../src/semantic/cpp')>('../src/semantic/cpp');
    vi.mocked(collectCppSemanticFacts).mockImplementation(real.collectCppSemanticFacts);
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('complete');
    fs.writeFileSync(path.join(root, 'a.c'), '// shifted\nint target(void) { return 1; }\n');
    await graph.sync();
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('complete');
    const synced = snapshot();
    graph.destroy();
    graph = await CodeGraph.recreate(root);
    await graph.indexAll();
    expect(graph.getCppSemanticRepairStatus()?.state).toBe('complete');
    expect(snapshot()).toEqual(synced);
  }, 30_000);
});

/**
 * Resolution's candidate order must be a property of the CODE, not of the order
 * rows were written. This is the half of CG-33 that a re-resolution pass alone
 * cannot fix: without it, re-resolving a reference against the very same graph
 * can still pick a different winner than a rebuild does.
 */
describe('Same-name candidate order is content-derived, not insertion-derived (CG-33)', () => {
  let testDir: string;
  let cg: CodeGraph;

  afterEach(() => {
    cg?.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('getNodesByName orders by (file_path, start_line) even when rows were written in another order', async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cg33-order-'));
    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'src', 'mid.ts'), `export function pad(): void {}\nexport function dup(): number {\n  return 2;\n}\n`);
    fs.writeFileSync(path.join(testDir, 'src', 'zeta.ts'), `export function dup(): number {\n  return 1;\n}\n`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    // A sync APPENDS this file's nodes, so `alpha.ts` gets the highest rowids
    // despite sorting first — exactly the divergence a full index never has,
    // and the reason candidate order cannot come from the physical row order.
    fs.writeFileSync(path.join(testDir, 'src', 'alpha.ts'), `export function dup(): number {\n  return 3;\n}\n`);
    await cg.sync();

    const keys = cg.getNodesByName('dup').map((n) => `${n.filePath}:${String(n.startLine).padStart(6, '0')}`);
    expect(keys.length).toBeGreaterThanOrEqual(3);
    expect(keys).toEqual([...keys].sort());
    expect(keys[0]).toContain('src/alpha.ts');
  });
});
