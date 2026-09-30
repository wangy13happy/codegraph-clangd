"""同一项目 TU 的最小宏展开直接目标出口；标准库 ctypes，不运行编译器。"""
import ctypes as c
import hashlib
import json
import os
import sys
import time


class CXString(c.Structure):
    _fields_ = [("data", c.c_void_p), ("private_flags", c.c_uint)]


class CXCursor(c.Structure):
    _fields_ = [("kind", c.c_uint), ("xdata", c.c_int), ("data", c.c_void_p * 3)]


class CXSourceLocation(c.Structure):
    _fields_ = [("ptr_data", c.c_void_p * 2), ("int_data", c.c_uint)]


class CXSourceRange(c.Structure):
    _fields_ = [("ptr_data", c.c_void_p * 2), ("begin_int_data", c.c_uint), ("end_int_data", c.c_uint)]


VISITOR = c.CFUNCTYPE(c.c_uint, CXCursor, CXCursor, c.c_void_p)


def run(request):
    """
    /**
     * @brief 以受控 FullArgv 解析单 TU，只输出真实宏展开的直接 FunctionDecl 目标。
     * @param[in] request 主文件、同会话 context、宏物理范围与可信共享库路径
     * @return 回显身份、覆盖状态、直接目标和有界统计；未知绑定不猜测
     */
    """
    lib = c.CDLL(request["library"])
    prototypes = {
        "clang_createIndex": (c.c_void_p, [c.c_int, c.c_int]),
        "clang_disposeIndex": (None, [c.c_void_p]),
        "clang_parseTranslationUnit2FullArgv": (c.c_int, [c.c_void_p, c.c_char_p, c.POINTER(c.c_char_p), c.c_int, c.c_void_p, c.c_uint, c.c_uint, c.POINTER(c.c_void_p)]),
        "clang_disposeTranslationUnit": (None, [c.c_void_p]),
        "clang_getTranslationUnitCursor": (CXCursor, [c.c_void_p]),
        "clang_visitChildren": (c.c_uint, [CXCursor, VISITOR, c.c_void_p]),
        "clang_getCursorSpelling": (CXString, [CXCursor]),
        "clang_getCursorUSR": (CXString, [CXCursor]),
        "clang_getCursorReferenced": (CXCursor, [CXCursor]),
        "clang_getCanonicalCursor": (CXCursor, [CXCursor]),
        "clang_getCursorDefinition": (CXCursor, [CXCursor]),
        "clang_getCursorLinkage": (c.c_uint, [CXCursor]),
        "clang_getCursorLocation": (CXSourceLocation, [CXCursor]),
        "clang_getCursorExtent": (CXSourceRange, [CXCursor]),
        "clang_getRangeStart": (CXSourceLocation, [CXSourceRange]),
        "clang_getRangeEnd": (CXSourceLocation, [CXSourceRange]),
        "clang_getExpansionLocation": (None, [CXSourceLocation, c.POINTER(c.c_void_p), c.POINTER(c.c_uint), c.POINTER(c.c_uint), c.POINTER(c.c_uint)]),
        "clang_getSpellingLocation": (None, [CXSourceLocation, c.POINTER(c.c_void_p), c.POINTER(c.c_uint), c.POINTER(c.c_uint), c.POINTER(c.c_uint)]),
        "clang_getFileName": (CXString, [c.c_void_p]),
        "clang_getCString": (c.c_char_p, [CXString]),
        "clang_disposeString": (None, [CXString]),
        "clang_getNumDiagnostics": (c.c_uint, [c.c_void_p]),
        "clang_getDiagnostic": (c.c_void_p, [c.c_void_p, c.c_uint]),
        "clang_getDiagnosticSeverity": (c.c_uint, [c.c_void_p]),
        "clang_disposeDiagnostic": (None, [c.c_void_p]),
        "clang_getClangVersion": (CXString, []),
        "clang_Cursor_isDynamicCall": (c.c_int, [CXCursor]),
        "clang_getTranslationUnitTargetInfo": (c.c_void_p, [c.c_void_p]),
        "clang_TargetInfo_getTriple": (CXString, [c.c_void_p]),
        "clang_TargetInfo_getPointerWidth": (c.c_int, [c.c_void_p]),
        "clang_TargetInfo_dispose": (None, [c.c_void_p]),
    }
    for name, (result, arguments) in prototypes.items():
        function = getattr(lib, name)
        function.restype, function.argtypes = result, arguments

    def text(value):
        """
        /**
         * @brief 转换并释放原生字符串。
         * @param[in] value libclang CXString
         * @return 严格 UTF-8 字符串；无内容为空串
         */
        """
        try:
            return (lib.clang_getCString(value) or b"").decode("utf-8")
        finally:
            lib.clang_disposeString(value)

    def location(value, expansion=False):
        """
        /**
         * @brief 读取物理 spelling 或 expansion 位置，不采纳 presumed 文件名。
         * @param[in] value 原生位置
         * @param[in] expansion true 读取宏调用展开位置
         * @return 真实文件与一起始行列；scratch 或无物理文件返回 null
         */
        """
        file, line, column, offset = c.c_void_p(), c.c_uint(), c.c_uint(), c.c_uint()
        function = lib.clang_getExpansionLocation if expansion else lib.clang_getSpellingLocation
        function(value, c.byref(file), c.byref(line), c.byref(column), c.byref(offset))
        if not file.value:
            return None
        return {"file": os.path.realpath(text(lib.clang_getFileName(file))),
                "line": line.value, "column": column.value, "offset": offset.value}

    def identity(cursor, caller=False):
        """
        /**
         * @brief 读取 canonical USR/linkage 与实际声明或定义的物理范围。
         * @param[in] cursor 实际 caller 或 CallExpr referenced cursor
         * @param[in] caller caller 使用当前定义范围，不降为 canonical 前置声明范围
         * @return 原生身份及半开字节范围；缺失物理信息保留 null
         */
        """
        canonical = lib.clang_getCanonicalCursor(cursor)
        definition = lib.clang_getCursorDefinition(cursor)
        physical_cursor = cursor if caller else definition if definition.kind in (8, 21) else canonical
        value = lib.clang_getCursorExtent(physical_cursor)
        return {"kind": canonical.kind, "name": text(lib.clang_getCursorSpelling(canonical)),
                "usr": text(lib.clang_getCursorUSR(canonical)),
                "linkage": lib.clang_getCursorLinkage(canonical),
                "physical": location(lib.clang_getCursorLocation(canonical)),
                "start": location(lib.clang_getRangeStart(value)),
                "end": location(lib.clang_getRangeEnd(value))}

    started = time.monotonic()
    main_file = request["mainFile"]
    with open(main_file, "rb") as source:
        if hashlib.sha256(source.read()).hexdigest() != request["mainFileHash"]:
            raise ValueError("main file changed before native parse")
    os.chdir(request["context"]["directory"])
    arguments = [arg.encode("utf-8") for arg in request["argv"]]
    argv = (c.c_char_p * len(arguments))(*arguments)
    index, tu = lib.clang_createIndex(1, 0), c.c_void_p()
    reasons, calls = [], []
    visited, skipped = 0, 0
    reply = {"protocolVersion": 1, "configId": request["configId"], "mainFile": main_file,
             "mainFileHash": request["mainFileHash"], "contextHash": request["context"]["hash"],
             "libraryVersion": text(lib.clang_getClangVersion()), "calls": calls}
    try:
        # 0 不请求 DetailedPreprocessingRecord；头文件仅用于这一个 TU 的原生语义。
        result = lib.clang_parseTranslationUnit2FullArgv(index, None, argv, len(arguments), None, 0, 0, c.byref(tu))
        if result or not tu.value:
            raise ValueError("libclang parse failed: " + str(result))
        target = lib.clang_getTranslationUnitTargetInfo(tu)
        try:
            reply["triple"] = text(lib.clang_TargetInfo_getTriple(target))
            reply["pointerWidth"] = lib.clang_TargetInfo_getPointerWidth(target)
        finally:
            lib.clang_TargetInfo_dispose(target)
        diagnostics = lib.clang_getNumDiagnostics(tu)
        if diagnostics > 256:
            reasons.append("diagnostic budget exceeded")
        for number in range(min(diagnostics, 256)):
            diagnostic = lib.clang_getDiagnostic(tu, number)
            try:
                if lib.clang_getDiagnosticSeverity(diagnostic) >= 3:
                    reasons.append("native parse diagnostics contain errors")
                    break
            finally:
                lib.clang_disposeDiagnostic(diagnostic)
        invocation_keys = {(item["line"], item["column"]) for item in request["invocations"]}
        definitions = request["macros"]
        aborted = False

        def walk(cursor, caller, depth):
            """
            /**
             * @brief 逐层有界遍历主文件 AST，在枚举时立即剪枝外部顶层节点。
             * @param[in] cursor 当前原生节点
             * @param[in] caller 当前函数定义身份
             * @param[in] depth 当前递归深度
             * @return 无；预算或未知绑定只产生 partial，不搜索参数补目标
             */
            """
            nonlocal visited, skipped, aborted
            if aborted:
                return
            visited += 1
            if visited > 10000 or depth > 64 or time.monotonic() - started > 4:
                reasons.append("native AST budget exceeded")
                aborted = True
                return
            source = lib.clang_getCursorLocation(cursor)
            expansion = location(source, True)
            if depth != 0 and (not expansion or expansion["file"] != main_file):
                skipped += 1
                return
            if cursor.kind in (8, 21):
                extent = lib.clang_getCursorExtent(cursor)
                start = location(lib.clang_getRangeStart(extent), True)
                end = location(lib.clang_getRangeEnd(extent), True)
                if not start or not end or not any(
                        (line, column) >= (start["line"], start["column"]) and
                        (line, column) < (end["line"], end["column"])
                        for line, column in invocation_keys):
                    return
                caller = identity(cursor, True)
            elif 100 <= cursor.kind < 300 and expansion:
                # 只进入包含候选宏展开点的表达式/语句；普通 direct call 与无关函数体仍走 clangd。
                # 宏节点的 extent 可能折叠到同一 expansion 点，所以显式保留点相等的节点。
                extent = lib.clang_getCursorExtent(cursor)
                start = location(lib.clang_getRangeStart(extent), True)
                end = location(lib.clang_getRangeEnd(extent), True)
                if (expansion["line"], expansion["column"]) not in invocation_keys and start and end and not any(
                        (line, column) >= (start["line"], start["column"]) and
                        (line, column) < (end["line"], end["column"])
                        for line, column in invocation_keys):
                    return
            if cursor.kind == 103 and expansion and (expansion["line"], expansion["column"]) in invocation_keys:
                spelling = location(source)
                macro = next((item for item in definitions if spelling and spelling["file"] == item["file"]
                              and item["startLine"] <= spelling["line"] <= item["endLine"]), None)
                if macro:
                    referenced = lib.clang_getCursorReferenced(cursor)
                    target_identity = identity(referenced)
                    if referenced.kind in (8, 21) and not lib.clang_Cursor_isDynamicCall(cursor):
                        if len(calls) >= 1024:
                            reasons.append("native call budget exceeded")
                            aborted = True
                        else:
                            calls.append({"caller": caller, "target": target_identity,
                                          "expansion": expansion, "spelling": spelling, "macro": macro["nodeId"]})
                    elif referenced.kind == 70:
                        reasons.append("macro call target unresolved")
                    # ParmDecl/VarDecl 是真实间接调用，不升级为同名直接函数。
                elif not spelling:
                    reasons.append("macro spelling has no physical location")
                else:
                    # 有物理 spelling 但不在当前有界结构宏清单，可能来自 nested/unindexed 定义。
                    # 此处没有 absence 证据，不能静默 complete 后退役旧展开关系。
                    reasons.append("macro spelling definition not represented")

            @VISITOR
            def visit(child, parent, data):
                """
                /**
                 * @brief 在枚举回调内执行受预算约束的主文件遍历，不缓存外部子树。
                 * @param[in] child 当前子节点
                 * @param[in] parent 父节点（ABI 参数）
                 * @param[in] data 未使用的 ABI 参数
                 * @return 0 停止预算耗尽的枚举；1 继续本层但由 walk 控制递归
                 */
                """
                nonlocal aborted
                try:
                    walk(child, caller, depth + 1)
                except Exception:
                    reasons.append("native traversal failed")
                    aborted = True
                return 0 if aborted else 1

            if not aborted:
                lib.clang_visitChildren(cursor, visit, None)

        walk(lib.clang_getTranslationUnitCursor(tu), None, 0)
        with open(main_file, "rb") as source:
            if hashlib.sha256(source.read()).hexdigest() != request["mainFileHash"]:
                reasons.append("main file changed during native parse")
        reply.update({"complete": not reasons, "reasons": sorted(set(reasons)),
                      "visited": visited, "skippedHeaders": skipped,
                      "durationMs": (time.monotonic() - started) * 1000})
        return reply
    finally:
        if tu.value:
            lib.clang_disposeTranslationUnit(tu)
        lib.clang_disposeIndex(index)


if __name__ == "__main__":
    # 主进程先执行严格协议/argv 校验并提供超时；此处再次限制 stdin 容量。
    payload = sys.stdin.buffer.read(256 * 1024 + 1)
    if len(payload) > 256 * 1024:
        raise ValueError("native request byte budget exceeded")
    print(json.dumps(run(json.loads(payload)), ensure_ascii=False, separators=(",", ":")))
