"""Private NDJSON transport. The launcher owns this process group (Linux)."""
import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios


def emit(kind, **fields):
    print(json.dumps({"kind": kind, **fields}, separators=(",", ":")), flush=True)


def resize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def child_signals():
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.signal(signal.SIGHUP, signal.SIG_DFL)


def main():
    stopping = False

    def request_stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    master, slave = pty.openpty()
    try:
        # The Node launcher created this session. Keep both processes in its group.
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        resize(slave, 80, 24)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave,
                                 preexec_fn=child_signals)
    finally:
        os.close(slave)
    signal.signal(signal.SIGTERM, request_stop)
    emit("ready", argv=sys.argv[1:])
    pending = b""
    try:
        while not stopping:
            readable, _, _ = select.select([master, 0], [], [], 0.05)
            if master in readable:
                try:
                    data = os.read(master, 4096)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b""
                if not data:
                    break
                emit("data", data=base64.b64encode(data).decode("ascii"))
            if 0 in readable:
                chunk = os.read(0, 4096)
                if not chunk:
                    break
                pending += chunk
                if len(pending) > 16000:
                    raise ValueError("oversize request")
                lines = pending.split(b"\n")
                pending = lines.pop()
                for line in lines:
                    m = json.loads(line)
                    if m["type"] == "write":
                        data = m["text"].encode("utf-8")
                        while data:
                            data = data[os.write(master, data):]
                    elif m["type"] == "resize":
                        resize(master, m["cols"], m["rows"])
                    elif m["type"] == "stop":
                        stopping = True
                    else:
                        raise ValueError("unsupported command")
                if stopping:
                    break
            if child.poll() is not None and master not in readable:
                break
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                child.kill()
        code = child.wait()
        os.close(master)
    emit("exit", code=code)


if __name__ == "__main__":
    main()
