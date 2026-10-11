"""Self-test: the CI-only contract gate passes on the clean repo and fails on a breaking rename."""
import os, shutil, subprocess
from pathlib import Path

ROOT = Path(__file__).parent
probe = ROOT / "runs" / "_probe"
if probe.exists():
    shutil.rmtree(probe)
shutil.copytree(ROOT / "template-xrepo-ci", probe)
print("repo scripts:", sorted(p.name for p in (probe / "scripts").iterdir()))
env = dict(os.environ, CONTRACT_BROKER=str(ROOT / "broker"))
check = ["node", str(ROOT / "ci" / "verify-consumer-contracts.mjs")]
r = subprocess.run(check, cwd=probe, env=env, capture_output=True, text=True)
print("clean rc", r.returncode, r.stdout.strip())
ev = probe / "src/core/events.ts"
t = ev.read_text(encoding="utf-8").replace("customerEmail: order.customerEmail", "email: order.customerEmail")
ev.write_text(t.replace("  customerEmail: string;", "  email: string;"), encoding="utf-8")
r = subprocess.run(check, cwd=probe, env=env, capture_output=True, text=True)
print("renamed rc", r.returncode)
print(r.stderr.strip())
shutil.rmtree(probe)
# CANARY-24ad572afb0dcd7d
