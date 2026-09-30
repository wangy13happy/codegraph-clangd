/**
 * Project-scoped configuration: a committed `codegraph.json` at the project
 * root that a team shares through version control.
 *
 * It carries `extensions`, an opt-in map from a custom file
 * extension to one of CodeGraph's supported languages. The built-in
 * extension → language table (`EXTENSION_MAP` in `extraction/grammars.ts`) is
 * otherwise hardcoded, so a codebase that uses a non-standard extension for a
 * supported language (e.g. `.dota_lua` for Lua) sees those files silently
 * skipped. This lets the project map them once, in a version-controlled file:
 *
 *   {
 *     "extensions": {
 *       ".dota_lua": "lua",
 *       ".tpl": "php"
 *     }
 *   }
 *
 * User mappings merge on TOP of the built-ins and win on conflict, so a project
 * can also re-point a built-in extension (e.g. force `.h` → `cpp`). Absent or
 * malformed config is the zero-config default — no overrides, no error. Invalid
 * individual entries are warned-and-skipped (never fatal): an unparseable
 * project file must not break indexing.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Language } from './types';
import { isLanguageSupported } from './extraction/grammars';
import { logWarn } from './errors';
import { canonicalizePotentialPath, findCompilationDatabase, isWithinProject } from './semantic/cpp/compile-database';

/** Filename of the project-scoped config, resolved relative to the project root. */
export const PROJECT_CONFIG_FILENAME = 'codegraph.json';

export interface ProjectConfig {
  /** 仅请求启用修复；仓库配置不能授权外部路径或可执行文件。 */
  cppSemanticRepair?: { enabled: boolean; compileCommands?: string; mode?: 'union' };
  /** Map of custom file extension (`.foo`) to a supported language id. */
  extensions?: Record<string, string>;
  /**
   * Gitignore-style patterns naming gitignored directories whose embedded git
   * repositories should be indexed anyway — the explicit opt-in to override
   * `.gitignore` for nested-repo discovery (#622, #699). Absent/empty (the
   * default) means `.gitignore` is fully respected: gitignored embedded repos
   * are never discovered or indexed (#970, #976).
   */
  includeIgnored?: string[];
  /**
   * Gitignore-style patterns for paths to keep OUT of the index — even when
   * they are git-TRACKED, which `.gitignore` cannot do (#999). The escape hatch
   * for a committed vendor/theme/SDK directory (e.g. a checked-in Metronic theme
   * under `static/`) that bloats the graph and slows indexing but isn't really
   * your code. Matched against project-root-relative paths, so a directory like
   * `"static/"`, a double-star vendor glob, or `"assets/theme"` all work.
   * Absent/empty (the default) excludes nothing beyond the built-in defaults
   * and your `.gitignore`.
   */
  exclude?: string[];
  /**
   * Gitignore-style patterns for first-party source to force INTO the index even
   * when `.gitignore` would drop it — the general whitelist `includeIgnored`
   * never was (that one only revives *embedded git repos* inside ignored dirs).
   * The case this exists for: a project under a second VCS (SVN, Perforce, …)
   * deliberately `.gitignore`s its own real source so it never lands in Git, yet
   * that source must still be indexed. Matched against project-root-relative
   * paths, so `"Tools/"`, a recursive `"Tools/**"` glob, or `"Local/typescript"`
   * all work.
   * Built-in default-ignored dirs (`node_modules`, `dist`, …), `.git`, and
   * CodeGraph's own data dir are never resurfaced; an explicit `exclude` still
   * wins. Absent/empty (the default) forces nothing in.
   */
  include?: string[];
  /**
   * Gitignore-style patterns for paths that should still be INDEXED and
   * findable, but must not outrank first-party code in search ranking (#982).
   *
   * The ranking counterpart to `exclude`: `exclude` is a recall lever (the
   * content leaves the index entirely), this is a relevance lever (the content
   * stays, it just stops winning). It generalizes the built-in
   * example/sample/fixture/benchmark de-prioritization to trees only the
   * project knows about — an `optional-skills/` or `scripts/` directory whose
   * helpers share generic symbol names with real code. Matched against
   * project-root-relative paths, so `"optional-skills/"`, a recursive glob, or
   * `"tools/gen"` all work. Absent/empty (the default) de-prioritizes nothing
   * beyond the built-ins.
   */
  deprioritize?: string[];
}

