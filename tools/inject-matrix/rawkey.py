"""Raw-mode key receiver: logs the exact code points a route delivers.

Usage: python rawkey.py <name> <results-dir> [max-minutes]

A cooked-mode ReadLine hides what a route actually sent: it reports a line, not the key
that ended it. This reads one character at a time with msvcrt.getwch, the way an Ink TUI
(Claude Code, Codex) reads its input, and logs every code point with a UTC timestamp.

Each line of <name>.keys.log is: <iso timestamp> TAB U+XXXX TAB <printable name>
so a carriage return (U+000D) and a line feed (U+000A) are told apart.

Exits when it sees "QUIT" among the typed characters, when <name>.quit appears, or after
max-minutes. Writes <name>.pid last, so its presence means the loop is reading.
"""
import datetime
import os
import sys
import threading
import time

import msvcrt


def name_of(ch: str) -> str:
    code = ord(ch)
    special = {0x0D: "CR (Enter)", 0x0A: "LF", 0x09: "TAB", 0x1B: "ESC", 0x08: "BACKSPACE",
               0x03: "CTRL-C", 0x00: "NUL (extended key prefix)", 0xE0: "extended key prefix"}
    if code in special:
        return special[code]
    return repr(ch) if ch.isprintable() else f"control {code:#04x}"


def main() -> int:
    name = sys.argv[1]
    results = sys.argv[2]
    max_minutes = float(sys.argv[3]) if len(sys.argv) > 3 else 15.0

    log = os.path.join(results, f"{name}.keys.log")
    quit_file = os.path.join(results, f"{name}.quit")
    deadline = time.time() + max_minutes * 60

    # getwch blocks, so the quit file and the deadline are watched on their own thread.
    def watch() -> None:
        while True:
            if os.path.exists(quit_file) or time.time() > deadline:
                os._exit(0)
            time.sleep(0.5)

    threading.Thread(target=watch, daemon=True).start()

    print(f"inject-matrix rawkey receiver '{name}' pid {os.getpid()}. Logging code points; QUIT exits.", flush=True)
    with open(os.path.join(results, f"{name}.pid"), "w", encoding="ascii") as f:
        f.write(str(os.getpid()))

    recent = ""
    while True:
        ch = msvcrt.getwch()
        stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
        with open(log, "a", encoding="utf-8") as f:
            f.write(f"{stamp}\tU+{ord(ch):04X}\t{name_of(ch)}\n")
        # Echo so the host's screen shows what arrived, as an agent TUI would.
        print(f"[{ord(ch):#06x} {name_of(ch)}]", end="", flush=True)
        if ord(ch) in (0x0D, 0x0A):
            print(flush=True)
        recent = (recent + ch)[-8:]
        if "QUIT" in recent:
            return 0


if __name__ == "__main__":
    sys.exit(main())
