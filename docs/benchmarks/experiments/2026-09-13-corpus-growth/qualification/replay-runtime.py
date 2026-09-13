#!/usr/bin/env python3
"""Replay admitted runtime controls from local BugsJS clones and frozen npm locks.

--sources contains clones named bugsjs-mongoose, bugsjs-hexo, bugsjs-karma and
bugsjs-node_redis. --work is disposable. --only accepts corpus IDs, comma separated.
The exact declared fixture operation or full module runs on its historical host.
"""

import argparse
import hashlib
import io
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def unpack(data, destination, skip_test_links=False):
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member in archive.getmembers():
            name = Path(member.name)
            assert not name.is_absolute() and ".." not in name.parts
            target = destination / name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.extractfile(member).read())
            elif not (skip_test_links and member.issym()):
                raise ValueError("Unexpected archive member " + member.name)


def projection(result, control):
    records = result.get("observations", result.get("records", []))
    if control in ["legacy", "hexo"]:
        # These original assertion controls record outcomes, not value traces. Failure
        # messages can include freshly generated BSON IDs; compare the assertion and
        # exception identity, with the same expected failure counts in every stage.
        return [{"name": r["name"], "pass": r["pass"], "errorName": r.get("error", {}).get("name")} for r in records]
    # Source locations and timing are execution details, not observable contract equality.
    return [{k: v for k, v in record.items() if k != "error"} | {
        "error": {k: v for k, v in record.get("error", {}).items() if k != "stack"}
    } if isinstance(record.get("error", {}), dict) else
        {k: v for k, v in record.items() if k != "stack"} for record in records]


