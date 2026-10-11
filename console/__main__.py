"""python -m console [--port N] [--data-dir D] [--check]"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m console", description="Agents vs. Gates — Console (127.0.0.1 only)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--data-dir", type=Path, default=None, help="users, sessions, audit (default console/data)")
    ap.add_argument("--check", action="store_true", help="headless end-to-end check on temporary data (§24)")
    ap.add_argument("--keep", action="store_true", help="with --check: keep the temporary folders")
    a = ap.parse_args(argv)
    if a.check:
        from console.core.check import run_check
        return run_check(keep=a.keep)
    from console.core.server import main as serve
    return serve(a.port, a.data_dir)


if __name__ == "__main__":
    sys.exit(main())
