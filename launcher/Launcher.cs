// The program file people see at the top of the folder. Electron must sit among its own DLLs,
// so the real program lives in app\; this launcher starts it from here, passing arguments on,
// with the kit folder as the working directory so settings next to this file are found.
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

static class Launcher
{
    const string AppFolder = "app";
    const string Program = "FoxQuery Studio.exe";

    [STAThread]
    static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string program = Path.Combine(root, AppFolder, Program);
        if (!File.Exists(program))
        {
            MessageBox.Show("Chưa có chương trình trong thư mục " + AppFolder + "\\." + Environment.NewLine + "Hãy chạy start.cmd để tải bản mới nhất về.", "FoxQuery Studio", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 1;
        }
        var quoted = new string[args.Length];
        for (int i = 0; i < args.Length; i++) quoted[i] = "\"" + args[i].Replace("\"", "\\\"") + "\"";
        Process.Start(new ProcessStartInfo(program, string.Join(" ", quoted)) { WorkingDirectory = root, UseShellExecute = false });
        return 0;
    }
}