/** Parsed, validated view of a project's `codegraph.json`. */
interface ParsedConfig {
  cppSemanticRepair: CppSemanticRepairConfig | null;
  extensions: Record<string, Language>;
  includeIgnored: string[];
  exclude: string[];
  deprioritize: string[];
  include: string[];
}

interface CacheEntry {
  mtimeMs: number;
  config: ParsedConfig;
}

/**
 * Cache keyed by project root. The loader is called once per indexing/scan/sync
 * operation (and per watch event), so the mtime guard keeps repeat calls to one
 * `stat` while a single `codegraph.json` is in force. Keying by root keeps two
 * projects in the same process (the daemon / multi-project MCP server) isolated.
 */
const cache = new Map<string, CacheEntry>();

/** Shared frozen empties so the no-config path allocates nothing. */
const EMPTY_EXTENSIONS: Record<string, Language> = Object.freeze({});
const EMPTY_CONFIG: ParsedConfig = Object.freeze({
  cppSemanticRepair: null,
  extensions: EMPTY_EXTENSIONS,
  includeIgnored: Object.freeze([]) as unknown as string[],
  exclude: Object.freeze([]) as unknown as string[],
  include: Object.freeze([]) as unknown as string[],
  deprioritize: Object.freeze([]) as unknown as string[],
});

/**
 * Normalize a user-provided extension key to the `.ext` lowercase form used by
 * the built-in map. Returns null for keys that can never match a real file
 * extension (so the caller warns and skips):
 *   - empty / just "."
 *   - multi-part (".d.ts") — language detection keys off the FINAL extension
 *     only (`lastIndexOf('.')`), so a multi-dot key would never be consulted.
 *   - anything containing a path separator.
 */
function normalizeExtKey(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let ext = raw.trim().toLowerCase();
  if (!ext) return null;
  if (!ext.startsWith('.')) ext = '.' + ext;
  const body = ext.slice(1);
  if (!body) return null;
  if (body.includes('.') || body.includes('/') || body.includes('\\')) return null;
  return ext;
}

/**
 * Read + JSON-parse a `codegraph.json` once and return its validated view.
 * Every failure mode degrades to the zero-config default — a missing file, bad
 * JSON, or a typo'd value never throws.
 */
function parseConfig(file: string): ParsedConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return EMPTY_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logWarn(`Ignoring ${PROJECT_CONFIG_FILENAME}: not valid JSON`, {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return EMPTY_CONFIG;
  }

  if (!parsed || typeof parsed !== 'object') return EMPTY_CONFIG;

  const extensions = extractExtensions(parsed, file);
  const cppSemanticRepair = extractCppSemanticRepair(parsed, file);
  const includeIgnored = extractIncludeIgnored(parsed, file);
  const exclude = extractExclude(parsed, file);
  const include = extractInclude(parsed, file);
  const deprioritize = extractPatternList(parsed, file, 'deprioritize');
  if (
    cppSemanticRepair === null &&
    extensions === EMPTY_EXTENSIONS &&
    includeIgnored.length === 0 &&
    exclude.length === 0 &&
    include.length === 0 &&
    deprioritize.length === 0
  ) {
    return EMPTY_CONFIG;
  }
  return { cppSemanticRepair, extensions, includeIgnored, exclude, include, deprioritize };
}

export interface CppSemanticRepairConfig {
  enabled: true;
  mode: 'union';
  compileCommands?: string;
}

export interface CppSemanticRuntimeOptions {
  /** undefined 使用 PATH 中的 clangd；null 表示显式但非法的路径，不可回退。 */
  clangdPath: string | null | undefined;
  queryDrivers: string[];
  /** 仅来自用户侧授权，允许选择根目录外的编译数据库。 */
  compileCommands?: string;
  /** 原生宏调用出口仅使用固定系统运行时或用户侧绝对路径；项目配置不授予此权限。 */
  nativePythonPath?: string | null;
  nativeLibclangPath?: string | null;
}