def normalize_edges(value, directory):
    if isinstance(value, str):
        return value.replace(str(directory), "<case>")
    if isinstance(value, list):
        return [normalize_edges(item, directory) for item in value]
    if isinstance(value, dict):
        # Optimist's $0 is the harness invocation path, not the CLI options being tested.
        # Temporary preprocessor names hash the absolute input path; preserve extension.
        return {key: "<control-command>" if key == "$0" else
                re.sub(r"^[0-9a-f]{40}(?=\.)", "<path-sha1>", item) if key == "contentPath" and isinstance(item, str) else normalize_edges(item, directory)
                for key, item in value.items() if key != "stack"}
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--only")
    args = parser.parse_args()
    work = args.work.resolve()
    work.mkdir(parents=True, exist_ok=True)
    selected = set(args.only.split(",")) if args.only else None
    manifest = json.loads((HERE / "runtime-manifest.json").read_text())
    cases = [c for c in manifest["cases"] if selected is None or c["id"] in selected]
    assert cases and (selected is None or selected == {c["id"] for c in cases})
    rows = {r["id"]: r for r in map(json.loads, (ROOT / "gate-engine/review/eval/reviewers/cases-correctness.jsonl").read_text().splitlines())}
    receipts = []
    for case in cases:
        group, number = case["group"], case["number"]
        clone = args.sources.resolve() / ("bugsjs-node_redis" if group == "redis" else "bugsjs-" + group)

        def git(*arguments):
            return subprocess.check_output(["git", "-C", str(clone), *arguments])

        directory = work / (group + "-qualification") / str(number)
        checkout = directory / "source"
        checkout.mkdir(parents=True, exist_ok=True)
        tree = git("ls-tree", "--name-only", case["baseCommit"]).decode().splitlines()
        wanted = ["lib", "index.js", "package.json", "static", "tasks", ".babelrc", "Gruntfile.js", "gruntfile.js"]
        paths = [p for p in tree if p in wanted or "licen" in p.lower()]
        unpack(git("archive", "--format=tar", case["baseCommit"], *paths), checkout)
        if group == "karma":
            unpack(git("archive", "--format=tar", case["testRef"], "test"), checkout, skip_test_links=True)
            (directory / "manifest.json").write_text(json.dumps({"tag": case["tag"], "unitTests": case["unitTests"]}))
        runtime = work / case["runtime"]
        runtime.mkdir(parents=True, exist_ok=True)
        for name in ["package.json", "package-lock.json"]:
            shutil.copyfile(HERE / case["runtime"] / name, runtime / name)
        assert sha((runtime / "package-lock.json").read_bytes()) == case["lockSha256"]
        installed = runtime / "installed-lock-sha256.txt"
        if not installed.exists() or installed.read_text() != case["lockSha256"]:
            with (runtime / "install.log").open("w") as log:
                subprocess.run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps"],
                               cwd=runtime, stdout=log, stderr=subprocess.STDOUT, check=True)
            installed.write_text(case["lockSha256"])
        for extra in case["runtimeFiles"]:
            data = (HERE / extra["source"]).read_bytes()
            assert sha(data) == extra["sha256"]
            target = runtime / extra["destination"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        modules = checkout / "node_modules"
        if modules.is_symlink():
            modules.unlink()
        assert not modules.exists()
        modules.symlink_to(runtime / "node_modules", target_is_directory=True)
        outputs, edges, raw_edges = {}, {}, {}
        for stage, ref, fixture_key in [("base", case["baseCommit"], "base"), ("repair", case["repairCommit"], "staged")]:
            fixture = rows[case["id"]]["repo"][fixture_key]
            assert {f: sha(b.encode()) for f, b in fixture.items()} == case["fixtureHashes"][stage]
            originals = {f: git("show", ref + ":" + f) for f in case["files"]}
            assert {f: sha(b) for f, b in originals.items()} == case["sourceHashes"][stage]
            for kind in [stage, stage + "-adapted"]:
                for name, data in originals.items():
                    (checkout / name).write_bytes(data)
                    saved_source = directory / kind / name
                    saved_source.parent.mkdir(parents=True, exist_ok=True)
                    saved_source.write_bytes(data)
                if kind.endswith("-adapted"):
                    if case["mode"] == "operation":
                        operation = directory / (kind + ".cjs")
                        bodies = [b for f, b in fixture.items() if f.endswith(".js")]
                        assert len(bodies) == 1
                        operation.write_text(bodies[0])
                        name = case["files"][0]
                        module = originals[name].decode()
                        for edit in reversed(case["operationMounts"][stage]):
                            module = module[:edit["start"]] + edit["replacement"] + module[edit["end"]:]
                        module = module.replace("__ADAPTATION_MODULE__", str(operation))
                        (checkout / name).write_text(module)
                    else:
                        for name, body in fixture.items():
                            if not name.startswith("src/"):
                                continue
                            target = checkout / name.removeprefix("src/")
                            target.parent.mkdir(parents=True, exist_ok=True)
                            saved_adaptation = directory / kind / name.removeprefix("src/")
                            saved_adaptation.parent.mkdir(parents=True, exist_ok=True)
                            saved_adaptation.write_text(body)
                            if case["mode"] == "modules":
                                target.write_text(body)
                            elif case.get("privateVmBody"):
                                prefix = "module.exports = function loadSourceModule(module, exports, require, __filename, __dirname) {\n"
                                suffix = "\n};\n"
                                assert body.startswith(prefix) and body.endswith(suffix)
                                target.write_text(body[len(prefix):-len(suffix)])
                            else:
                                adaptation = directory / kind / name
                                adaptation.parent.mkdir(parents=True, exist_ok=True)
                                adaptation.write_text(body)
                                target.write_text("require(" + json.dumps(str(adaptation)) + ").call(exports,module,exports,require,__filename,__dirname);\n")
                output = directory / (kind + "-replay.json")
                control = case["control"]
                env = {**os.environ, "QUALIFICATION_WORK_ROOT": str(work)}
                if control in ["legacy", "hexo"]:
                    script = "mongoose-controls.cjs" if control == "legacy" else "hexo-controls.cjs"
                    command = ["node", str(HERE / script), str(number), kind]
                    saved = directory / (kind + ("-source-controls.json" if control == "legacy" else "-controls.json"))
                elif group == "karma":
                    command = ["node", str(HERE / "run-karma-source.cjs"), str(checkout), str(output)]
                    saved = output
                else:
                    script = "redis-controls.cjs" if group == "redis" else "mongoose-" + control + "-controls.cjs"
                    command = ["node", str(HERE / script), str(number), str(checkout), str(output)]
                    saved = output
                with (directory / (kind + "-process.log")).open("w") as log:
                    process = subprocess.run(command, cwd=checkout, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=90)
                result = json.loads(saved.read_text())
                assert not result.get("fatal"), (case["id"], kind, result.get("fatal"))
                assert process.returncode in ([0, 1] if group == "karma" else [0])
                total = result.get("total", len(result.get("records", [])))
                failed = result.get("failed", result.get("stats", {}).get("failures", sum(r.get("status") == "fail" for r in result.get("records", []))))
                timing = set(case.get("timingSensitiveBaseTests", [])) if stage == "base" else set()
                if timing:
                    assert total == case["expected"][stage]["total"]
                    assert timing <= {r["name"] for r in result["records"]}
                    assert all(r["status"] == "pass" for r in result["records"] if r["name"] not in timing)
                else:
                    assert {"total": total, "failed": failed} == case["expected"][stage], (case["id"], kind, total, failed)
                outputs[kind] = result
                if saved != output:
                    shutil.copyfile(saved, output)
                if case.get("edgeControl"):
                    edge_output = directory / (kind + "-edges.json")
                    temp = directory / "edge-temp"
                    temp.mkdir(exist_ok=True)
                    with (directory / (kind + "-edges.log")).open("w") as log:
                        subprocess.run(["node", str(HERE / case["edgeControl"]), str(number), str(directory), kind, str(edge_output)],
                                       cwd=checkout, env={**env, "TMPDIR": str(temp)}, stdout=log, stderr=subprocess.STDOUT, timeout=30, check=True)
                    edge_result = json.loads(edge_output.read_text())
                    assert not edge_result.get("fatal"), (case["id"], kind, edge_result.get("fatal"))
                    raw_edges[kind] = edge_result["records"]
                    edges[kind] = normalize_edges(raw_edges[kind], directory)
                    assert edges[kind] == case["edgeExpected"][stage], (case["id"], kind, "independent witness drift")
            timing = set(case.get("timingSensitiveBaseTests", [])) if stage == "base" else set()
            stable = lambda result: [r for r in projection(result, case["control"]) if r["name"] not in timing]
            assert stable(outputs[stage]) == stable(outputs[stage + "-adapted"]), (case["id"], stage, "stable published conformance")
            if edges:
                assert raw_edges[stage] == raw_edges[stage + "-adapted"], (case["id"], stage, "independent conformance")
        receipt = {"id": case["id"], "observations": sum(o.get("total", len(o.get("records", []))) for o in outputs.values()), "independentObservations": sum(map(len, edges.values())), "sourceAdaptationAgrees": True}
        if case.get("timingSensitiveBaseTests"):
            receipt["sourceAdaptationAgrees"] = projection(outputs["base"], case["control"]) == projection(outputs["base-adapted"], case["control"])
            receipt["stablePublishedSourceAdaptationAgrees"] = True
            receipt["independentSourceAdaptationAgrees"] = True
            receipt["timingDisclosure"] = case["timingDisclosure"]
            receipt["timingSensitiveBaseObservations"] = {stage: [r for r in projection(outputs[stage], case["control"]) if r["name"] in case["timingSensitiveBaseTests"]] for stage in ["base", "base-adapted"]}
        receipts.append(receipt)
        print(json.dumps(receipt), flush=True)
    (work / "replay-results.json").write_text(json.dumps(receipts, indent=2) + "\n")


if __name__ == "__main__":
    main()
