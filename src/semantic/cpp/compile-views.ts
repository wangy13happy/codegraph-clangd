/** @file C/C++ 编译视图分组与受控编译数据库生成。 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { CompilationDatabase, CompileCommandEntry, compilationViewKey, isWithinProject } from './compile-database';

export interface CompileView {
  id: string;
  key: string;
  entries: CompileCommandEntry[];
  inventory: 'authoritative' | 'advisory';
  grouping: 'cmake-target' | 'semantic-flags';
}

/**
 * @brief 将所有编译命令按可复现的配置身份分组，不折叠重复命令。
 * @param[in] database 已按项目边界过滤的共享编译数据库
 * @return 稳定排序的编译视图及其显式清单权威性
 */
export function buildCompileViews(database: CompilationDatabase): CompileView[] {
  const groups = new Map<string, CompileCommandEntry[]>();
  for (const entry of database.entries) {
    const key = compilationViewKey(entry);
    const entries = groups.get(key) ?? [];
    entries.push(entry);
    groups.set(key, entries);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, entries]) => ({
    id: createHash('sha256').update(key).digest('hex').slice(0, 24), key,
    entries: entries.sort((a, b) => JSON.stringify([a.file, a.directory, a.arguments, a.output])
      .localeCompare(JSON.stringify([b.file, b.directory, b.arguments, b.output]))),
    inventory: database.inventory,
    grouping: key.startsWith('cmake:') ? 'cmake-target' : 'semantic-flags',
  }));
}

/**
 * @brief 逐级建立生成目录并拒绝既有符号链接，避免写入项目外路径。
 * @param[in] directory 待建立目录的绝对路径
 * @param[in] root 项目真实根目录
 * @return 无；路径越界或遇到符号链接时抛出异常
 */
function ensureGeneratedDirectory(directory: string, root: string): void {
  if (!isWithinProject(root, directory)) throw new Error('Semantic compile directory escapes project root');
  if (directory !== root) ensureGeneratedDirectory(path.dirname(directory), root);
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe semantic compile directory: ${directory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { fs.mkdirSync(directory); }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure; }
    const created = fs.lstatSync(directory);
    if (!created.isDirectory() || created.isSymbolicLink()) throw new Error(`Unsafe semantic compile directory: ${directory}`);
  }
}

/**
 * @brief 将单个视图的完整原始命令按稳定顺序写入专属编译数据库。
 * @param[in] projectRoot 项目根目录
 * @param[in] view 待生成的编译视图
 * @return 生成数据库所在目录；任何不安全路径均抛出异常
 */
export function materializeCompileView(projectRoot: string, view: CompileView): string {
  const root = fs.realpathSync(projectRoot);
  if (!/^[a-f0-9]{24}$/.test(view.id)) throw new Error('Invalid semantic compile view ID');
  const directory = path.join(root, '.codegraph', 'semantic', 'compile-db', view.id);
  ensureGeneratedDirectory(directory, root);
  const destination = path.join(directory, 'compile_commands.json');
  try {
    fs.lstatSync(destination);
    // 不覆盖符号链接、硬链接或现存用户文件；后续运行只改写自己生成的普通文件。
    if (!fs.statSync(destination).isFile() || fs.lstatSync(destination).isSymbolicLink() || fs.statSync(destination).nlink !== 1) {
      throw new Error(`Unsafe semantic compile database: ${destination}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const rows = view.entries.map(entry => {
    const source = path.resolve(root, entry.file);
    if (path.isAbsolute(entry.file) || !isWithinProject(root, source)) {
      throw new Error(`Semantic compile source escapes project root: ${entry.file}`);
    }
    try {
      if (!isWithinProject(root, fs.realpathSync(source))) throw new Error(`Semantic compile source escapes project root: ${entry.file}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // PR1 允许尚未生成的项目内 TU；有源文件时必须按真实路径校验。
    }
    return { directory: entry.directory, file: source, arguments: entry.arguments,
      ...(entry.output === undefined ? {} : { output: entry.output }) };
  });
  // 同一视图并行生成时只会看到完整 JSON；随机临时名和 O_EXCL 防止抢占生成文件。
  const temporary = path.join(directory, `.compile_commands-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(rows, null, 2) + '\n');
  } catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(temporary);
    throw error;
  }
  fs.closeSync(fd);
  try { fs.renameSync(temporary, destination); }
  catch (error) { fs.unlinkSync(temporary); throw error; }
  return directory;
}
