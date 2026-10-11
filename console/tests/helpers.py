"""Shared fixtures: a temp results root, temp data dir, temp plugins dir and an in-process console."""
import json
import os
import shutil
import tempfile
from pathlib import Path
from unittest import mock

from console.core.client import Client
from console.core.server import App, PLUGINS_DIR

PW = "test-Password-123"


def write_plugin(root: Path, pid: str, manifest: dict | None = None, api: str | None = None, order: int = 50) -> Path:
    d = root / pid
    (d / "web").mkdir(parents=True, exist_ok=True)
    m = {"id": pid, "name": pid.title(), "icon": "list", "order": order, "description": f"{pid} test plugin",
         "roles": ["owner", "operator"], "kind": "module", "entry": "web/index.js"}
    if api is not None:
        m["api"] = "api.py"
        (d / "api.py").write_text(api, encoding="utf-8")
    if manifest:
        m.update(manifest)
    (d / "plugin.json").write_text(json.dumps(m), encoding="utf-8")
    (d / "web" / "index.js").write_text("export function mount(el){}\nexport function unmount(){}\n", encoding="utf-8")
    return d


class ConsoleFixture:
    """with ConsoleFixture(plugins=...) as fx: fx.owner (logged-in Client), fx.app, fx.results"""

    def __init__(self, plugins_dir: Path | None = None, copy_real: tuple = (), setup_owner: bool = True):
        self.tmp = Path(tempfile.mkdtemp(prefix="avg-test-"))
        self.results = self.tmp / "results"
        self.results.mkdir()
        self.plugins_dir = plugins_dir or (self.tmp / "plugins")
        self.plugins_dir.mkdir(exist_ok=True)
        for pid in copy_real:
            shutil.copytree(PLUGINS_DIR / pid, self.plugins_dir / pid, ignore=shutil.ignore_patterns("__pycache__"))
        self.setup_owner = setup_owner

    def __enter__(self):
        self.env = mock.patch.dict(os.environ, {"AVG_RESULTS_ROOT": str(self.results)})
        self.env.start()
        self.app = App(self.tmp / "data", plugins_dir=self.plugins_dir, iterations=1000, watch_interval=0.2)
        self.port = self.app.start(0)
        self.owner = Client(self.port, timeout=30)
        if self.setup_owner:
            r = self.owner.setup("owner1", PW)
            assert r.status == 201, r.text
        return self

    def client(self, username: str | None = None, role: str = "viewer") -> Client:
        c = Client(self.port, timeout=30)
        if username:
            if not self.app.users.get(username):
                self.app.users.create(username, PW, role, by="test")
            r = c.login(username, PW)
            assert r.status == 200, r.text
        return c

    def __exit__(self, *exc):
        self.app.stop()
        self.env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)
