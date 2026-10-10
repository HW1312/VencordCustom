// "VoidCord-Installer.exe": one standalone file. Installer.ps1, logo, icon, version and the Vencord build are
// embedded as resources ("files/<path>"). The script runs inside this process (hosted PowerShell), so there is
// no powershell.exe, no console window and nothing is unpacked to disk - the script reads its files through Host.
// Compiled by build.mjs --package with Windows' own .NET Framework csc.exe.
using System;
using System.IO;
using System.Management.Automation;
using System.Management.Automation.Runspaces;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("VoidCord Installer")]
[assembly: AssemblyProduct("VoidCord")]
[assembly: AssemblyDescription("Installs VoidCord into Discord")]

namespace VoidCordHost
{
    /// <summary>Called from Installer.ps1</summary>
    public static class Host
    {
        static readonly Assembly Self = Assembly.GetExecutingAssembly();

        public static bool Has(string name)
        {
            return Self.GetManifestResourceInfo("files/" + name) != null;
        }

        /// <summary>Embedded file as bytes, null if missing</summary>
        public static byte[] Read(string name)
        {
            using (var s = Self.GetManifestResourceStream("files/" + name))
            {
                if (s == null) return null;
                var ms = new MemoryStream();
                s.CopyTo(ms);
                return ms.ToArray();
            }
        }

        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
        [DllImport("dwmapi.dll")] static extern int DwmExtendFrameIntoClientArea(IntPtr h, ref Margins m);
        struct Margins { public int L, R, T, B; }

        /// <summary>Windows 11 acrylic glass behind the whole window</summary>
        public static bool Glass(IntPtr h)
        {
            int on = 1, round = 2, acrylic = 3;
            DwmSetWindowAttribute(h, 20, ref on, 4);      // dark mode frame
            DwmSetWindowAttribute(h, 33, ref round, 4);   // rounded corners
            var m = new Margins { L = -1, R = -1, T = -1, B = -1 };
            DwmExtendFrameIntoClientArea(h, ref m);
            return DwmSetWindowAttribute(h, 38, ref acrylic, 4) == 0;
        }
    }

    static class Launcher
    {
        const string Title = "VoidCord Installer";

        [STAThread]
        static int Main(string[] args)
        {
            string exe = Assembly.GetExecutingAssembly().Location;
            // Leftover from a self-update (the old exe was renamed while it was still running)
            try { File.Delete(exe + ".old"); } catch { }

            try
            {
                string script = Encoding.UTF8.GetString(Host.Read("Installer.ps1"));

                var state = InitialSessionState.CreateDefault();
                // Only for this in-process runspace, so the built-in modules (Get-FileHash ...) load
                state.ExecutionPolicy = Microsoft.PowerShell.ExecutionPolicy.Bypass;
                using (var rs = RunspaceFactory.CreateRunspace(state))
                {
                    // WPF needs the STA main thread
                    rs.ApartmentState = System.Threading.ApartmentState.STA;
                    rs.ThreadOptions = PSThreadOptions.UseCurrentThread;
                    rs.Open();
                    using (var ps = PowerShell.Create())
                    {
                        ps.Runspace = rs;
                        ps.AddScript(script).AddParameter("ExePath", exe);
                        if (HasFlag(args, "/uninstall")) ps.AddParameter("Uninstall");
                        if (HasFlag(args, "/updated")) ps.AddParameter("Updated");
                        ps.Invoke();
                        if (ps.HadErrors && ps.Streams.Error.Count > 0)
                        {
                            var sb = new StringBuilder();
                            foreach (var e in ps.Streams.Error) sb.AppendLine(e.ToString());
                            MessageBox.Show("The installer stopped with an error:\n\n" + sb.ToString().Trim(), Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                            return 1;
                        }
                    }
                }
                return 0;
            }
            catch (Exception e)
            {
                MessageBox.Show("The installer stopped with an error:\n\n" + e.Message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        static bool HasFlag(string[] args, string flag)
        {
            return Array.Exists(args, a => a.Equals(flag, StringComparison.OrdinalIgnoreCase));
        }
    }
}
