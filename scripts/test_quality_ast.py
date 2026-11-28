"""AST analysis of pytest test files, shared by `scripts/test_guard.py`.

Finds weakened tests: skip/xfail (per test, per class, or module-level `pytestmark`), trivial
assertions, swallowed assertions (try/except, `suppress`, `pytest.raises(AssertionError)`),
dead assertions (`if False:`, `if not True:`, after `return`/`raise`), and records each test's
assertions so `test_guard.py` can detect existing ones being rewritten.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass

BROAD_EXCEPT_NAMES: frozenset[str] = frozenset({"AssertionError", "Exception", "BaseException"})


@dataclass(frozen=True)
class TestFunctionStats:
    name: str
    assert_count: int
    has_skip_or_xfail: bool
    has_trivial_assert: bool
    has_swallowed_or_dead_assert: bool
    assertions: tuple[str, ...] = ()


def _is_constant_expr(node: ast.expr) -> bool:
    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, ast.UnaryOp):
        return _is_constant_expr(node.operand)
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return all(_is_constant_expr(el) for el in node.elts)
    return False


def _is_trivial_assert(node: ast.Assert) -> bool:
    test = node.test
    if isinstance(test, ast.Constant) and bool(test.value):
        return True
    if (
        isinstance(test, ast.UnaryOp)
        and isinstance(test.op, ast.Not)
        and isinstance(test.operand, ast.Constant)
        and not bool(test.operand.value)
    ):
        return True
    if isinstance(test, (ast.List, ast.Tuple, ast.Set)) and len(test.elts) > 0:
        return True
    if isinstance(test, ast.Compare) and len(test.ops) == 1 and len(test.comparators) == 1:
        right = test.comparators[0]
        if isinstance(test.ops[0], ast.Eq) and ast.dump(test.left) == ast.dump(right):
            return True
        if _is_constant_expr(test.left) and _is_constant_expr(right):
            return True
    return False


def _has_assert_inside(nodes: list[ast.stmt]) -> bool:
    for stmt in nodes:
        for child in ast.walk(stmt):
            if isinstance(child, ast.Assert):
                return True
    return False


def _catches_assertion_error(handler: ast.ExceptHandler) -> bool:
    if handler.type is None:
        return True
    if isinstance(handler.type, ast.Name):
        return handler.type.id in BROAD_EXCEPT_NAMES
    if isinstance(handler.type, ast.Tuple):
        return any(
            isinstance(el, ast.Name) and el.id in BROAD_EXCEPT_NAMES for el in handler.type.elts
        )
    return False


def _names_broad_exception(node: ast.expr) -> bool:
    """True for `AssertionError`, `builtins.Exception`, `(ValueError, AssertionError)`, etc."""
    if isinstance(node, ast.Name):
        return node.id in BROAD_EXCEPT_NAMES
    if isinstance(node, ast.Attribute):
        return node.attr in BROAD_EXCEPT_NAMES
    if isinstance(node, ast.Tuple):
        return any(_names_broad_exception(el) for el in node.elts)
    return False


def _swallows_assertions(item: ast.withitem) -> bool:
    """`with suppress(AssertionError):` or `with pytest.raises(AssertionError):` around asserts."""
    call = item.context_expr
    if not isinstance(call, ast.Call):
        return False
    func = ast.unparse(call.func)
    if not func.endswith(("suppress", "raises")):
        return False
    return any(_names_broad_exception(arg) for arg in call.args)


def _is_always_falsy(test: ast.expr) -> bool:
    """`if False:`, `if 0:`, `if not True:`, `if None:` ... — a branch that can never run."""
    if isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not):
        return _literal_truthiness(test.operand) is True
    return _literal_truthiness(test) is False


def _literal_truthiness(node: ast.expr) -> bool | None:
    """Truthiness of a literal expression, or None when it is not a literal."""
    try:
        value: object = ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
        return None
    return bool(value)


def _has_assert_after_exit(body: list[ast.stmt]) -> bool:
    """An assert placed after a `return`/`raise` in the same block never runs."""
    for idx, stmt in enumerate(body):
        if isinstance(stmt, (ast.Return, ast.Raise)) and _has_assert_inside(body[idx + 1 :]):
            return True
    return False


def _has_swallowed_or_dead_assert(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    for child in ast.walk(fn):
        if (
            isinstance(child, ast.Try)
            and _has_assert_inside(child.body)
            and any(_catches_assertion_error(h) for h in child.handlers)
        ):
            return True
        if (
            isinstance(child, (ast.If, ast.While))
            and _is_always_falsy(child.test)
            and _has_assert_inside(child.body)
        ):
            return True
        if (
            isinstance(child, (ast.With, ast.AsyncWith))
            and any(_swallows_assertions(item) for item in child.items)
            and _has_assert_inside(child.body)
        ):
            return True
        if any(_has_assert_after_exit(block) for block in _statement_blocks(child)):
            return True
    return False


def _statement_blocks(node: ast.AST) -> list[list[ast.stmt]]:
    blocks: list[list[ast.stmt]] = []
    if isinstance(
        node,
        (
            ast.FunctionDef,
            ast.AsyncFunctionDef,
            ast.For,
            ast.AsyncFor,
            ast.While,
            ast.If,
            ast.With,
            ast.AsyncWith,
            ast.Try,
            ast.ExceptHandler,
        ),
    ):
        blocks.append(node.body)
    if isinstance(node, (ast.For, ast.AsyncFor, ast.While, ast.If, ast.Try)):
        blocks.append(node.orelse)
    if isinstance(node, ast.Try):
        blocks.append(node.finalbody)
    return blocks


def _has_skip_decorator(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    for dec in fn.decorator_list:
        dumped = ast.unparse(dec)
        if "skip" in dumped or "xfail" in dumped:
            return True
    return False


def analyze_test_source(source: str) -> dict[str, TestFunctionStats]:
    tree = ast.parse(source)
    stats: dict[str, TestFunctionStats] = {}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if not node.name.startswith("test_"):
            continue
        asserts = 0
        has_trivial = False
        has_skip = _has_skip_decorator(node)
        assertions: list[str] = []
        for child in ast.walk(node):
            if isinstance(child, ast.Assert):
                asserts += 1
                assertions.append(ast.unparse(child))
                if _is_trivial_assert(child):
                    has_trivial = True
            elif isinstance(child, ast.Call):
                call_text = ast.unparse(child.func)
                if call_text.endswith("pytest.raises"):
                    asserts += 1
                    assertions.append(ast.unparse(child))
                if call_text.endswith(("pytest.skip", "pytest.xfail")):
                    has_skip = True
        stats[node.name] = TestFunctionStats(
            name=node.name,
            assert_count=asserts,
            has_skip_or_xfail=has_skip,
            has_trivial_assert=has_trivial,
            has_swallowed_or_dead_assert=_has_swallowed_or_dead_assert(node),
            assertions=tuple(sorted(assertions)),
        )
    return stats


def module_level_skip_issues(source: str) -> list[str]:
    """`pytestmark = pytest.mark.skip` (module or class level) and skip/xfail class decorators."""
    issues: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ClassDef):
            for dec in node.decorator_list:
                if "skip" in ast.unparse(dec) or "xfail" in ast.unparse(dec):
                    issues.append(f"class {node.name}: skip/xfail class decorator is banned.")
        targets: list[ast.expr] = []
        value: ast.expr | None = None
        if isinstance(node, ast.Assign):
            targets, value = node.targets, node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets, value = [node.target], node.value
        if value is None:
            continue
        names = {t.id for t in targets if isinstance(t, ast.Name)}
        text = ast.unparse(value)
        if "pytestmark" in names and ("skip" in text or "xfail" in text):
            issues.append("`pytestmark` with skip/xfail is banned.")
    return issues
