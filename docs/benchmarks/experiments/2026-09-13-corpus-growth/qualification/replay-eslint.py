#!/usr/bin/env python3
"""Replay admitted ESLint source/adaptation controls on the frozen historical cores.

This experiment uses the existing qualification runner. It makes no model calls and
never edits the corpus. --source is a local clone of BugsJS/eslint; --work is a
disposable output/cache directory. Node 24.19.0 and npm must be on PATH.
"""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unpack(data, destination):
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member in archive.getmembers():
            relative = Path(member.name)
            assert not relative.is_absolute() and ".." not in relative.parts
            target = destination / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.extractfile(member).read())
            else:
                raise ValueError("Unexpected archive member " + member.name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--only", help="Comma-separated BugsJS numbers; default all admitted")
    args = parser.parse_args()
    source, work = args.source.resolve(), args.work.resolve()
    work.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((HERE / "eslint-manifest.json").read_text())
    selected = set(map(int, args.only.split(","))) if args.only else None
    cases = [c for c in manifest["cases"] if selected is None or c["number"] in selected]
    assert cases and (selected is None or selected == {c["number"] for c in cases})
    corpus = ROOT / "gate-engine/review/eval/reviewers/cases-correctness.jsonl"
    rows = {r["id"]: r for r in map(json.loads, corpus.read_text().splitlines())}
    results = []

    def git(*arguments):
        return subprocess.check_output(["git", "-C", str(source), *arguments])

    for case in cases:
        directory = work / str(case["number"])
        directory.mkdir(exist_ok=True)
        checkout = directory / "source"
        checkout.mkdir(exist_ok=True)
        tree = git("ls-tree", "--name-only", case["bug"]).decode().splitlines()
        paths = ["lib", "conf", "package.json"]
        paths += [p for p in tree if "licen" in p.lower()]
        paths += ["tests/fixtures"]
        archive = git("archive", "--format=tar", case["bug"], *paths)
        assert digest(archive) == case["archiveSha256"]
        unpack(archive, checkout)
        fixtures = git("archive", "--format=tar", case["testRef"], "tests/fixtures")
        assert digest(fixtures) == case["testFixtureArchiveSha256"]
        unpack(fixtures, checkout)
        test = checkout / case["test"]
        test.parent.mkdir(parents=True, exist_ok=True)
        test_bytes = git("show", case["testRef"] + ":" + case["test"])
        assert digest(test_bytes) == case["sourceTestSha256"]
        test.write_bytes(test_bytes)

        runtime = work / case["runtime"]
        runtime.mkdir(parents=True, exist_ok=True)
        for name in ["package.json", "package-lock.json"]:
            shutil.copyfile(HERE / case["runtime"] / name, runtime / name)
        assert digest((runtime / "package-lock.json").read_bytes()) == case["lockSha256"]
        install_receipt = runtime / "installed-lock-sha256.txt"
        if not install_receipt.exists() or install_receipt.read_text() != case["lockSha256"]:
            with (runtime / "install.log").open("w") as log:
                subprocess.run(
                    ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps"],
                    cwd=runtime, stdout=log, stderr=subprocess.STDOUT, check=True,
                )
            install_receipt.write_text(case["lockSha256"])
        modules = checkout / "node_modules"
        if modules.is_symlink():
            modules.unlink()
        assert not modules.exists()
        modules.symlink_to(runtime / "node_modules", target_is_directory=True)

        outputs = {}
        for stage, ref, fixture_key in [("base", case["bug"], "base"), ("repair", case["fix"], "staged")]:
            original = git("show", ref + ":" + case["rule"])
            assert digest(original) == case["sourceHashes"][stage]
            fixture = rows[case["id"]]["repo"][fixture_key]
            assert len(fixture) == 1
            adapted = next(iter(fixture.values())).encode()
            assert digest(adapted) == case["adaptedHashes"][stage]
            for kind, body in [(stage, original), (stage + "-adapted", adapted)]:
                (checkout / case["rule"]).write_bytes(body)
                output = directory / (kind + ".json")
                subprocess.run(
                    ["node", str(HERE / "eslint-published-tests.cjs"), str(test), str(output)],
                    cwd=checkout, check=True,
                )
                result = json.loads(output.read_text())
                expected = case["publishedStages"][kind]
                for field in ["total", "failed", "fatal", "unsupported"]:
                    assert result[field] == expected[field], (case["id"], kind, field)
                outputs[kind] = result
            assert outputs[stage]["observations"] == outputs[stage + "-adapted"]["observations"]
        receipt = {"id": case["id"], "observations": sum(o["total"] for o in outputs.values()),
                   "sourceAdaptationAgrees": True, "repairFailed": outputs["repair"]["failed"]}
        results.append(receipt)
        print(json.dumps(receipt), flush=True)
    (work / "replay-results.json").write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
