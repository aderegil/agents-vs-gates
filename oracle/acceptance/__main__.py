"""python -m oracle.acceptance <service_dir> --ticket X-rename [--out f]   (CANARY-1c424176afe20444)"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from oracle.acceptance import TICKETS, check_ticket


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m oracle.acceptance")
    ap.add_argument("service_dir")
    ap.add_argument("--ticket", required=True, choices=TICKETS + ("all",))
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    tickets = TICKETS if a.ticket == "all" else (a.ticket,)
    res = {t: check_ticket(Path(a.service_dir), t) for t in tickets}
    out = res[a.ticket] if a.ticket != "all" else res
    text = json.dumps(out, indent=2, ensure_ascii=False)
    if a.out:
        Path(a.out).write_text(text + "\n", encoding="utf-8", newline="\n")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
