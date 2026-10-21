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
        var wwwDir = Path.Combine(AppContext.BaseDirectory, "www");
        var index = Path.Combine(wwwDir, "index.html");
        if (!File.Exists(index))
        {
            MessageBox.Show($"找不到网页资源：\n{index}\n请确认程序包完整。", "九路围棋", MessageBoxButtons.OK, MessageBoxIcon.Error);
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
}