/**
 * @brief 检验仓库语义修复配置，并排除所有仓库控制的执行授权。
 * @param[in] parsed 已解析的配置对象
 * @param[in] file 配置文件路径，用于诊断和定位项目根目录
 * @return 验证后的 opt-in 配置；缺失、禁用或畸形时返回 null
 */
function extractCppSemanticRepair(parsed: object, file: string): CppSemanticRepairConfig | null {
  const raw = (parsed as Record<string, unknown>).cppSemanticRepair;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    logWarn('Ignoring cppSemanticRepair: expected an object', { file });
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.enabled === false && Object.keys(obj).every(k => ['enabled', 'mode', 'compileCommands'].includes(k))) return null;
  if (obj.enabled !== true || (obj.mode !== undefined && obj.mode !== 'union') ||
      (obj.compileCommands !== undefined && (typeof obj.compileCommands !== 'string' || !obj.compileCommands.trim())) ||
      Object.keys(obj).some(k => !['enabled', 'mode', 'compileCommands'].includes(k))) {
    logWarn('Ignoring cppSemanticRepair: invalid fields or untrusted execution settings', { file });
    return null;
  }
  const compileCommands = obj.compileCommands as string | undefined;
  // 仓库选择的 DB 经 realpath 检验必须在真实项目根目录内；用户授权走独立入口。
  if (compileCommands && !findCompilationDatabase(path.dirname(file), compileCommands)) {
    // 数据库暂缺属于可诊断的 repair failure，不撤销 opt-in；但路径必须仍在真实根目录内。
    const root = fs.realpathSync(path.dirname(file));
    const candidate = path.resolve(root, compileCommands);
    const canonical = canonicalizePotentialPath(candidate);
    if (!canonical || !isWithinProject(root, canonical) || fs.existsSync(candidate)) {
      logWarn('Ignoring cppSemanticRepair: compilation database is outside project root or invalid', { file });
      return null;
    }
  }
  return { enabled: true, mode: 'union', ...(compileCommands ? { compileCommands } : {}) };
}

/**
 * @brief 读取项目侧语义修复请求，不包含用户侧可执行文件授权。
 * @param[in] rootDir 项目根目录
 * @return 验证后的 opt-in 配置；禁用时返回 null
 */
export function loadCppSemanticRepairConfig(rootDir: string): CppSemanticRepairConfig | null {
  return loadParsedConfig(rootDir).cppSemanticRepair;
}

/**
 * @brief 解析仅来自 CLI 或环境变量的 clangd、驱动与外部数据库授权。
 * @param[in] cli 显式用户选项，优先于环境变量
 * @param[in] env 用户进程环境变量（默认当前进程环境）
 * @param[in] projectRoot 项目根目录，用于防止 PATH 隐式选择项目内 clangd
 * @return 验证后的运行时选项；非法 clangd 路径为 null 且不回退 PATH
 */
