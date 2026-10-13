// The program file people see at the top of the folder. Electron must sit among its own DLLs,
// so the real program lives in app\; this launcher starts it from here, passing arguments on,
// with the kit folder as the working directory so settings next to this file are found.
//
// It also finishes an update the program could not: the program downloads its new copy next to
// the old one (app.new or app\resources\app.asar.new) and leaves the swap to a helper started as
// it quits. Should that helper not have run (older versions lost it), the downloaded copy is
// still there, so it is put in place here, before the program starts.
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

static class Launcher
{
    const string AppFolder = "app";
    const string Program = "FoxQuery Studio.exe";
    /// <summary>Suffixes the program's updater gives the downloaded copy, the replaced one and its swap script.</summary>
    const string NewSuffix = ".new", OldSuffix = ".old", ScriptSuffix = ".update.ps1";

    [STAThread]
    static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string folder = Path.Combine(root, AppFolder);
        string program = Path.Combine(folder, Program);
        FinishPendingUpdate(folder);
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

    /// <summary>Puts a downloaded program folder or app.asar in place of the current one, when one is waiting.</summary>
    static void FinishPendingUpdate(string folder)
    {
        string asar = Path.Combine(folder, "resources", "app.asar");
        try
        {
            if (Directory.Exists(folder + NewSuffix) && File.Exists(Path.Combine(folder + NewSuffix, Program)))
                Swap(folder, Directory.Exists, Directory.Move, path => Directory.Delete(path, true));
            else if (File.Exists(asar + NewSuffix))
                Swap(asar, File.Exists, File.Move, File.Delete);
        }
        catch (Exception)
        {
            // The program is still running, or the files are in use: it starts as it is and may update again.
        }
    }

    static void Swap(string target, Func<string, bool> exists, Action<string, string> move, Action<string> delete)
    {
        string fresh = target + NewSuffix, old = target + OldSuffix, script = target + ScriptSuffix;
        if (exists(old)) delete(old);
        if (exists(target)) move(target, old);
        move(fresh, target);
        try { delete(old); } catch (Exception) { }
        if (File.Exists(script)) File.Delete(script);
    }
}
