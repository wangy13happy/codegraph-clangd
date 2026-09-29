import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadCompilationDatabase } from '../src/semantic/cpp/compile-database';
import { resolveCppSemanticInputs } from '../src/semantic/cpp';

vi.mock('../src/semantic/cpp/compile-database', async importOriginal => ({
  ...await importOriginal<typeof import('../src/semantic/cpp/compile-database')>(),
  loadCompilationDatabase: vi.fn(),
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-inputs-'));
const priorClangd = process.env.CODEGRAPH_CLANGD_PATH;

afterEach(() => {
  vi.mocked(loadCompilationDatabase).mockReset();
  if (priorClangd === undefined) delete process.env.CODEGRAPH_CLANGD_PATH;
  else process.env.CODEGRAPH_CLANGD_PATH = priorClangd;
  fs.rmSync(root, { recursive: true, force: true });
});

it('fingerprints the exact compile database bytes used to parse entries when the file is atomically replaced', async () => {
  process.env.CODEGRAPH_CLANGD_PATH = process.execPath;
  fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ cppSemanticRepair: { enabled: true } }));
  fs.writeFileSync(path.join(root, 'unit.c'), 'int unit(void) { return 1; }\n');
  const dbPath = path.join(root, 'compile_commands.json');
  const oldBytes = Buffer.from(JSON.stringify([{ directory: root, file: 'unit.c',
    arguments: ['cc', '-DOLD', '-c', 'unit.c'], output: 'CMakeFiles/app.dir/unit.c.o' }]));
  const newBytes = Buffer.from(JSON.stringify([{ directory: root, file: 'unit.c',
    arguments: ['cc', '-DNEW', '-c', 'unit.c'], output: 'CMakeFiles/app.dir/unit.c.o' }]));
  fs.writeFileSync(dbPath, oldBytes);
  const actual = await vi.importActual<typeof import('../src/semantic/cpp/compile-database')>(
    '../src/semantic/cpp/compile-database');
  vi.mocked(loadCompilationDatabase).mockImplementationOnce((...args) => {
    const parsed = actual.loadCompilationDatabase(...args);
    fs.writeFileSync(path.join(root, 'compile_commands.next.json'), newBytes);
    fs.renameSync(path.join(root, 'compile_commands.next.json'), dbPath);
    return parsed;
  });
  const first = resolveCppSemanticInputs(root);
  expect(first?.database?.entries[0]?.semanticFlags).toContain('-DOLD');
  expect(first?.fingerprint).toBeTruthy();

  vi.mocked(loadCompilationDatabase).mockImplementation(actual.loadCompilationDatabase);
  const second = resolveCppSemanticInputs(root);
  expect(second?.database?.entries[0]?.semanticFlags).toContain('-DNEW');
  expect(second?.fingerprint).toBeTruthy();
  expect(first?.fingerprint).not.toBe(second?.fingerprint);
});
