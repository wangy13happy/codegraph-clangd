/** @file C/C++ 编译数据库的共享读取、归一化和项目源文件边界。 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export interface CompileCommandEntry {
  file: string;
  directory: string;
  compiler: string;
  arguments: string[];
  output?: string;
  semanticFlags: string[];
  target?: string;
}

export interface CompilationDatabase {
  path: string;
  entries: CompileCommandEntry[];
  includeDirectories: string[];
  excludedSources: number;
  inventory: 'authoritative' | 'advisory';
  grouping: 'cmake-target' | 'semantic-flags';
}

const STANDARD_PATHS = [
  'compile_commands.json', 'build/compile_commands.json',
  'cmake-build-debug/compile_commands.json', 'cmake-build-release/compile_commands.json',
  'out/compile_commands.json',
];

/**
 * @brief 判定规范化路径是否位于项目根目录内。
 * @param[in] root 已规范化的项目根目录
 * @param[in] candidate 待检查的绝对路径
 * @return 在项目根目录内（含根目录）返回 true，否则返回 false
 */
export function isWithinProject(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * @brief 将未生成文件的路径按最近存在的父目录规范化，拒绝断裂符号链接。
 * @param[in] candidate 待规范化的绝对路径
 * @return 路径的真实或预期真实位置；无法安全确认时返回 null
 */
function canonicalizePotentialPath(candidate: string): string | null {
  let cursor = candidate;
  while (true) {
    try {
      return path.join(fs.realpathSync(cursor), path.relative(cursor, candidate));
    } catch {
      // 断裂 symlink/权限错误不能安全地降级为词法路径。
      try { fs.lstatSync(cursor); return null; } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      cursor = parent;
    }
  }
}

/**
 * @brief 发现默认路径或验证显式编译数据库路径。
 * @param[in] projectRoot 项目根目录
 * @param[in] explicitPath 显式路径；未指定时依次探测标准位置
 * @param[in] allowExternal 显式用户授权外部数据库
 * @return 合法普通文件的真实路径；不存在或越界时返回 null
 */
export function findCompilationDatabase(projectRoot: string, explicitPath?: string, allowExternal = false): string | null {
  const root = fs.realpathSync(projectRoot);
  const candidates = explicitPath ? [path.resolve(root, explicitPath)] : STANDARD_PATHS.map(p => path.join(root, p));
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      if (fs.statSync(real).isFile() && (allowExternal || isWithinProject(root, real))) return real;
    } catch { /* 未发现的候选路径允许继续查找。 */ }
    if (explicitPath) break;
  }
  return null;
}

/**
 * @brief 将编译命令拆为参数，延续原 include resolver 的有限引号语义。
 * @param[in] command compilation database 的 command 字符串
 * @return 拆分后的参数数组；不执行 shell 展开或命令
 */
export function splitCompileCommand(command: string): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && /\s/.test(command[i]!)) i++;
    if (i >= command.length) break;
    let arg = '';
    let quote: string | null = null;
    while (i < command.length && (quote || !/\s/.test(command[i]!))) {
      const ch = command[i++]!;
      if (quote) {
        if (ch === quote) quote = null;
        else if (ch === '\\' && quote === '"' && i < command.length) arg += command[i++];
        else arg += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '\\' && i < command.length) {
        arg += command[i++];
      } else arg += ch;
    }
    if (quote) return [];
    result.push(arg);
  }
  return result;
}

/**
 * @brief 归一化影响语义解析的编译参数，排除产物、依赖文件和源文件。
 * @param[in] args 完整编译参数（含编译器）
 * @param[in] source 源文件绝对路径
 * @param[in] directory 编译工作目录
 * @return 语义参数列表，保留参数原有先后顺序
 */
export function normalizeSemanticFlags(args: string[], source: string, directory: string): string[] {
  const flags: string[] = [];
  const paired = new Set(['-D', '-U', '-I', '-isystem', '-iquote', '-idirafter', '-include', '-imacros',
    '-F', '-iframework', '--sysroot', '-isysroot', '-x', '-std', '-target', '--target',
    '-arch', '-mabi', '-march', '-mcpu', '-mtune', '-stdlib']);
  const droppedPairs = new Set(['-o', '-MF', '-MT', '-MQ', '-MJ', '--output']);
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (path.resolve(directory, arg) === source && !arg.startsWith('-')) continue;
    if (droppedPairs.has(arg)) { i++; continue; }
    if (/^(-o|-MF|-MT|-MQ|-MJ)(?=.)/.test(arg) || /^-(M|MM|MD|MMD|MP|MG)$/.test(arg) || arg === '-c' || arg === '-S') continue;
    if (paired.has(arg)) {
      if (i + 1 < args.length) flags.push(arg, args[++i]!);
      continue;
    }
    if (/^(-[DUIF].+|-isystem.+|-isysroot.+|-iquote.+|-idirafter.+|-include.+|-imacros.+|-iframework.+|--?sysroot=.+|-std=.+|-stdlib=.+|--?target=.+|-m(?:arch|cpu|tune|abi)=.+|-m[A-Za-z0-9_-]+|-f[A-Za-z0-9_-]+(?:=.+)?|-nostdinc\+*|-pthread)$/.test(arg)) flags.push(arg);
  }
  return flags;
}

/**
 * @brief 从 CMake 标准产物路径提取目标名。
 * @param[in] output 编译数据库 output 字段或 -o 产物路径
 * @return CMake 目标名，无法确定时返回 undefined
 */