export function resolveCppSemanticRuntimeOptions(
  cli: { clangdPath?: string; clangdQueryDrivers?: string; compileCommands?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
  projectRoot?: string,
): CppSemanticRuntimeOptions {
  const rawPath = cli.clangdPath ?? env.CODEGRAPH_CLANGD_PATH;
  let clangdPath: string | null | undefined;
  if (rawPath !== undefined) {
    if (rawPath === 'clangd') clangdPath = rawPath;
    else if (rawPath.trim() && path.isAbsolute(rawPath)) {
      try {
        if (!fs.statSync(rawPath).isFile()) throw new Error('not a regular file');
        fs.accessSync(rawPath, fs.constants.X_OK);
        clangdPath = fs.realpathSync(rawPath);
      } catch {
        logWarn('Ignoring clangd path: executable is missing or not runnable');
        clangdPath = null;
      }
    }
    else {
      logWarn('Ignoring untrusted clangd path: use an absolute path or clangd from PATH');
      clangdPath = null;
    }
  }
  if (projectRoot && (clangdPath === undefined || clangdPath === 'clangd')) {
    const resolved = findPathClangd(env);
    if (resolved) {
      if (isWithinProject(fs.realpathSync(projectRoot), resolved)) {
        logWarn('Ignoring clangd from PATH: executable resolves inside the project root');
        clangdPath = null;
      } else clangdPath = resolved;
    } else {
      logWarn('clangd not found in PATH; semantic repair executable is unavailable');
      clangdPath = null;
    }
  }
  const rawDrivers = cli.clangdQueryDrivers ?? env.CODEGRAPH_CLANGD_QUERY_DRIVERS;
  let queryDrivers: string[] = [];
  if (rawDrivers !== undefined) {
    const drivers = rawDrivers.split(',').map(s => s.trim());
    if (drivers.some(s => !s || !path.isAbsolute(s))) {
      logWarn('Ignoring untrusted query-driver allowlist: every entry must be an absolute path');
    } else queryDrivers = drivers;
  }
  const rawDb = cli.compileCommands ?? env.CODEGRAPH_COMPILE_COMMANDS;
  let compileCommands: string | undefined;
  if (rawDb !== undefined) {
    const resolved = rawDb.trim() ? path.resolve(rawDb) : '';
    try {
      if (!resolved || !fs.statSync(resolved).isFile()) throw new Error('not a regular file');
      compileCommands = fs.realpathSync(resolved);
    } catch { logWarn('Ignoring invalid trusted compile-commands override'); }
  }
  /**
   * @brief 解析原生出口运行时，拒绝项目内或非普通文件的隐式执行路径。
   * @param[in] selected 用户侧绝对路径；未指定时仅检查固定系统候选
   * @param[in] candidates 固定安装位置，不查询项目 PATH
   * @param[in] executable 是否需要执行权限
   * @return 规范路径；显式非法或系统依赖缺失时返回 null
   */
  const nativePath = (selected: string | undefined, candidates: string[], executable: boolean): string | null => {
    for (const candidate of selected === undefined ? candidates : [selected]) {
      try {
        if (!path.isAbsolute(candidate) || !fs.statSync(candidate).isFile()) continue;
        const real = fs.realpathSync(candidate);
        if (projectRoot && isWithinProject(fs.realpathSync(projectRoot), real)) continue;
        fs.accessSync(real, executable ? fs.constants.X_OK : fs.constants.R_OK);
        return real;
      } catch { /* 固定运行时不可用时保留 clangd 路径并明确降级 native 能力。 */ }
    }
    return null;
  };
  return { clangdPath, queryDrivers, compileCommands,
    nativePythonPath: nativePath(env.CODEGRAPH_NATIVE_PYTHON_PATH, ['/usr/bin/python3'], true),
    nativeLibclangPath: nativePath(env.CODEGRAPH_LIBCLANG_PATH,
      ['/usr/lib/x86_64-linux-gnu/libclang-19.so.19', '/usr/lib/aarch64-linux-gnu/libclang-19.so.19'], false) };
}

/**
 * @brief 找到 PATH 中首个实际可运行的 clangd，防止索引阶段改变 cwd 后重新解析。
 * @param[in] env 用户进程环境变量
 * @return 真实可执行文件路径；PATH 未找到时返回 undefined
 */
function findPathClangd(env: NodeJS.ProcessEnv): string | undefined {
  if (env.PATH === undefined) return undefined;
  for (const directory of env.PATH.split(path.delimiter)) {
    const candidate = path.resolve(directory || '.', 'clangd');
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch { /* 非可执行路径交由下一 PATH 分量处理。 */ }
  }
  return undefined;
}

/**
 * Validate the `extensions` map. Every failure mode degrades to "no overrides
 * from this entry" — a bad value or a typo'd language never throws.
 */
function extractExtensions(parsed: object, file: string): Record<string, Language> {
  const exts = (parsed as ProjectConfig).extensions;
  if (!exts || typeof exts !== 'object' || Array.isArray(exts)) return EMPTY_EXTENSIONS;

  const out: Record<string, Language> = {};
  for (const [rawKey, rawVal] of Object.entries(exts)) {
    const key = normalizeExtKey(rawKey);
    if (!key) {
      logWarn(`Ignoring extension mapping in ${PROJECT_CONFIG_FILENAME}: "${rawKey}" is not a valid file extension`, { file });
      continue;
    }
    if (typeof rawVal !== 'string' || !isLanguageSupported(rawVal as Language)) {
      logWarn(`Ignoring extension "${rawKey}" in ${PROJECT_CONFIG_FILENAME}: "${String(rawVal)}" is not a supported language`, { file });
      continue;
    }
    out[key] = rawVal as Language;
  }

  return Object.keys(out).length > 0 ? out : EMPTY_EXTENSIONS;
}

/**
 * Validate the `includeIgnored` patterns: an array of non-empty gitignore-style
 * strings. A non-array value or a non-string/blank entry warns-and-skips; never
 * throws. Patterns are kept verbatim (trimmed) so they match exactly as a
 * `.gitignore` line would.
 */
function extractIncludeIgnored(parsed: object, file: string): string[] {
  const raw = (parsed as ProjectConfig).includeIgnored;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    logWarn(`Ignoring "includeIgnored" in ${PROJECT_CONFIG_FILENAME}: must be an array of gitignore-style patterns`, { file });
    return [];
  }

  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) {
      logWarn(`Ignoring an "includeIgnored" entry in ${PROJECT_CONFIG_FILENAME}: every pattern must be a non-empty string`, { file });
      continue;
    }
    out.push(entry.trim());
  }
  return out;
}

