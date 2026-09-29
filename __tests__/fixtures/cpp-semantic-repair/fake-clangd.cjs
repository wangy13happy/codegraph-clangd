#!/usr/bin/env node
// Minimal byte-framed LSP server used only for protocol/coverage tests, not clangd semantics.
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const compileArg = process.argv.find(arg => arg.startsWith('--compile-commands-dir='));
const rows = JSON.parse(fs.readFileSync(path.join(compileArg.slice('--compile-commands-dir='.length), 'compile_commands.json'), 'utf8'));
fs.writeFileSync(path.join(compileArg.slice('--compile-commands-dir='.length), 'fake.pid'), String(process.pid));
const args = rows.flatMap(row => row.arguments);
const two = args.includes('-DVARIANT_TWO');
const fail = args.includes('-DFAIL_VIEW');
const hang = args.includes('-DHANG_VIEW');
const hangInitialize = args.includes('-DHANG_INITIALIZE');
const delayedIndex = args.includes('-DDELAY_INDEX');
let indexReady = !delayedIndex;
if (args.includes('-DEXIT_EARLY')) process.exit(2);
const opened = new Map();
let pending = Buffer.alloc(0);

/**
 * @brief 用 LSP 字节帧发送模拟响应。
 * @param[in] id 请求 ID
 * @param[in] result 正常响应
 * @param[in] error 协议错误
 * @return 无
 */
