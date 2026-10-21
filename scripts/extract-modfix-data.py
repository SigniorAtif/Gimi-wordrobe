"""Build src-tauri/resources/modfix_data.json (gitignored) from local copies of the two community fixer scripts.

The app does the fixing itself (src-tauri/src/core/modfix.rs) but needs their hash tables, which aren't ours to
publish, so they stay on this machine:

    npm run modfix-data -- <57ReleaseVersion.py> <ORFixApplier_Ver_4_2.py>

The scripts are only parsed (ast), never run. Re-run with newer versions of them to pick up new characters.
"""

import ast
import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "resources" / "modfix_data.json"


def assignments(tree: ast.AST) -> dict[str, ast.AST]:
    out = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            out.setdefault(node.targets[0].id, node.value)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
            out.setdefault(node.target.id, node.value)
    return out


def pairs(d: dict) -> list[list[str]]:
    return [[k.lower(), v.lower()] for k, v in d.items()]


def release_fix(path: Path) -> dict:
    a = assignments(ast.parse(path.read_text(encoding="utf-8")))
    lit = lambda name: ast.literal_eval(a[name])
    # same filtering as the script's module-level loops
    v41 = {j["old_draw_vb"]: j["new_draw_vb"] for j in lit("alljson_41") if j["new_draw_vb"] and j["old_draw_vb"]}
    v43 = {j["old_ib"]: j["new_ib"] for j in lit("alljson_43") if j["new_ib"] and j["old_ib"]}
    v54 = {}
    for chars in lit("old_vs_new_54").values():
        for hashes in chars.values():
            v54.update(hashes)
    remaps = []
    for key, call in zip(a["remaps"].keys, a["remaps"].values):
        name, mapping = (ast.literal_eval(x) for x in call.args)
        remaps.append({"trigger": ast.literal_eval(key).lower(), "name": name, "mapping": mapping})
    return {
        "steps": [
            {"version": "4.1", "pairs": pairs(v41)},
            {"version": "4.3", "pairs": pairs(v43)},
            {"version": "4.4-4.7", "pairs": pairs(lit("old_vs_new"))},
            {"version": "5.4", "pairs": pairs(v54)},
        ],
        "remaps": remaps,
    }


def orfix(path: Path) -> tuple[list[dict], list[str]]:
    a = assignments(ast.parse(path.read_text(encoding="utf-8")))
    rows = ast.literal_eval(a["chara_name_position_ib_hash"])
    # pre-ORFix shader fix blocks the applier strips (removed verbatim)
    old_fixes = ast.literal_eval(a["old_fixes"])
    return [
        {
            "name": r["name"],
            "component": r["component"],
            "ib": r["ib_hash"].lower(),
            "normal": [[p, i] for p, i in r["normal_parts"]],
            "noNormal": [[p, i] for p, i in r["no_normal_parts"]],
        }
        for r in rows
    ], old_fixes


def main() -> None:
    release, applier = (Path(p) for p in sys.argv[1:3])
    parts, old_fixes = orfix(applier)
    data = {
        "source": {
            "releaseFix": release.name,
            "orfixApplier": applier.name,
        },
        "releaseFix": release_fix(release),
        "orfix": parts,
        "oldShaderFixes": old_fixes,
    }
    OUT.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
    steps = data["releaseFix"]["steps"]
    print(f"wrote {OUT}: " + ", ".join(f"{s['version']}={len(s['pairs'])}" for s in steps)
          + f", remaps={len(data['releaseFix']['remaps'])}, orfix={len(data['orfix'])}")


if __name__ == "__main__":
    main()
