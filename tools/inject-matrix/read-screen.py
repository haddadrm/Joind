"""Read another process's console screen buffer.

Usage: python read-screen.py <pid> [lines]

Attaches to the console that owns <pid> (the same console the injector types into),
opens CONOUT$ and reads the visible window with ReadConsoleOutputCharacterW. Works for
a classic conhost and for a ConPTY pseudo-console alike, so one reader covers every host
including those with no screen-reading CLI of their own (conhost, Windows Terminal, Warp).

Prints the non-empty trailing lines, one per line. Exits 1 with the Win32 error on stderr
when the console cannot be attached or read.
"""
import ctypes
import sys
from ctypes import wintypes

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)


class COORD(ctypes.Structure):
    _fields_ = [("X", wintypes.SHORT), ("Y", wintypes.SHORT)]


class SMALL_RECT(ctypes.Structure):
    _fields_ = [("Left", wintypes.SHORT), ("Top", wintypes.SHORT),
                ("Right", wintypes.SHORT), ("Bottom", wintypes.SHORT)]


class CONSOLE_SCREEN_BUFFER_INFO(ctypes.Structure):
    _fields_ = [("dwSize", COORD), ("dwCursorPosition", COORD), ("wAttributes", wintypes.WORD),
                ("srWindow", SMALL_RECT), ("dwMaximumWindowSize", COORD)]


def main() -> int:
    pid = int(sys.argv[1])
    want = int(sys.argv[2]) if len(sys.argv) > 2 else 40

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
    handle = kernel32.CreateFileW("CONOUT$", GENERIC_READ | GENERIC_WRITE,
                                  FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING, 0, None)
    if handle == wintypes.HANDLE(-1).value:
        print(f"CreateFileW(CONOUT$) failed: error {ctypes.get_last_error()}", file=sys.stderr)
        return 1

    info = CONSOLE_SCREEN_BUFFER_INFO()
    if not kernel32.GetConsoleScreenBufferInfo(handle, ctypes.byref(info)):
        print(f"GetConsoleScreenBufferInfo failed: error {ctypes.get_last_error()}", file=sys.stderr)
        return 1

    width = info.srWindow.Right - info.srWindow.Left + 1
    top = info.srWindow.Top
    bottom = info.srWindow.Bottom
    rows = []
    buf = ctypes.create_unicode_buffer(width + 1)
    read = wintypes.DWORD(0)
    for y in range(top, bottom + 1):
        if not kernel32.ReadConsoleOutputCharacterW(handle, buf, width,
                                                    COORD(info.srWindow.Left, y), ctypes.byref(read)):
            print(f"ReadConsoleOutputCharacterW row {y} failed: error {ctypes.get_last_error()}", file=sys.stderr)
            return 1
        rows.append(buf[:read.value].rstrip())

    kernel32.FreeConsole()
    # Trailing non-empty lines: the tail is what a wake-up check cares about.
    while rows and not rows[-1]:
        rows.pop()
    out = rows[-want:]
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