function send(id, result, error) {
  const body = Buffer.from(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

/**
 * @brief 发送模拟的诊断通知。
 * @param[in] uri 当前编译视图的源文件 URI
 * @return 无
 */
function sendDiagnostics(uri) {
  const file = fileURLToPath(uri);
  const ownArgs = rows.find(row => path.resolve(row.file) === file)?.arguments ?? [];
  const diagnostics = ownArgs.includes('-DDIAG_ERROR') ? [{ severity: 1, message: 'fixture parse error',
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
    : ownArgs.includes('-DDIAG_WARNING') ? [{ severity: 2, message: 'fixture warning',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] : [];
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
    params: { uri, version: 1, diagnostics } }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

/**
 * @brief 模拟 clangd 的 sync 测试扩展等待另一 TU 索引完成。
 * @param[in] id sync 请求 ID
 * @return 无
 */
function respondWhenIdle(id) {
  if (indexReady) send(id, null);
  else setTimeout(() => respondWhenIdle(id), 10);
}

/**
 * @brief 在测试源文本中定位 LSP 零起始坐标。
 * @param[in] text 源文本
 * @param[in] needle 待匹配文本
 * @param[in] last 是否选择末次出现的位置
 * @return 行列位置
 */
function position(text, needle, last = false) {
  const offset = last ? text.lastIndexOf(needle) : text.indexOf(needle);
  const prefix = text.slice(0, offset);
  return { line: prefix.split('\n').length - 1, character: prefix.split('\n').at(-1).length };
}

/**
 * @brief 为协议测试生成函数的文档符号和调用层级身份。
 * @param[in] uri 文档 URI
 * @param[in] name 函数名
 * @param[in] text 文档全文
 * @param[in] startNeedle 函数声明文本
 * @param[in] endNeedle 函数结束文本
 * @param[in] detail 函数签名
 * @return 文档符号
 */
function symbol(uri, name, text, startNeedle, endNeedle, detail) {
  const start = position(text, startNeedle);
  const endOffset = text.indexOf(endNeedle, text.indexOf(startNeedle));
  const end = position(text.slice(0, endOffset + endNeedle.length), endNeedle, true);
  return { name, kind: 12, uri, range: { start, end: { line: end.line, character: end.character + endNeedle.length } },
    selectionRange: { start: { line: start.line, character: start.character + startNeedle.indexOf(name) }, end: start },
    detail };
}

/**
 * @brief 按模拟视图返回目标 TU 的文档符号。
 * @param[in] uri 文档 URI
 * @return 当前编译变体的函数符号
 */
function documentSymbols(uri) {
  const text = opened.get(uri);
  const file = path.basename(fileURLToPath(uri));
  if (file === 'callee.c') return [symbol(uri, 'external_target', text, 'int external_target(void) {', '}', 'int external_target(void)')];
  if (file === 'caller.c') return [symbol(uri, 'from_other', text, 'int from_other(void) {', '}', 'int from_other(void)')];
  if (file === 'variant.c') {
    const detail = two ? 'int feature(void)' : 'int feature(int value)';
    return [symbol(uri, 'feature', text, two ? 'int feature(void)' : 'int feature(int value)', '}', detail),
      symbol(uri, 'invoke', text, 'int invoke(void)', '}', 'int invoke(void)')];
  }
  return [symbol(uri, 'helper', text, 'static int helper(void)', '}', 'int helper(void)')];
}

/**
 * @brief 处理协议测试覆盖的 LSP 方法。
 * @param[in] message 请求或通知
 * @return 无
 */
function handle(message) {
  if (message.method === 'textDocument/didOpen') {
    const uri = message.params.textDocument.uri;
    opened.set(uri, message.params.textDocument.text);
    if (delayedIndex && path.basename(fileURLToPath(uri)) === 'caller.c') {
      setTimeout(() => { indexReady = true; sendDiagnostics(uri); }, 600);
    } else sendDiagnostics(uri);
    return;
  }
  if (message.method === 'initialized' || message.method === '$/cancelRequest') return;
  if (message.method === 'exit') { process.exit(0); return; }
  if (message.method === 'initialize') {
    if (!hangInitialize) send(message.id, { capabilities: { documentSymbolProvider: true, callHierarchyProvider: true } });
    return;
  }
  if (message.method === 'shutdown') { send(message.id, null); return; }
  if (message.method === 'sync') {
    if (args.includes('-DNO_SYNC')) send(message.id, null, { code: -32601, message: 'sync unsupported' });
    else if (!args.includes('-DHANG_SYNC')) respondWhenIdle(message.id);
    return;
  }
  if (message.method === 'textDocument/documentSymbol') {
    if (hang) return;
    if (fail) { send(message.id, null, { code: -32603, message: 'fixture failure' }); return; }
    send(message.id, documentSymbols(message.params.textDocument.uri).map(({ uri, ...item }) => item)); return;
  }
  if (message.method === 'textDocument/prepareCallHierarchy') {
    const uri = message.params.textDocument.uri;
    send(message.id, documentSymbols(uri).filter(item => item.selectionRange.start.line === message.params.position.line)); return;
  }
  if (message.method === 'callHierarchy/incomingCalls') {
    const target = message.params.item;
    if (target.name === 'external_target') {
      if (!indexReady) { send(message.id, []); return; }
      const callerUri = [...opened.keys()].find(uri => path.basename(fileURLToPath(uri)) === 'caller.c');
      const text = opened.get(callerUri);
      const caller = symbol(callerUri, 'from_other', text, 'int from_other(void) {', '}', 'int from_other(void)');
      const pos = position(text, 'external_target();');
      send(message.id, [{ from: caller, fromRanges: [{ start: pos, end: pos }] }]); return;
    }
    if (target.name !== 'feature') { send(message.id, []); return; }
    const text = opened.get(target.uri);
    const caller = symbol(target.uri, 'invoke', text, 'int invoke(void)', '}', 'int invoke(void)');
    const pos = position(text, two ? 'feature();' : 'feature(1);');
    send(message.id, [{ from: caller, fromRanges: [{ start: pos, end: pos }] }]); return;
  }
  send(message.id, null, { code: -32601, message: 'method not found' });
}

process.stdin.on('data', chunk => {
  pending = Buffer.concat([pending, chunk]);
  while (true) {
    const headerEnd = pending.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = pending.subarray(0, headerEnd).toString();
    const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1]);
    if (!Number.isFinite(length) || pending.length < headerEnd + 4 + length) break;
    const payload = pending.subarray(headerEnd + 4, headerEnd + 4 + length);
    pending = pending.subarray(headerEnd + 4 + length);
    handle(JSON.parse(payload.toString()));
  }
});