export function cmakeTargetFromOutput(output?: string): string | undefined {
  return output?.replace(/\\/g, '/').match(/(?:^|\/)CMakeFiles\/([^/]+)\.dir\//)?.[1];
}

/**
 * @brief 为编译条目给出稳定的配置视图标识。
 * @param[in] entry 编译命令条目
 * @return CMake 目标或语义参数散列构成的稳定标识
 */
export function compilationViewKey(entry: CompileCommandEntry): string {
  if (entry.target) return `cmake:${entry.target}`;
  return `flags:${createHash('sha256').update(JSON.stringify([entry.compiler, entry.directory, entry.semanticFlags])).digest('hex').slice(0, 16)}`;
}

/**
 * @brief 读取共享 compilation database，保留同文件多命令并过滤项目外源文件。
 * @param[in] projectRoot 项目根目录
 * @param[in] explicitPath 显式路径；默认探测标准位置
 * @param[in] allowExternal 用户侧显式授权或旧 include 兼容路径允许外部数据库
 * @param[in] includeOnly 仅提取兼容 include 路径，不执行语义源文件 realpath 检查
 * @return 数据库模型；缺失、畸形或越界时返回 null
 */
export function loadCompilationDatabase(projectRoot: string, explicitPath?: string, allowExternal = false, includeOnly = false): CompilationDatabase | null {
  let root: string;
  let dbPath: string | null;
  try {
    root = fs.realpathSync(projectRoot);
    dbPath = findCompilationDatabase(root, explicitPath, allowExternal);
  } catch { return null; }
  if (!dbPath) return null;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    if (!Array.isArray(raw)) return null;
    const entries: CompileCommandEntry[] = [];
    const includes = new Set<string>();
    let excludedSources = 0;
    let incompleteCommands = 0;
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      if (row.directory !== undefined && typeof row.directory !== 'string') return null;
      if (row.command !== undefined && typeof row.command !== 'string') return null;
      if (row.arguments !== undefined && (!Array.isArray(row.arguments) || !row.arguments.every(a => typeof a === 'string'))) return null;
      const malformedOutput = row.output !== undefined && typeof row.output !== 'string';
      const directoryPath = path.resolve(path.dirname(dbPath), (row.directory as string) || root);
      const args = Array.isArray(row.arguments) ? row.arguments as string[] : typeof row.command === 'string' ? splitCompileCommand(row.command) : [];
      // include 搜索沿用旧行为：数据库中的外部 TU 仍可贡献项目内头目录。
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        let includeDir: string | undefined;
        if (arg.startsWith('-I') && arg.length > 2) includeDir = arg.slice(2);
        else if ((arg === '-isystem' || arg === '-I') && i + 1 < args.length) includeDir = args[++i];
        if (includeDir) {
          const rel = path.relative(root, path.resolve(directoryPath, includeDir)).replace(/\\/g, '/');
          if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) includes.add(rel);
        }
      }
      if (includeOnly) continue;
      const directory = canonicalizePotentialPath(directoryPath);
      if (!directory || typeof row.file !== 'string' || !row.file.trim()) {
        incompleteCommands++;
        continue;
      }
      const sourcePath = path.resolve(directory, row.file);
      // 非 C/C++ 编译项（例如汇编）不参与 C/C++ 的完整性证明。
      if (!/\.(?:c|C|cc|cpp|cxx|c\+\+|i|ii|h|hh|hpp|hxx)$/.test(sourcePath)) continue;
      if (malformedOutput) incompleteCommands++;
      if (!args.length) { incompleteCommands++; continue; }
      // 现存符号链接必须使用真实目标；未生成的 TU 仅使用词法路径。
      const realSource = canonicalizePotentialPath(sourcePath);
      if (!realSource) { excludedSources++; continue; }
      if (!isWithinProject(root, realSource)) { excludedSources++; continue; }
      const output = typeof row.output === 'string' ? row.output : args.find((_arg, i) => args[i - 1] === '-o') ?? args.find(a => a.startsWith('-o') && a.length > 2)?.slice(2);
      entries.push({ file: path.relative(root, realSource).replace(/\\/g, '/'), directory,
        compiler: args[0]!, arguments: args, output, semanticFlags: normalizeSemanticFlags(args, sourcePath, directory),
        target: cmakeTargetFromOutput(output) });
    }
    // 同一 CMake 目标若为同一源文件给出不同宏环境，单个视图无法证明完整覆盖。
    const targetCommands = new Map<string, string>();
    let conflictingTarget = false;
    for (const entry of entries) {
      if (!entry.target) continue;
      const key = JSON.stringify([entry.target, entry.file]);
      const signature = JSON.stringify([entry.compiler, entry.directory, entry.semanticFlags]);
      if (targetCommands.has(key) && targetCommands.get(key) !== signature) conflictingTarget = true;
      targetCommands.set(key, signature);
    }
    const allTargets = entries.every(entry => entry.target !== undefined);
    const authoritative = entries.length > 0 && incompleteCommands === 0 && allTargets && !conflictingTarget;
    return { path: dbPath, entries, includeDirectories: [...includes], excludedSources,
      inventory: authoritative ? 'authoritative' : 'advisory', grouping: allTargets ? 'cmake-target' : 'semantic-flags' };
  } catch { return null; }
}
