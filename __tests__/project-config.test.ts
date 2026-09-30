import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearProjectConfigCache, loadCppSemanticRepairConfig, resolveCppSemanticRuntimeOptions } from '../src/project-config';

describe('C/C++ semantic repair configuration', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-semantic-config-'));
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('defaults to disabled and validates only union opt-in', () => {
    expect(loadCppSemanticRepairConfig(root)).toBeNull();
    fs.writeFileSync(path.join(root, 'codegraph.json'), '{ broken JSON');
    clearProjectConfigCache();
    expect(loadCppSemanticRepairConfig(root)).toBeNull();
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ cppSemanticRepair: { enabled: true, mode: 'union' } }));
    clearProjectConfigCache();
    expect(loadCppSemanticRepairConfig(root)).toEqual({ enabled: true, mode: 'union' });
    for (const settings of [{ enabled: 'true' }, { enabled: true, mode: 'replace' },
      { enabled: true, clangdPath: '/usr/bin/clangd' }, { enabled: true, queryDrivers: ['/usr/bin/cc'] },
      { enabled: true, nativePythonPath: '/usr/bin/python3' }, { enabled: true, nativeLibclangPath: '/tmp/libclang.so' }]) {
      fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ cppSemanticRepair: settings }));
      clearProjectConfigCache();
      expect(loadCppSemanticRepairConfig(root)).toBeNull();
    }
  });

  it('allows only a canonical in-project explicit database', () => {
    fs.mkdirSync(path.join(root, 'build'));
    fs.writeFileSync(path.join(root, 'build', 'compile_commands.json'), '[]');
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ cppSemanticRepair: {
      enabled: true, compileCommands: 'build/compile_commands.json',
    } }));
    expect(loadCppSemanticRepairConfig(root)?.compileCommands).toBe('build/compile_commands.json');
  });

  it('retains a missing in-project database for failure diagnostics without accepting symlink escape', () => {
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ cppSemanticRepair: {
      enabled: true, compileCommands: 'not-built/yet/compile_commands.json',
    } }));
    expect(loadCppSemanticRepairConfig(root)?.compileCommands).toBe('not-built/yet/compile_commands.json');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-semantic-external-'));
    try {
      fs.symlinkSync(outside, path.join(root, 'not-built'));
      clearProjectConfigCache();
      expect(loadCppSemanticRepairConfig(root)).toBeNull();
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  it('keeps runtime executable and driver authority on the user side', () => {
    const clangd = path.join(root, 'clangd');
    fs.writeFileSync(clangd, '#!/bin/sh\n');
    fs.chmodSync(clangd, 0o755);
    const nativePython = path.join(root, 'native-python');
    const nativeLibrary = path.join(root, 'native-library');
    fs.writeFileSync(nativePython, '#!/bin/sh\n'); fs.chmodSync(nativePython, 0o755);
    fs.writeFileSync(nativeLibrary, 'runtime fixture');
    const env = { CODEGRAPH_CLANGD_PATH: clangd,
      CODEGRAPH_CLANGD_QUERY_DRIVERS: '/usr/bin/cc,/opt/toolchain/bin/*',
      CODEGRAPH_COMPILE_COMMANDS: path.join(root, 'external.json'),
      CODEGRAPH_NATIVE_PYTHON_PATH: nativePython, CODEGRAPH_LIBCLANG_PATH: nativeLibrary };
    fs.writeFileSync(env.CODEGRAPH_COMPILE_COMMANDS, '[]');
    expect(resolveCppSemanticRuntimeOptions({}, env)).toEqual({ clangdPath: clangd,
      queryDrivers: ['/usr/bin/cc', '/opt/toolchain/bin/*'], compileCommands: env.CODEGRAPH_COMPILE_COMMANDS,
      nativePythonPath: nativePython, nativeLibclangPath: nativeLibrary });
    expect(resolveCppSemanticRuntimeOptions({ clangdPath: 'tools/clangd', clangdQueryDrivers: '../gcc' }, env))
      .toMatchObject({ clangdPath: null, queryDrivers: [] });
    expect(resolveCppSemanticRuntimeOptions({ clangdPath: 'clangd' }, {})).toMatchObject({ clangdPath: 'clangd' });
    expect(resolveCppSemanticRuntimeOptions({ clangdPath: path.join(root, 'missing-clangd') }, env).clangdPath).toBeNull();
  });

  it('does not implicitly trust a clangd binary resolved from within the project', () => {
    fs.mkdirSync(path.join(root, 'bin'));
    const executable = path.join(root, 'bin', 'clangd');
    fs.writeFileSync(executable, '#!/bin/sh\n');
    fs.chmodSync(executable, 0o755);
    const env = { PATH: path.join(root, 'bin') };
    expect(resolveCppSemanticRuntimeOptions({}, env, root).clangdPath).toBeNull();
    // An absolute path is an explicit user-side selection; the repo itself cannot supply it.
    expect(resolveCppSemanticRuntimeOptions({ clangdPath: executable }, env, root).clangdPath).toBe(executable);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-clangd-path-'));
    try {
      const trustedPathExecutable = path.join(outside, 'clangd');
      fs.writeFileSync(trustedPathExecutable, '#!/bin/sh\n');
      fs.chmodSync(trustedPathExecutable, 0o755);
      expect(resolveCppSemanticRuntimeOptions({}, { PATH: outside }, root).clangdPath).toBe(trustedPathExecutable);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
});
