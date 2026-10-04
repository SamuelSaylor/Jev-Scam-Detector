import os
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from typing import final, override

ROOT = Path(__file__).resolve().parents[1]


@final
class DemoLauncherTest(unittest.TestCase):
    def __init__(self, methodName: str = "runTest") -> None:
        super().__init__(methodName)
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.env: dict[str, str] = {}

    @override
    def setUp(self) -> None:
        self.addCleanup(self.temp.cleanup)
        self._stub(
            "docker",
            """#!/bin/sh
case "$*" in
  'compose version'|'info') exit 0 ;;
  'compose config --format json')
    echo '{"services":{"frontend":{"ports":[{"target":8080,"protocol":"tcp","host_ip":"127.0.0.1","published":"6123"}]}}}' ;;
  'compose up --build -d --wait --wait-timeout 120')
    printf '%s\\n' "$FRONTEND_ORIGIN" > "$DEMO_TEST_DIR/origin"
    test "$DEMO_TEST_FAIL_COMPOSE" != 1 ;;
  *) exit 2 ;;
esac
""",
        )
        self._stub(
            "ngrok",
            """#!/usr/bin/env python3
import os, signal, sys, time
from pathlib import Path
root = Path(os.environ['DEMO_TEST_DIR'])
if sys.argv[1:3] == ['config', 'check']:
    print('Valid configuration file at /tmp/fake-ngrok.yml')
    sys.exit(0)
if os.environ.get('DEMO_TEST_FAIL_NGROK') == '1':
    sys.exit(1)
def stop(*_):
    (root / 'stopped').write_text('yes')
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
(root / 'started').write_text('yes')
while True:
    time.sleep(0.1)
""",
        )
        self._stub(
            "curl",
            """#!/bin/sh
case "$*" in
  *'/api/tunnels')
    echo '{"tunnels":[{"proto":"https","public_url":"https://other.ngrok-free.dev","config":{"addr":"http://127.0.0.1:5173"}},{"proto":"https","public_url":"https://demo.ngrok-free.dev","config":{"addr":"http://127.0.0.1:6123"}}]}' ;;
  *'/api/health')
    test -f "$DEMO_TEST_DIR/origin" || exit 1
    test "$DEMO_TEST_FAIL_HEALTH" != 1 || exit 1
    echo '{"status":"ok"}' ;;
  *) exit 2 ;;
esac
""",
        )
        self.env = {
            **os.environ,
            "PATH": f"{self.directory}:{os.environ['PATH']}",
            "DEMO_TEST_DIR": str(self.directory),
            "DEMO_TEST_FAIL_NGROK": "0",
            "DEMO_TEST_FAIL_COMPOSE": "0",
            "DEMO_TEST_FAIL_HEALTH": "0",
        }

    def _stub(self, name: str, body: str) -> None:
        file = self.directory / name
        _ = file.write_text(body)
        file.chmod(0o755)

    def launch(self, **overrides: str) -> subprocess.Popen[str]:
        return subprocess.Popen(
            ["bash", "scripts/demo.sh"],
            cwd=ROOT,
            env={**self.env, **overrides},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def wait_for(self, path: str) -> None:
        for _ in range(100):
            if (self.directory / path).exists():
                return
            time.sleep(0.05)
        self.fail(f"Timed out waiting for {path}")

    def test_public_url_after_compose_and_owned_tunnel_stops_on_interrupt(self) -> None:
        process = self.launch()
        try:
            self.wait_for("origin")
            self.assertEqual(
                (self.directory / "origin").read_text(),
                "https://demo.ngrok-free.dev\n",
            )
            assert process.stdout is not None
            self.assertEqual(
                process.stdout.readline(), "Public demo: https://demo.ngrok-free.dev\n"
            )
            self.assertIsNone(process.poll())
            process.send_signal(signal.SIGINT)
            _ = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 130)
            self.wait_for("stopped")
        finally:
            if process.poll() is None:
                process.kill()
                _ = process.communicate()

    def test_compose_failure_stops_only_owned_tunnel_without_publishing_url(
        self,
    ) -> None:
        process = self.launch(DEMO_TEST_FAIL_COMPOSE="1")
        stdout, stderr = process.communicate(timeout=10)
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(stdout, "")
        self.assertIn("Docker Compose could not make the demo healthy", stderr)
        self.assertEqual((self.directory / "stopped").read_text(), "yes")

    def test_ngrok_startup_failure_does_not_start_compose(self) -> None:
        process = self.launch(DEMO_TEST_FAIL_NGROK="1")
        stdout, stderr = process.communicate(timeout=10)
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(stdout, "")
        self.assertIn("ngrok exited before opening a tunnel", stderr)
        self.assertFalse((self.directory / "origin").exists())


if __name__ == "__main__":
    _ = unittest.main()
