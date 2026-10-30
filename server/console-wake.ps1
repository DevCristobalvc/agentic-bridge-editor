param([int]$TargetPid, [string]$TextB64, [switch]$DryRun)
# Types a short prompt into the console of an idle Claude Code session that runs outside the
# editor (Windows Terminal, Git Bash, VS Code, PowerShell...). It attaches to that console, reads
# the screen, and only types when Claude Code's input box is visible, single-line and empty; it
# presses Enter only if the box then holds exactly the typed text. Prints one JSON line.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class BridgeConsole {
  const char RULE = (char)0x2500, GLYPH = (char)0x276F, NBSP = (char)0x00A0;
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] struct SMALL_RECT { public short Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct CSBI { public COORD Size; public COORD Cursor; public ushort Attr; public SMALL_RECT Window; public COORD Max; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI info);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool ReadConsoleOutputCharacterW(IntPtr h, StringBuilder buf, uint len, COORD at, out uint read);
  [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode)] struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public int KeyDown;
    [FieldOffset(8)] public ushort RepeatCount;
    [FieldOffset(10)] public ushort VirtualKeyCode;
    [FieldOffset(12)] public ushort VirtualScanCode;
    [FieldOffset(14)] public char UnicodeChar;
    [FieldOffset(16)] public uint ControlKeyState;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] recs, uint n, out uint written);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern short VkKeyScanW(char c);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint type);

  static string Result(bool ok, string reason) { return "{\"ok\":" + (ok ? "true" : "false") + ",\"reason\":\"" + reason + "\"}"; }

  static List<string> Screen(IntPtr h) {
    var lines = new List<string>();
    CSBI i;
    if (!GetConsoleScreenBufferInfo(h, out i)) return lines;
    int w = i.Size.X;
    for (int y = i.Window.Top; y <= i.Window.Bottom; y++) {
      var sb = new StringBuilder(w); uint n; var at = new COORD(); at.Y = (short)y;
      ReadConsoleOutputCharacterW(h, sb, (uint)w, at, out n);
      lines.Add(sb.ToString(0, (int)Math.Min(n, (uint)sb.Length)).TrimEnd());
    }
    return lines;
  }

  static bool IsRule(string l) {
    if (l.Length == 0 || l[0] != RULE) return false;
    int n = 0; foreach (char c in l) if (c == RULE) n++;
    return n >= 20;
  }

  // Text of Claude Code's input line (the one that starts with the prompt glyph right under a
  // rule), or null when the input box is not on screen. "single" also requires a rule right
  // below it, so a multi-line draft or a dialog never counts as an empty prompt.
  static string Prompt(List<string> lines, bool single) {
    for (int i = lines.Count - 2; i >= 1; i--) {
      string l = lines[i];
      if (l.Length == 0 || l[0] != GLYPH) continue;
      if (!IsRule(lines[i - 1])) return null;
      if (single && !IsRule(lines[i + 1])) return null;
      return l.Substring(1).Trim(' ', NBSP, '\t');
    }
    return null;
  }

  static INPUT_RECORD Key(char c, bool down) {
    var r = new INPUT_RECORD();
    r.EventType = 1; r.KeyDown = down ? 1 : 0; r.RepeatCount = 1; r.UnicodeChar = c;
    short vks = c == '\r' ? (short)0x0D : VkKeyScanW(c);
    if (vks != -1) {
      r.VirtualKeyCode = (ushort)(vks & 0xFF);
      r.VirtualScanCode = (ushort)MapVirtualKeyW((uint)(vks & 0xFF), 0);
      if ((vks & 0x100) != 0) r.ControlKeyState |= 0x0010;
    }
    return r;
  }

  static bool Type(IntPtr h, string s) {
    var recs = new List<INPUT_RECORD>();
    foreach (char c in s) { recs.Add(Key(c, true)); recs.Add(Key(c, false)); }
    uint w;
    return WriteConsoleInputW(h, recs.ToArray(), (uint)recs.Count, out w);
  }

  public static string Wake(uint pid, string text, bool dry) {
    FreeConsole();
    if (!AttachConsole(pid)) return Result(false, "attach-" + Marshal.GetLastWin32Error());
    IntPtr hout = IntPtr.Zero, hin = IntPtr.Zero;
    try {
      hout = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      hin = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (hout == new IntPtr(-1) || hin == new IntPtr(-1)) return Result(false, "handles");
      string before = Prompt(Screen(hout), true);
      if (before == null) return Result(false, "no-prompt");
      if (before.Length > 0 && !before.StartsWith("Try \"")) return Result(false, "draft");
      if (dry) return Result(true, "dry-run");
      if (!Type(hin, text)) return Result(false, "write");
      string head = text.Substring(0, Math.Min(24, text.Length));
      for (int i = 0; i < 20; i++) {
        Thread.Sleep(100);
        string now = Prompt(Screen(hout), false);
        if (now != null && now.StartsWith(head)) {
          Thread.Sleep(150);
          return Type(hin, "\r") ? Result(true, "sent") : Result(false, "write");
        }
      }
      return Result(false, "not-echoed");
    } finally {
      if (hout != IntPtr.Zero) CloseHandle(hout);
      if (hin != IntPtr.Zero) CloseHandle(hin);
      FreeConsole();
    }
  }
}
'@
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TextB64))
[BridgeConsole]::Wake([uint32]$TargetPid, $text, [bool]$DryRun)
