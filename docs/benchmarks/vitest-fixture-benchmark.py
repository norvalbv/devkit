"""Run from the repo root; stdout is the ledger-ready fixture measurement."""
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import statistics
import subprocess
import tempfile
import time

root = Path.cwd()
node = shutil.which('node')
runner = str(root / 'cli/__tests__/test-subprocess.mts')
origin = 'git@github.com:acme/app.git'
commands = [
    ['init', '-q', '-b', 'work'],
    ['config', 'user.email', 'a@b.c'],
    ['config', 'user.name', 'a'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', '.husky/.keep', '.gitignore'],
    ['commit', '-q', '-m', 'base'],
    ['config', 'core.hooksPath', '.husky/_'],
    ['remote', 'add', 'origin', origin],
]
rows = []
expected = None
for sample in range(1, 6):
    order = ['baseline', 'candidate'] if sample % 2 else ['candidate', 'baseline']
    for mode in order:
        directory = Path(tempfile.mkdtemp(prefix='devkit-fixture-bench-'))
        try:
            (directory / '.husky').mkdir()
            (directory / '.husky/.keep').write_text('')
            (directory / '.gitignore').write_text('.devkit/ship-intent-*\n')
            env = {**os.environ, 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_SYSTEM': '/dev/null'}
            batch = [['git', *args] for args in commands]
            before = resource.getrusage(resource.RUSAGE_CHILDREN)
            started = time.perf_counter()
            for command in batch:
                argv = command if mode == 'candidate' else [node, runner, '--group-only', '90000', '--', *command]
                subprocess.run(argv, cwd=directory, env=env, check=True, capture_output=True,
                               timeout=90 if mode == 'candidate' else None)
            after = resource.getrusage(resource.RUSAGE_CHILDREN)
            wall = 1000 * (time.perf_counter() - started)
            cpu = 1000 * ((after.ru_utime + after.ru_stime) - (before.ru_utime + before.ru_stime))
            state = [subprocess.check_output(['git', *args], cwd=directory, env=env, text=True).strip()
                     for args in [['rev-parse', 'HEAD^{tree}'], ['branch', '--show-current'],
                                  ['config', 'core.hooksPath'], ['remote', 'get-url', 'origin'],
                                  ['status', '--porcelain']]]
            if expected is None:
                expected = state
            assert state == expected, (state, expected)
            rows.append(dict(sample=sample, mode=mode, wallMs=wall, cpuMs=cpu,
                             supervisorStarts=0 if mode == 'candidate' else len(batch)))
        finally:
            shutil.rmtree(directory)

def median(mode, key):
    return statistics.median(row[key] for row in rows if row['mode'] == mode)

result = {
    'metrics': [dict(id=key + '-ratio', label=label, direction='lower',
                     value=median('candidate', field) / median('baseline', field))
                for key, label, field in [('cpu', 'Fixture CPU candidate/baseline', 'cpuMs'),
                                          ('wall', 'Fixture elapsed candidate/baseline', 'wallMs')]],
    'floorsMet': all(next(row['cpuMs'] for row in rows if row['sample'] == sample and row['mode'] == 'candidate')
                     < next(row['cpuMs'] for row in rows if row['sample'] == sample and row['mode'] == 'baseline')
                     for sample in range(1, 6)),
    'rows': {f"{row['mode']}-{row['sample']}": row for row in rows},
}
result['rows']['method'] = {
    'baseCommit': subprocess.check_output(['git', 'rev-parse', '9b08577a'], text=True).strip(),
    'nodeVersion': subprocess.check_output([node, '--version'], text=True).strip(),
    'vitestVersion': json.loads((root / 'node_modules/vitest/package.json').read_text())['version'],
    'scope': 'Git initialization only; no Vitest startup, hook installation, assertions or cleanup timed',
    'repositoryStateSha256': hashlib.sha256(json.dumps(expected, sort_keys=True).encode()).hexdigest(),
    'repositoryStateMatchedEveryRun': True,
    'cpuMeasurement': 'resource.getrusage(RUSAGE_CHILDREN): child user + system CPU',
    'candidateSetupSha256': hashlib.sha256((root / 'cli/__tests__/_ship-branch-fixture.mts').read_bytes()).hexdigest(),
}
print(json.dumps(result, indent=2))
