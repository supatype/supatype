#!/usr/bin/env python3
"""Parse every shell `run:` block in the workflows with `bash -n`.

Four bugs this session were shell text that had never been parsed: a replacement whose backslash
behaved differently on macOS, a `printf` DER prefix that arrived as raw control bytes, and a stray
backslash before a closing quote that made a whole step unparseable. YAML is happy to carry all of
them; only a shell will say so. Workflow steps are not otherwise executed until a release runs.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

SHELLS_WE_CHECK = {None, "bash", "sh"}


def steps(doc):
    for job_name, job in (doc.get("jobs") or {}).items():
        for i, step in enumerate(job.get("steps") or []):
            if isinstance(step, dict) and "run" in step:
                yield job_name, i, step


def main() -> int:
    workflows = sorted(Path(".github/workflows").glob("*.yml"))
    failures = 0
    checked = 0
    for wf in workflows:
        doc = yaml.safe_load(wf.read_text(encoding="utf-8"))
        if not isinstance(doc, dict):
            continue
        default_shell = ((doc.get("defaults") or {}).get("run") or {}).get("shell")
        for job_name, idx, step in steps(doc):
            shell = step.get("shell", default_shell)
            if shell not in SHELLS_WE_CHECK:
                continue
            script = step["run"]
            # GitHub substitutes ${{ ... }} before bash sees it. Replace with a placeholder so the
            # parse reflects the shell text rather than the expression syntax.
            script = script.replace("${{", "$__EXPR__{{")
            with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False, newline="\n") as fh:
                fh.write(script)
                path = fh.name
            checked += 1
            result = subprocess.run(["bash", "-n", path], capture_output=True, text=True)
            Path(path).unlink(missing_ok=True)
            if result.returncode != 0:
                failures += 1
                name = step.get("name", f"step {idx}")
                print(f"{wf}: {job_name}: {name}")
                for line in result.stderr.strip().split("\n"):
                    print(f"    {line.replace(path, '<step>')}")
    print(f"checked {checked} shell steps across {len(workflows)} workflows, {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
