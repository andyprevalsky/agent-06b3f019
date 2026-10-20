"""One real projection tick for fixtures; production keeps its persistent owner."""
import ast


def one_aggregate_tick(program: str) -> str:
    tree = ast.parse(program)
    driver = tree.body[-1]
    assert isinstance(driver, ast.While) and isinstance(driver.test, ast.Constant) and driver.test.value is True
    assert not driver.orelse and len(driver.body) == 2
    attempt, delay = driver.body
    assert isinstance(attempt, ast.Try) and not attempt.orelse and not attempt.finalbody
    assert len(attempt.body) == 1 and ast.unparse(attempt.body[0]) == "aggregate_tick()"
    assert [ast.unparse(handler.type) for handler in attempt.handlers] == ["SystemExit", "Exception"]
    assert ast.unparse(delay) == "time.sleep(1)"
    assert sum(isinstance(node, ast.FunctionDef) and node.name == "aggregate_tick" for node in tree.body) == 1
    before = ast.dump(ast.Module(body=tree.body[:-1], type_ignores=[]))
    tree.body[-1] = ast.Expr(value=ast.Call(func=ast.Name(id="aggregate_tick", ctx=ast.Load()), args=[], keywords=[]))
    adapted = ast.unparse(ast.fix_missing_locations(tree)) + "\n"
    assert ast.dump(ast.Module(body=ast.parse(adapted).body[:-1], type_ignores=[])) == before
    return adapted
