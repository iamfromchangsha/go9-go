using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Go9;

/// <summary>九路围棋 · AI 练习 —— Windows 桌面壳（内嵌 WebView2 加载本地网页资源）</summary>
internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}

internal sealed class MainForm : Form
{
    private const string HostName = "app.local";
    private readonly WebView2 _web = new();

    public MainForm()
    {
        Text = "九路围棋 · AI 练习";
        ClientSize = new Size(1320, 880);
        MinimumSize = new Size(920, 640);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(14, 17, 22);
        KeyPreview = true;

        _web.Dock = DockStyle.Fill;
        _web.DefaultBackgroundColor = Color.FromArgb(14, 17, 22);
        _web.CoreWebView2InitializationCompleted += (_, _) =>
        {
            // 屏蔽开发者工具与新窗口，右键菜单留空（避免干扰棋盘操作）
            _web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _web.CoreWebView2.NewWindowRequested += (_, e) => e.Handled = true;
        };

        var host = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(14, 17, 22) };
        host.Controls.Add(_web);
        Controls.Add(host);

        Shown += async (_, _) => await InitAsync();
    }

    private async Task InitAsync()
    {
        var wwwDir = ExtractWeb();
        if (wwwDir == null)
        {
            MessageBox.Show("程序包缺少网页资源，请重新下载。", "九路围棋", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(AppContext.BaseDirectory, "wv2"));
            await _web.EnsureCoreWebView2Async(env);
            // 用虚拟主机名映射本地目录：获得正常的安全上下文（剪贴板/localStorage 都能用）
            _web.CoreWebView2.SetVirtualHostNameToFolderMapping(
                HostName, wwwDir, CoreWebView2HostResourceAccessKind.DenyCors);
            _web.Source = new Uri($"https://{HostName}/index.html");
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "WebView2 运行时启动失败。\n请安装 Microsoft Edge WebView2 Runtime 后重试。\n\n" + ex.Message,
                "九路围棋", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    /// <summary>把内嵌的网页资源释放到临时目录，返回目录路径</summary>
    private static string? ExtractWeb()
    {
        var dir = Path.Combine(Path.GetTempPath(), "Go9", "www");
        try
        {
            Directory.CreateDirectory(Path.Combine(dir, "js"));
            var files = new (string Resource, string Target)[]
            {
                ("Go9.www.index.html",  Path.Combine(dir, "index.html")),
                ("Go9.www.styles.css", Path.Combine(dir, "styles.css")),
                ("Go9.www.js.engine.js", Path.Combine(dir, "js", "engine.js")),
                ("Go9.www.js.ai.js",     Path.Combine(dir, "js", "ai.js")),
                ("Go9.www.js.ui.js",     Path.Combine(dir, "js", "ui.js")),
                ("Go9.www.js.main.js",   Path.Combine(dir, "js", "main.js")),
            };
            foreach (var (resource, target) in files)
            {
                using var src = typeof(Program).Assembly.GetManifestResourceStream(resource);
                if (src == null) return null;
                using var fs = new FileStream(target, FileMode.Create, FileAccess.Write);
                src.CopyTo(fs);
            }
            return dir;
        }
        catch
        {
            return null;
        }
    }
}
