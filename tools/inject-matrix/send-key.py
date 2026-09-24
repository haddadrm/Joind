"""Send virtual keys to another process's console. Harness setup only, not a route under test.

Usage: python send-key.py <pid> <key> [<key> ...]
Keys: down, up, enter, esc, tab, ctrl-c, or char:<c>

The injector types text and one Enter, which cannot answer a menu (Claude Code's one-time
folder-trust prompt) or end a session cleanly (Ctrl+C). This writes single key events
through the same console API the injector uses (AttachConsole plus WriteConsoleInputW on
CONIN$), so probe setup and teardown never depend on the route being measured.
"""
import ctypes
import sys
import time
from ctypes import wintypes

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

KEY_EVENT = 0x0001
LEFT_CTRL_PRESSED = 0x0008

KEYS = {
    "down": (0x28, "\x00", 0x50, 0),
    "up": (0x26, "\x00", 0x48, 0),
    "enter": (0x0D, "\r", 0x1C, 0),
    "esc": (0x1B, "\x1b", 0x01, 0),
    "tab": (0x09, "\t", 0x0F, 0),
    "ctrl-c": (0x43, "\x03", 0x2E, LEFT_CTRL_PRESSED),
}


class _CHAR_UNION(ctypes.Union):
    _fields_ = [("UnicodeChar", wintypes.WCHAR), ("AsciiChar", wintypes.CHAR)]


class _KEY_EVENT_RECORD(ctypes.Structure):
    _fields_ = [("bKeyDown", wintypes.BOOL), ("wRepeatCount", wintypes.WORD),
                ("wVirtualKeyCode", wintypes.WORD), ("wVirtualScanCode", wintypes.WORD),
                ("uChar", _CHAR_UNION), ("dwControlKeyState", wintypes.DWORD)]


class _EVENT_UNION(ctypes.Union):
    _fields_ = [("KeyEvent", _KEY_EVENT_RECORD)]


class _INPUT_RECORD(ctypes.Structure):
    _fields_ = [("EventType", wintypes.WORD), ("Event", _EVENT_UNION)]


def write_key(handle, vk: int, ch: str, scan: int, ctrl: int) -> None:
    for down in (True, False):
        rec = _INPUT_RECORD()
        rec.EventType = KEY_EVENT
        evt = rec.Event.KeyEvent
        evt.bKeyDown = down
        evt.wRepeatCount = 1
        evt.wVirtualKeyCode = vk
        evt.wVirtualScanCode = scan
        evt.uChar.UnicodeChar = ch
        evt.dwControlKeyState = ctrl
        written = wintypes.DWORD(0)
        kernel32.WriteConsoleInputW(handle, ctypes.byref(rec), 1, ctypes.byref(written))


def main() -> int:
    pid = int(sys.argv[1])
    keys = sys.argv[2:]

    kernel32.FreeConsole()
    if not kernel32.AttachConsole(pid):
        print(f"AttachConsole({pid}) failed: error {ctypes.get_last_error()}", file=sys.stderr)
        return 1

    GENERIC_READ = 0x80000000
    GENERIC_WRITE = 0x40000000
    FILE_SHARE_READ = 0x00000001
    FILE_SHARE_WRITE = 0x00000002
    OPEN_EXISTING = 3
    kernel32.CreateFileW.restype = wintypes.HANDLE
    handle = kernel32.CreateFileW("CONIN$", GENERIC_READ | GENERIC_WRITE,
                                  FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING, 0, None)

    for k in keys:
        if k.startswith("char:"):
            c = k[5:]
            write_key(handle, 0, c, 0, 0)
        else:
            vk, ch, scan, ctrl = KEYS[k.lower()]
            write_key(handle, vk, ch, scan, ctrl)
        time.sleep(0.12)

    kernel32.FreeConsole()
    print(f"sent {len(keys)} key(s) to pid {pid}: {' '.join(keys)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
