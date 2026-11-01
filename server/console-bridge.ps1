# Console bridge worker: reads, types into and sends keys to the console of a Claude Code session
# that runs outside the editor (Git Bash, Windows Terminal, VS Code, PowerShell...). The hub keeps
# one of these running and sends it one request per line on stdin:
#   <id> TAB <op> TAB <pid> TAB <base64 utf-8 argument>
# and it answers one line per request on stdout: <id> TAB <json>.
#   prompt  types a prompt (lines joined with "\" + Enter, as a person would) and presses Enter,
#           only when Claude Code's input box is on screen and empty
#   nudge   the same, for the hub's short wake-up prompt
#   probe   reports whether a prompt could be typed now, without typing
#   screen  returns the visible lines of the console
#   keys    sends keys: names separated by spaces (enter esc up down left right tab backspace
#           space) or single characters
# The file must stay ASCII: Windows PowerShell 5.1 reads scripts in the ANSI code page.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding = [Text.Encoding]::UTF8
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
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
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

  public static string Json(string s) {
    var sb = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"') sb.Append("\\\""); else if (c == '\\') sb.Append("\\\\");
      else if (c < 0x20) sb.Append("\\u" + ((int)c).ToString("x4"));
      else sb.Append(c);
    }
    return sb.Append('"').ToString();
  }
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

  static INPUT_RECORD Key(char c, ushort vk, bool down, uint mods) {
    var r = new INPUT_RECORD();
    r.EventType = 1; r.KeyDown = down ? 1 : 0; r.RepeatCount = 1; r.UnicodeChar = c; r.ControlKeyState = mods;
    if (vk == 0) {
      short vks = VkKeyScanW(c);
      if (vks != -1) { vk = (ushort)(vks & 0xFF); if ((vks & 0x100) != 0) r.ControlKeyState |= 0x0010; }
    }
    r.VirtualKeyCode = vk;
    if (vk != 0) r.VirtualScanCode = (ushort)MapVirtualKeyW(vk, 0);
    return r;
  }
  static void Press(List<INPUT_RECORD> recs, char c, ushort vk, uint mods) { recs.Add(Key(c, vk, true, mods)); recs.Add(Key(c, vk, false, mods)); }

  static bool Write(IntPtr h, List<INPUT_RECORD> recs) {
    uint w;
    return recs.Count == 0 || WriteConsoleInputW(h, recs.ToArray(), (uint)recs.Count, out w);
  }

  // A newline is typed as "\" + Enter: Claude Code's line continuation, which works in every
  // terminal. Each line, the "\" and the Enter go as separate writes a moment apart: in a single
  // burst Claude Code takes the whole thing for a paste and keeps the "\" as text.
  static bool TypeText(IntPtr h, string s) {
    string[] lines = s.Replace("\r", "").Split('\n');
    for (int k = 0; k < lines.Length; k++) {
      var recs = new List<INPUT_RECORD>();
      foreach (char c in lines[k]) Press(recs, c, 0, 0);
      if (!Write(h, recs)) return false;
      if (k == lines.Length - 1) break;
      Thread.Sleep(70);
      var slash = new List<INPUT_RECORD>(); Press(slash, '\\', 0, 0);
      if (!Write(h, slash)) return false;
      Thread.Sleep(70);
      var enter = new List<INPUT_RECORD>(); Press(enter, '\r', 0x0D, 0);
      if (!Write(h, enter)) return false;
      Thread.Sleep(70);
    }
    return true;
  }

  static bool SendKeys(IntPtr h, string spec) {
    var recs = new List<INPUT_RECORD>();
    foreach (string k in spec.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) {
      switch (k.ToLowerInvariant()) {
        case "enter": Press(recs, '\r', 0x0D, 0); break;
        case "esc": Press(recs, (char)0x1B, 0x1B, 0); break;
        case "tab": Press(recs, '\t', 0x09, 0); break;
        case "shift-tab": Press(recs, '\t', 0x09, 0x0010); break;
        case "backspace": Press(recs, (char)0x08, 0x08, 0); break;
        case "space": Press(recs, ' ', 0x20, 0); break;
        case "up": Press(recs, (char)0, 0x26, 0x0100); break;
        case "down": Press(recs, (char)0, 0x28, 0x0100); break;
        case "left": Press(recs, (char)0, 0x25, 0x0100); break;
        case "right": Press(recs, (char)0, 0x27, 0x0100); break;
        default: if (k.Length == 1) Press(recs, k[0], 0, 0); else return false; break;
      }
    }
    return Write(h, recs);
  }

  public static string Run(string op, uint pid, string arg) {
    FreeConsole();
    if (!AttachConsole(pid)) return Result(false, "attach-" + Marshal.GetLastWin32Error());
    // Attached to someone else's console we would receive its Ctrl+C too: ignore it.
    SetConsoleCtrlHandler(IntPtr.Zero, true);
    IntPtr hout = IntPtr.Zero, hin = IntPtr.Zero;
    try {
      hout = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      hin = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (hout == new IntPtr(-1) || hin == new IntPtr(-1)) return Result(false, "handles");
      if (op == "screen") {
        var lines = Screen(hout);
        var sb = new StringBuilder("{\"ok\":true,\"lines\":[");
        for (int i = 0; i < lines.Count; i++) { if (i > 0) sb.Append(','); sb.Append(Json(lines[i])); }
        string p = Prompt(lines, true);
        sb.Append("],\"prompt\":").Append(p == null ? "\"none\"" : (p.Length == 0 || p.StartsWith("Try \"")) ? "\"empty\"" : "\"draft\"");
        return sb.Append('}').ToString();
      }
      if (op == "keys") return SendKeys(hin, arg) ? Result(true, "sent") : Result(false, "bad-key");
      string before = Prompt(Screen(hout), true);
      if (before == null) return Result(false, "no-prompt");
      if (before.Length > 0 && !before.StartsWith("Try \"")) return Result(false, "draft");
      if (op == "probe") return Result(true, "ready");
      if (!TypeText(hin, arg)) return Result(false, "write");
      // Enter only once the box shows what was typed (its first line, as wrapped on screen).
      string first = arg.Split('\n')[0].Trim();
      string head = first.Substring(0, Math.Min(24, first.Length));
      for (int i = 0; i < 30; i++) {
        Thread.Sleep(100);
        string now = Prompt(Screen(hout), false);
        // A very long line may show as Claude Code's "[Pasted text #1]" placeholder instead.
        if (now != null && (now.StartsWith(head) || now.StartsWith("[Pasted text"))) {
          Thread.Sleep(150);
          var enter = new List<INPUT_RECORD>();
          Press(enter, '\r', 0x0D, 0);
          return Write(hin, enter) ? Result(true, "sent") : Result(false, "write");
        }
      }
      return Result(false, "not-echoed");
    } catch (Exception e) {
      return "{\"ok\":false,\"reason\":\"error\",\"detail\":" + Json(e.Message) + "}";
    } finally {
      if (hout != IntPtr.Zero && hout != new IntPtr(-1)) CloseHandle(hout);
      if (hin != IntPtr.Zero && hin != new IntPtr(-1)) CloseHandle(hin);
      FreeConsole();
      SetConsoleCtrlHandler(IntPtr.Zero, false);
    }
  }
}
'@
$stdin = [Console]::In
$stdout = [Console]::Out
$stdout.WriteLine("ready`t{}")
$stdout.Flush()
while ($true) {
  $line = $stdin.ReadLine()
  if ($line -eq $null) { break }
  $parts = $line.Split("`t")
  if ($parts.Length -lt 4) { continue }
  try {
    $arg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[3]))
    $out = [BridgeConsole]::Run($parts[1], [uint32]$parts[2], $arg)
  } catch {
    $out = '{"ok":false,"reason":"error","detail":' + [BridgeConsole]::Json($_.Exception.Message) + '}'
  }
  $stdout.WriteLine($parts[0] + "`t" + $out)
  $stdout.Flush()
}
