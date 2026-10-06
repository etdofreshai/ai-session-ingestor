#!/usr/bin/env python3
"""SSH forced command: get auth from this host's Codex, never copy refresh tokens."""
import json
import os
import selectors
import shutil
import subprocess
import time
import base64


def main():
    candidates = [
        shutil.which("codex"),
        os.path.expanduser("~/.local/bin/codex"),
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
        "/opt/homebrew/bin/codex",
    ]
    executable = next((p for p in candidates if p and os.access(p, os.X_OK)), None)
    if not executable:
        raise RuntimeError("Codex unavailable")
    process = subprocess.Popen(
        [executable, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, cwd=os.path.expanduser("~"),
    )
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    buffer = b""
    request_id = 0

    def rpc(method, params):
        nonlocal buffer, request_id
        request_id += 1
        process.stdin.write((json.dumps({"id": request_id, "method": method, "params": params}) + "\n").encode())
        process.stdin.flush()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                response = json.loads(line)
                if response.get("id") == request_id:
                    if "error" in response:
                        raise RuntimeError("Codex auth request failed")
                    return response["result"]
            if selector.select(timeout=1):
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    raise RuntimeError("Codex closed")
                buffer += chunk
                if len(buffer) > 1048576:
                    raise RuntimeError("Codex response too large")
        raise RuntimeError("Codex auth timeout")

    try:
        rpc("initialize", {"clientInfo": {"name": "codex-cloud-ingestor", "version": "1"}})
        process.stdin.write(b'{"method":"initialized"}\n')
        process.stdin.flush()
        auth = rpc("getAuthStatus", {"includeToken": True, "refreshToken": False})
        token = auth.get("authToken")
        if auth.get("authMethod") != "chatgpt" or not token:
            raise RuntimeError("Host needs ChatGPT login")
        claims = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "==="))
        if claims["exp"] < time.time() + 300:
            auth = rpc("getAuthStatus", {"includeToken": True, "refreshToken": True})
            token = auth.get("authToken")
            if not token:
                raise RuntimeError("Host needs ChatGPT login")
        print(json.dumps({"accessToken": token}), flush=True)
    finally:
        selector.close()
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never include provider response bodies or credentials in diagnostics.
        print("Codex auth unavailable", file=__import__("sys").stderr)
        raise SystemExit(1)