/**
 * Validate a gitignore-style pattern list under `key`. A non-array value or a
 * non-string/blank entry warns-and-skips; never throws. Patterns are kept
 * verbatim (trimmed) so they match exactly as a `.gitignore` line would.
 */
function extractPatternList(parsed: object, file: string, key: 'deprioritize'): string[] {
  const raw = (parsed as ProjectConfig)[key];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    logWarn(`Ignoring "${key}" in ${PROJECT_CONFIG_FILENAME}: must be an array of gitignore-style patterns`, { file });
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) {
      logWarn(`Ignoring a "${key}" entry in ${PROJECT_CONFIG_FILENAME}: every pattern must be a non-empty string`, { file });
      continue;
    }
    out.push(entry.trim());
  }
  return out;
}

/**
 * Validate the `exclude` patterns: an array of non-empty gitignore-style
 * strings naming paths to keep out of the index even when git-tracked (#999). A
 * non-array value or a non-string/blank entry warns-and-skips; never throws.
 * Patterns are kept verbatim (trimmed) so they match exactly as a `.gitignore`
 * line would, against project-root-relative paths.
 */
function extractExclude(parsed: object, file: string): string[] {
  const raw = (parsed as ProjectConfig).exclude;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    logWarn(`Ignoring "exclude" in ${PROJECT_CONFIG_FILENAME}: must be an array of gitignore-style patterns`, { file });
    return [];
  }

  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) {
      logWarn(`Ignoring an "exclude" entry in ${PROJECT_CONFIG_FILENAME}: every pattern must be a non-empty string`, { file });
      continue;
    }
    out.push(entry.trim());
  }
  return out;
}

/**
 * Validate the `include` patterns: an array of non-empty gitignore-style strings
 * naming first-party source to force INTO the index despite `.gitignore` — the
 * whitelist for SVN/Perforce-only source a project gitignores out of Git (the
 * general case `includeIgnored` never covered). A non-array value or a
 * non-string/blank entry warns-and-skips; never throws. Patterns are kept
 * verbatim (trimmed) so they match exactly as a `.gitignore` line would, against
 * project-root-relative paths.
 */
function extractInclude(parsed: object, file: string): string[] {
  const raw = (parsed as ProjectConfig).include;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    logWarn(`Ignoring "include" in ${PROJECT_CONFIG_FILENAME}: must be an array of gitignore-style patterns`, { file });
    return [];
  }

  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) {
      logWarn(`Ignoring an "include" entry in ${PROJECT_CONFIG_FILENAME}: every pattern must be a non-empty string`, { file });
      continue;
    }
    out.push(entry.trim());
  }
  return out;
}

/**
 * Load the parsed `codegraph.json` for a project, mtime-cached. A missing or
 * malformed file yields the zero-config default. One `stat` (and at most one
 * read/parse) while a single config file is in force, shared across every field.
 */
function loadParsedConfig(rootDir: string): ParsedConfig {
  const file = path.join(rootDir, PROJECT_CONFIG_FILENAME);

  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    // No config file — drop any stale cache entry and return the default.
    cache.delete(rootDir);
    return EMPTY_CONFIG;
  }

  const entry = cache.get(rootDir);
  if (entry && entry.mtimeMs === mtimeMs) return entry.config;

  const config = parseConfig(file);
  cache.set(rootDir, { mtimeMs, config });
  return config;
}

