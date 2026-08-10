using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class TabHubForeground
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    private sealed class Candidate
    {
        public bool BoundsMatch;
        public IntPtr Handle;
        public uint ProcessId;
        public long Score;
        public long TitleScore;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern IntPtr SetActiveWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    private const int RestoreWindow = 9;

    public static int Main(string[] arguments)
    {
        if (arguments.Length != 6)
        {
            Console.WriteLine("INVALID_ARGUMENTS");
            return 2;
        }

        int left;
        int top;
        int width;
        int height;
        if (!Int32.TryParse(arguments[2], out left) ||
            !Int32.TryParse(arguments[3], out top) ||
            !Int32.TryParse(arguments[4], out width) ||
            !Int32.TryParse(arguments[5], out height))
        {
            Console.WriteLine("INVALID_BOUNDS");
            return 2;
        }

        var result = Focus(arguments[0], arguments[1], left, top, width, height);
        Console.WriteLine(result);
        return result.StartsWith("OK|", StringComparison.Ordinal) ? 0 : 2;
    }

    private static string Focus(
        string processNames,
        string expectedTitle,
        int expectedLeft,
        int expectedTop,
        int expectedWidth,
        int expectedHeight)
    {
        var allowedProcessIds = new HashSet<uint>();
        foreach (var processName in processNames.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries))
        {
            foreach (var process in Process.GetProcessesByName(processName))
            {
                allowedProcessIds.Add((uint)process.Id);
                process.Dispose();
            }
        }
        var hasTitle = !String.IsNullOrWhiteSpace(expectedTitle);
        var hasBounds = expectedWidth > 0 && expectedHeight > 0;
        var candidates = new List<Candidate>();

        EnumWindows(delegate(IntPtr hWnd, IntPtr ignored)
        {
            if (!IsWindowVisible(hWnd)) return true;
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            if (!allowedProcessIds.Contains(processId)) return true;

            var titleLength = GetWindowTextLength(hWnd);
            var titleBuilder = new StringBuilder(Math.Max(titleLength + 1, 2));
            GetWindowText(hWnd, titleBuilder, titleBuilder.Capacity);
            var windowTitle = titleBuilder.ToString();
            var titleScore = 0L;
            if (hasTitle)
            {
                if (windowTitle.Equals(expectedTitle, StringComparison.OrdinalIgnoreCase))
                    titleScore = 1200000L;
                else if (windowTitle.StartsWith(expectedTitle, StringComparison.OrdinalIgnoreCase))
                    titleScore = 1100000L;
                else if (windowTitle.IndexOf(expectedTitle, StringComparison.OrdinalIgnoreCase) >= 0)
                    titleScore = 1000000L;
            }
            var titleMatches = titleScore > 0;

            Rect rect;
            var hasRect = GetWindowRect(hWnd, out rect);
            var actualWidth = rect.Right - rect.Left;
            var actualHeight = rect.Bottom - rect.Top;
            var boundsDistance = hasRect && hasBounds
                ? Math.Abs((long)rect.Left - expectedLeft) +
                  Math.Abs((long)rect.Top - expectedTop) +
                  Math.Abs((long)actualWidth - expectedWidth) +
                  Math.Abs((long)actualHeight - expectedHeight)
                : Int64.MaxValue;
            var boundsMatch = boundsDistance <= 192;
            var matchesRequiredEvidence = hasTitle && hasBounds
                ? titleMatches && boundsMatch
                : hasTitle
                    ? titleMatches
                    : boundsMatch;
            if (!matchesRequiredEvidence) return true;

            candidates.Add(new Candidate
            {
                BoundsMatch = boundsMatch,
                Handle = hWnd,
                ProcessId = processId,
                Score = titleScore + (boundsMatch ? 500000L - boundsDistance : 0L),
                TitleScore = titleScore
            });
            return true;
        }, IntPtr.Zero);

        var ranked = candidates.OrderByDescending(candidate => candidate.Score).ToList();
        var target = ranked.FirstOrDefault();
        if (target == null) return "NO_MATCH";
        if (ranked.Count > 1)
        {
            var runnerUp = ranked[1];
            if (runnerUp.TitleScore == target.TitleScore &&
                runnerUp.BoundsMatch == target.BoundsMatch)
                return "AMBIGUOUS_MATCH";
        }
        if (IsIconic(target.Handle)) ShowWindowAsync(target.Handle, RestoreWindow);

        var foreground = GetForegroundWindow();
        if (foreground == target.Handle)
            return Success(target);

        uint ignoredProcessId;
        var foregroundThread = foreground == IntPtr.Zero
            ? 0
            : GetWindowThreadProcessId(foreground, out ignoredProcessId);
        var targetThread = GetWindowThreadProcessId(target.Handle, out ignoredProcessId);
        var currentThread = GetCurrentThreadId();
        var attachedForeground = foregroundThread != 0 && foregroundThread != currentThread &&
            AttachThreadInput(currentThread, foregroundThread, true);
        var attachedTarget = targetThread != 0 && targetThread != currentThread &&
            AttachThreadInput(currentThread, targetThread, true);

        try
        {
            BringWindowToTop(target.Handle);
            SetActiveWindow(target.Handle);
            SetFocus(target.Handle);
            SetForegroundWindow(target.Handle);
        }
        finally
        {
            if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
            if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
        }

        Thread.Sleep(75);
        return GetForegroundWindow() == target.Handle ? Success(target) : "FOCUS_FAILED";
    }

    private static string Success(Candidate target)
    {
        return "OK|" + target.ProcessId + "|" + target.Handle.ToInt64().ToString("X");
    }
}