/**
 * Load the validated extension overrides for a project, mtime-cached.
 *
 * Returns a map of `.ext` → supported language id. The result merges on top of
 * the built-in extension map at the point of use (see `detectLanguage` /
 * `isSourceFile`), with these user mappings taking precedence. Returns an empty
 * map when there is no `codegraph.json` (the zero-config default).
 */
export function loadExtensionOverrides(rootDir: string): Record<string, Language> {
  return loadParsedConfig(rootDir).extensions;
}

/**
 * Load the validated `includeIgnored` patterns for a project, mtime-cached.
 *
 * These name gitignored directories whose embedded git repositories should be
 * indexed despite `.gitignore` (#622, #699). An empty result — the zero-config
 * default — means `.gitignore` is fully respected: gitignored embedded repos
 * are never discovered or indexed (#970, #976).
 */
export function loadIncludeIgnoredPatterns(rootDir: string): string[] {
  return loadParsedConfig(rootDir).includeIgnored;
}

/**
 * Load the validated `exclude` patterns for a project, mtime-cached.
 *
 * These name paths to keep OUT of the index even when git-tracked — the escape
 * hatch for a committed vendor/theme/SDK directory `.gitignore` can't drop
 * (#999). An empty result — the zero-config default — excludes nothing beyond
 * the built-in defaults and the project's `.gitignore`.
 */
export function loadExcludePatterns(rootDir: string): string[] {
  return loadParsedConfig(rootDir).exclude;
}

/**
 * Load the validated `deprioritize` patterns for a project, mtime-cached.
 *
 * These name indexed paths that must not outrank first-party code (#982) — the
 * ranking counterpart to `exclude`. An empty result — the zero-config default —
 * de-prioritizes nothing beyond the built-in example/fixture/benchmark dirs.
 */
export function loadDeprioritizePatterns(rootDir: string): string[] {
  return loadParsedConfig(rootDir).deprioritize;
}

/**
 * Load the validated `include` patterns for a project, mtime-cached.
 *
 * These name first-party source to force INTO the index even when `.gitignore`
 * would drop it — the whitelist for SVN/Perforce-only source a project
 * gitignores out of Git. An empty result — the zero-config default — forces
 * nothing in. Built-in default-ignored dirs, `.git`, and CodeGraph's data dir
 * are never resurfaced, and an explicit `exclude` still wins.
 */
export function loadIncludePatterns(rootDir: string): string[] {
  return loadParsedConfig(rootDir).include;
}

/** Test/maintenance hook: forget cached config (e.g. after rewriting it in a test). */
export function clearProjectConfigCache(): void {
  cache.clear();
}

/**
 * Add gitignore-style patterns to a project's `codegraph.json` `includeIgnored`
 * list, creating the file if absent and preserving every other key. Used by the
 * CLI to opt a "super-repo of gitignored child repos" (#1156) into the index on
 * the user's say-so. Returns the count of patterns actually ADDED (ones already
 * present are skipped, so a re-run is idempotent).
 *
 * A plain-JSON round-trip: a `codegraph.json` carrying comments (not valid JSON)
 * already fails to load with a warning, so rather than silently clobber such a
 * file this throws when an existing config won't parse — the caller falls back
 * to printing the manual snippet. Invalidates the config cache so a subsequent
 * index in the same process sees the new patterns.
 */
export function addIncludeIgnoredPatterns(rootDir: string, patterns: string[]): number {
  const file = path.join(rootDir, PROJECT_CONFIG_FILENAME);
  let config: Record<string, unknown> = {};
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    raw = null; // missing file — create a fresh one below
  }
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${PROJECT_CONFIG_FILENAME} is not valid JSON — fix it by hand, then re-run.`);
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  }

  const existing = Array.isArray(config.includeIgnored)
    ? (config.includeIgnored as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  const merged = [...existing];
  const seen = new Set(existing);
  let added = 0;
  for (const p of patterns) {
    if (seen.has(p)) continue;
    seen.add(p);
    merged.push(p);
    added++;
  }
  config.includeIgnored = merged;
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  clearProjectConfigCache();
  return added;
}
