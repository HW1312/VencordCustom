# VoidCord installer: a small window to install, repair or uninstall VencordCustom (shown as VoidCord)
# in Discord Stable, PTB and Canary.
# Normally runs inside VoidCord-Installer.exe (share/Launcher.cs), which embeds this script and its files
# (read through [VoidCordHost.Host]). For testing it can also run directly from share/ with powershell -File.
# Keep this file ASCII only - Windows PowerShell 5.1 reads files without BOM as ANSI.
# -ExePath: the running exe (for self-update); -Updated: this run comes right after a self-update, so don't update again
param([string]$ExePath, [switch]$Uninstall, [switch]$Updated)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$Repo = "HW1312/VencordCustom"
$Target = Join-Path $env:APPDATA "VencordCustom"
$Here = $PSScriptRoot
$Embedded = [bool]("VoidCordHost.Host" -as [type])

# Bundled file (embedded in the exe, or next to this script), $null if missing
function Get-Asset($name) {
    if ($Embedded) { return [VoidCordHost.Host]::Read($name) }
    $path = Join-Path $Here $name
    if (Test-Path $path) { [IO.File]::ReadAllBytes($path) }
}
function Test-Asset($name) {
    if ($Embedded) { [VoidCordHost.Host]::Has($name) } else { Test-Path (Join-Path $Here $name) }
}

$Version = if (Test-Asset "version.txt") { [Text.Encoding]::UTF8.GetString((Get-Asset "version.txt")).Trim() }
$HasLocalDist = Test-Asset "dist/renderer.js"

$Branches = @(
    @{ Id = "stable"; Name = "Discord"; Dir = "Discord"; Exe = "Discord" }
    @{ Id = "ptb"; Name = "Discord PTB"; Dir = "DiscordPTB"; Exe = "DiscordPTB" }
    @{ Id = "canary"; Name = "Discord Canary"; Dir = "DiscordCanary"; Exe = "DiscordCanary" }
)

# ---------------------------------------------------------------------------
# Detection

function Get-AppDirs($root) {
    Get-ChildItem $root -Directory -Filter "app-*" -ErrorAction SilentlyContinue |
        Sort-Object { try { [version]$_.Name.Substring(4) } catch { [version]"0.0" } } -Descending
}

# custom = VencordCustom, other = another Vencord build, lost = removed by a Discord update, none = plain Discord
function Get-BranchState($b) {
    $root = Join-Path $env:LOCALAPPDATA $b.Dir
    $apps = @(Get-AppDirs $root)
    if (-not $apps) { return "none" }
    $res = Join-Path $apps[0].FullName "resources"
    if (-not (Test-Path "$res\_app.asar")) {
        $older = $apps | Select-Object -Skip 1 | Where-Object { Test-Path "$($_.FullName)\resources\_app.asar" }
        if ($older) { return "lost" } else { return "none" }
    }
    try { $asar = [IO.File]::ReadAllText("$res\app.asar") } catch { return "other" }
    if ($asar -match 'require\("(.+?)"\)' -and ($Matches[1] -replace '\\\\', '\') -like "*\VencordCustom\*") { return "custom" }
    "other"
}

function Get-InstalledBranches {
    foreach ($b in $Branches) {
        if (Test-Path (Join-Path $env:LOCALAPPDATA "$($b.Dir)\Update.exe")) { $b }
    }
}

# ---------------------------------------------------------------------------
# Background work (runs in its own runspace so the window stays responsive)

$Worker = {
    # $Release: newer release tag on GitHub -> install that instead of the (older) files in the zip
    param($Mode, $Selected, $Here, $Target, $Repo, $StartAfter, $Release, $sync)

    function Log($msg) { $sync.Queue.Enqueue($msg) }
    function Step($msg, $pct) { $sync.Step = $msg; $sync.Pct = $pct; Log "> $msg" }

    function Download($url, $file) {
        $wc = New-Object Net.WebClient
        $wc.Headers.Add("User-Agent", "VencordCustom-Installer")
        try { $wc.DownloadFile($url, $file) } finally { $wc.Dispose() }
    }

    function Invoke-Cli($cli, $verb, $b) {
        $psi = New-Object Diagnostics.ProcessStartInfo
        $psi.FileName = $cli
        $psi.Arguments = "-$verb -branch $($b.Id)"
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
        $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
        $psi.EnvironmentVariables["VENCORD_USER_DATA_DIR"] = $Target
        $psi.EnvironmentVariables["VENCORD_DEV_INSTALL"] = "1"
        $p = [Diagnostics.Process]::Start($psi)
        $p.StandardInput.Close()
        $err = $p.StandardError.ReadToEndAsync()
        $out = $p.StandardOutput.ReadToEnd()
        $p.WaitForExit()
        foreach ($line in ($out + $err.Result) -split "`r?`n") {
            $line = $line -replace "\x1b\[[0-9;]*m", ""
            if ($line.Trim()) { Log "  $line" }
        }
        if ($p.ExitCode -ne 0) { throw "The Vencord installer failed for $($b.Name) (exit code $($p.ExitCode))." }
    }

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $names = ($Selected | ForEach-Object { $_.Name }) -join ", "

        Step "Closing $names..." 5
        $exes = $Selected | ForEach-Object { $_.Exe }
        Get-Process -Name $exes -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        for ($i = 0; $i -lt 50 -and (Get-Process -Name $exes -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 100 }

        New-Item -ItemType Directory -Force $Target | Out-Null

        if ($Mode -eq "install") {
            $dist = Join-Path $Target "dist"
            $embedded = [bool]("VoidCordHost.Host" -as [type])
            $haveLocal = if ($embedded) { [VoidCordHost.Host]::Has("dist/renderer.js") } else { Test-Path "$Here\dist\renderer.js" }
            if (-not $Release -and $haveLocal) {
                Step "Copying files..." 20
                if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
                New-Item -ItemType Directory -Force $dist | Out-Null
                if ($embedded) {
                    foreach ($f in "patcher.js", "preload.js", "renderer.js", "renderer.css") {
                        [IO.File]::WriteAllBytes((Join-Path $dist $f), [VoidCordHost.Host]::Read("dist/$f"))
                    }
                } else {
                    Copy-Item "$Here\dist\*" $dist -Force
                }
            } else {
                Step "Downloading the latest VoidCord..." 20
                $tmp = Join-Path $Target "dist.download"
                if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
                New-Item -ItemType Directory -Force $tmp | Out-Null
                $base = if ($Release) { "https://github.com/$Repo/releases/download/$Release" } else { "https://github.com/$Repo/releases/latest/download" }
                foreach ($f in "patcher.js", "preload.js", "renderer.js", "renderer.css") {
                    Download "$base/$f" (Join-Path $tmp $f)
                }
                if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
                Move-Item $tmp $dist
            }
        }

        Step "Downloading the Vencord installer..." 40
        $cli = Join-Path $Target "VencordInstallerCli.exe"
        try {
            Download "https://github.com/Vencord/Installer/releases/latest/download/VencordInstallerCli.exe" "$cli.download"
            Move-Item "$cli.download" $cli -Force
        } catch {
            if (-not (Test-Path $cli)) { throw "Could not download the Vencord installer. Check your internet connection. ($($_.Exception.Message))" }
            Log "  Download failed, using the existing copy."
        }

        $i = 0
        foreach ($b in $Selected) {
            $verb = if ($Mode -eq "install") { "Installing into" } else { "Removing from" }
            Step "$verb $($b.Name)..." (55 + [int](40 * $i / $Selected.Count))
            Invoke-Cli $cli $Mode $b
            $i++
        }

        if ($StartAfter) {
            Step "Starting Discord..." 98
            foreach ($b in $Selected) {
                $update = Join-Path $env:LOCALAPPDATA "$($b.Dir)\Update.exe"
                Start-Process $update -ArgumentList "--processStart", "$($b.Exe).exe"
            }
        }
        $sync.Pct = 100
    } catch {
        $sync.Error = $_.Exception.Message
        Log "ERROR: $($_.Exception.Message)"
    } finally {
        $sync.Done = $true
    }
}

# ---------------------------------------------------------------------------
# Window

# Real Windows 11 glass behind the window (acrylic backdrop); older Windows gets a solid dark background.
# The exe brings this as [VoidCordHost.Host]::Glass; only the plain-script test run compiles it here.
if (-not $Embedded) {
Add-Type -Namespace VoidCord -Name Dwm -MemberDefinition @'
[DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
[DllImport("dwmapi.dll")] static extern int DwmExtendFrameIntoClientArea(IntPtr h, ref Margins m);
struct Margins { public int L, R, T, B; }
public static bool Glass(IntPtr h) {
    int on = 1, round = 2, acrylic = 3;
    DwmSetWindowAttribute(h, 20, ref on, 4);      // dark mode frame
    DwmSetWindowAttribute(h, 33, ref round, 4);   // rounded corners
    var m = new Margins { L = -1, R = -1, T = -1, B = -1 };
    DwmExtendFrameIntoClientArea(h, ref m);
    return DwmSetWindowAttribute(h, 38, ref acrylic, 4) == 0;
}
'@
}
$CanGlass = [Environment]::OSVersion.Version.Build -ge 22621

[xml]$Xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="VoidCord Installer" Width="452" SizeToContent="Height"
        WindowStyle="None" Background="Transparent"
        ResizeMode="NoResize" WindowStartupLocation="CenterScreen"
        FontFamily="Segoe UI Variable Text, Segoe UI" FontSize="13"
        UseLayoutRounding="True" TextOptions.TextFormattingMode="Display">
  <WindowChrome.WindowChrome>
    <WindowChrome GlassFrameThickness="-1" CaptionHeight="0" ResizeBorderThickness="0" UseAeroCaptionButtons="False"/>
  </WindowChrome.WindowChrome>
  <Window.Resources>
    <SolidColorBrush x:Key="Title" Color="#F2FFFFFF"/>
    <SolidColorBrush x:Key="Text" Color="#BFFFFFFF"/>
    <SolidColorBrush x:Key="Dim" Color="#80FFFFFF"/>
    <SolidColorBrush x:Key="Sep" Color="#17FFFFFF"/>
    <!-- Glass surfaces: faint fill, bright top edge fading down like light hitting the rim -->
    <LinearGradientBrush x:Key="GlassFill" StartPoint="0,0" EndPoint="0,1">
      <GradientStop Color="#1FFFFFFF" Offset="0"/><GradientStop Color="#0DFFFFFF" Offset="1"/>
    </LinearGradientBrush>
    <LinearGradientBrush x:Key="GlassEdge" StartPoint="0,0" EndPoint="0,1">
      <GradientStop Color="#4DFFFFFF" Offset="0"/><GradientStop Color="#0FFFFFFF" Offset="0.45"/><GradientStop Color="#1AFFFFFF" Offset="1"/>
    </LinearGradientBrush>
    <LinearGradientBrush x:Key="Sheen" StartPoint="0,0" EndPoint="0,1">
      <GradientStop Color="#40FFFFFF" Offset="0"/><GradientStop Color="#00FFFFFF" Offset="0.55"/>
    </LinearGradientBrush>

    <Style x:Key="Btn" TargetType="Button">
      <Setter Property="FocusVisualStyle" Value="{x:Null}"/>
      <Setter Property="Foreground" Value="White"/>
      <Setter Property="Background" Value="{StaticResource GlassFill}"/>
      <Setter Property="BorderBrush" Value="{StaticResource GlassEdge}"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Height" Value="36"/>
      <Setter Property="Padding" Value="22,0"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Grid x:Name="g">
              <Border Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="1" CornerRadius="18"/>
              <Border Background="{StaticResource Sheen}" CornerRadius="18" Margin="1" Opacity="0.6"/>
              <Border x:Name="hover" Background="White" CornerRadius="18" Opacity="0"/>
              <ContentPresenter Margin="{TemplateBinding Padding}" HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Grid>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="hover" Property="Opacity" Value="0.08"/></Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="hover" Property="Opacity" Value="0.16"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter TargetName="g" Property="Opacity" Value="0.35"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="Primary" TargetType="Button" BasedOn="{StaticResource Btn}">
      <Setter Property="Background">
        <Setter.Value>
          <LinearGradientBrush StartPoint="0,0" EndPoint="0,1">
            <GradientStop Color="#E63D9BFF" Offset="0"/><GradientStop Color="#E60A6CF0" Offset="1"/>
          </LinearGradientBrush>
        </Setter.Value>
      </Setter>
      <Setter Property="BorderBrush" Value="#66FFFFFF"/>
    </Style>
    <Style x:Key="Danger" TargetType="Button" BasedOn="{StaticResource Btn}">
      <Setter Property="Background">
        <Setter.Value>
          <LinearGradientBrush StartPoint="0,0" EndPoint="0,1">
            <GradientStop Color="#E6FF6A60" Offset="0"/><GradientStop Color="#E6E8352B" Offset="1"/>
          </LinearGradientBrush>
        </Setter.Value>
      </Setter>
      <Setter Property="BorderBrush" Value="#66FFFFFF"/>
    </Style>
    <Style x:Key="Link" TargetType="Button">
      <Setter Property="FocusVisualStyle" Value="{x:Null}"/>
      <Setter Property="Foreground" Value="#4DA3FF"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <ContentPresenter x:Name="c" VerticalAlignment="Center"/>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="c" Property="Opacity" Value="0.75"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <!-- Bare close X, brightens on hover -->
    <Style x:Key="Close" TargetType="Button">
      <Setter Property="FocusVisualStyle" Value="{x:Null}"/>
      <Setter Property="Width" Value="28"/>
      <Setter Property="Height" Value="28"/>
      <Setter Property="Foreground" Value="{StaticResource Dim}"/>
      <Setter Property="FontFamily" Value="Segoe MDL2 Assets"/>
      <Setter Property="FontSize" Value="11"/>
      <Setter Property="Content" Value="&#xE8BB;"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Grid x:Name="g" Background="Transparent">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Grid>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter Property="Foreground" Value="White"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter TargetName="g" Property="Opacity" Value="0.35"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="Check" TargetType="CheckBox">
      <Setter Property="FocusVisualStyle" Value="{x:Null}"/>
      <Setter Property="Foreground" Value="{StaticResource Title}"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="CheckBox">
            <Grid Background="Transparent">
              <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition/></Grid.ColumnDefinitions>
              <Grid Width="21" Height="21" VerticalAlignment="Center">
                <Ellipse x:Name="box" Stroke="#66FFFFFF" StrokeThickness="1.5" Fill="#14FFFFFF"/>
                <Ellipse x:Name="shine" Fill="{StaticResource Sheen}" Margin="1.5" Visibility="Collapsed"/>
                <Path x:Name="tick" Data="M6,10.6 L9.2,13.7 L15,7.4" Stroke="White" StrokeThickness="2"
                      StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round" Visibility="Collapsed"/>
              </Grid>
              <ContentPresenter Grid.Column="1" Margin="12,0,0,0" VerticalAlignment="Center"/>
            </Grid>
            <ControlTemplate.Triggers>
              <Trigger Property="IsChecked" Value="True">
                <Setter TargetName="box" Property="Fill" Value="#0A84FF"/>
                <Setter TargetName="box" Property="Stroke" Value="#80FFFFFF"/>
                <Setter TargetName="shine" Property="Visibility" Value="Visible"/>
                <Setter TargetName="tick" Property="Visibility" Value="Visible"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter Property="Opacity" Value="0.5"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="Card" TargetType="Border">
      <Setter Property="CornerRadius" Value="16"/>
      <Setter Property="Background" Value="{StaticResource GlassFill}"/>
      <Setter Property="BorderBrush" Value="{StaticResource GlassEdge}"/>
      <Setter Property="BorderThickness" Value="1"/>
    </Style>

    <Style x:Key="Bar" TargetType="ProgressBar">
      <Setter Property="Height" Value="6"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ProgressBar">
            <Grid>
              <Border x:Name="PART_Track" CornerRadius="3" Background="#26FFFFFF"/>
              <Border x:Name="PART_Indicator" CornerRadius="3" HorizontalAlignment="Left">
                <Border.Background>
                  <LinearGradientBrush StartPoint="0,0" EndPoint="1,0">
                    <GradientStop Color="#5E5CE6" Offset="0"/><GradientStop Color="#0A84FF" Offset="1"/>
                  </LinearGradientBrush>
                </Border.Background>
              </Border>
            </Grid>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>

  <Grid x:Name="Root">
    <!-- tint over the acrylic, plus a soft violet glow at the top -->
    <Border x:Name="Tint" Background="#8C121216"/>
    <Border IsHitTestVisible="False">
      <Border.Background>
        <RadialGradientBrush Center="0.5,0" GradientOrigin="0.5,0" RadiusX="0.9" RadiusY="0.55">
          <GradientStop Color="#332F6BFF" Offset="0"/><GradientStop Color="#00000000" Offset="1"/>
        </RadialGradientBrush>
      </Border.Background>
    </Border>

    <StackPanel Margin="20,14,20,20">
      <Grid>
        <Button x:Name="GitHubBtn" Style="{StaticResource Close}" HorizontalAlignment="Left" ToolTip="Open on GitHub">
          <Path Width="17" Height="17" Stretch="Uniform"
                Fill="{Binding Foreground, RelativeSource={RelativeSource AncestorType=Button}}"
                Data="M12,0.5 C5.65,0.5 0.5,5.65 0.5,12 C0.5,17.08 3.79,21.39 8.36,22.91 C8.94,23.01 9.15,22.66 9.15,22.35 L9.15,20.33 C5.95,21.03 5.28,18.96 5.28,18.96 C4.76,17.63 4,17.27 4,17.27 C2.95,16.55 4.08,16.57 4.08,16.57 C5.24,16.65 5.85,17.76 5.85,17.76 C6.88,19.53 8.55,19.02 9.21,18.72 C9.31,17.97 9.61,17.46 9.94,17.17 C7.39,16.88 4.7,15.89 4.7,11.48 C4.7,10.22 5.15,9.19 5.89,8.38 C5.77,8.09 5.37,6.92 6,5.33 C6,5.33 6.97,5.02 9.17,6.51 C10.09,6.25 11.08,6.13 12.06,6.12 C13.04,6.13 14.03,6.25 14.95,6.51 C17.15,5.02 18.12,5.33 18.12,5.33 C18.75,6.92 18.35,8.09 18.23,8.38 C18.97,9.19 19.42,10.22 19.42,11.48 C19.42,15.9 16.73,16.88 14.17,17.16 C14.58,17.52 14.95,18.22 14.95,19.3 L14.95,22.35 C14.95,22.66 15.16,23.02 15.75,22.91 C20.32,21.38 23.6,17.07 23.6,12 C23.5,5.65 18.35,0.5 12,0.5 Z"/>
        </Button>
        <Button x:Name="CloseBtn" Style="{StaticResource Close}" HorizontalAlignment="Right" ToolTip="Close"/>
      </Grid>

      <StackPanel HorizontalAlignment="Center" Margin="0,-14,0,0">
        <!-- logo.png (emblem + wordmark) replaces the placeholder icon and title -->
        <Image x:Name="Logo" Height="170" Visibility="Collapsed" RenderOptions.BitmapScalingMode="HighQuality">
          <Image.Effect><DropShadowEffect BlurRadius="30" ShadowDepth="0" Opacity="0.55" Color="#2F6BFF"/></Image.Effect>
        </Image>
        <StackPanel x:Name="Placeholder">
        <Grid Width="72" Height="72">
          <Border CornerRadius="18">
            <Border.Effect><DropShadowEffect BlurRadius="24" ShadowDepth="6" Direction="270" Opacity="0.45" Color="#3A1F8F"/></Border.Effect>
            <Border.Background>
              <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
                <GradientStop Color="#5E5CE6" Offset="0"/><GradientStop Color="#BF5AF2" Offset="1"/>
              </LinearGradientBrush>
            </Border.Background>
          </Border>
          <TextBlock Text="V" FontSize="38" FontWeight="Bold" Foreground="White" HorizontalAlignment="Center" VerticalAlignment="Center"
                     FontFamily="Segoe UI Variable Display, Segoe UI"/>
          <Border CornerRadius="18" BorderBrush="{StaticResource GlassEdge}" BorderThickness="1" Background="{StaticResource Sheen}" Opacity="0.7"/>
        </Grid>
        <TextBlock Text="VoidCord" Margin="0,14,0,0" FontSize="24" FontWeight="SemiBold" Foreground="{StaticResource Title}" HorizontalAlignment="Center"
                   FontFamily="Segoe UI Variable Display, Segoe UI"/>
        </StackPanel>
        <TextBlock x:Name="VersionText" Foreground="{StaticResource Dim}" FontSize="12" Margin="0,2,0,0" HorizontalAlignment="Center"/>
      </StackPanel>

      <TextBlock Text="DISCORD" Margin="6,22,0,7" FontSize="11" FontWeight="SemiBold" Foreground="{StaticResource Dim}"/>
      <Border Style="{StaticResource Card}">
        <StackPanel x:Name="BranchList"/>
      </Border>
      <Border Style="{StaticResource Card}" Margin="0,10,0,0" Padding="14,12">
        <CheckBox x:Name="StartAfter" Style="{StaticResource Check}" Content="Start Discord when done" IsChecked="True"/>
      </Border>
      <TextBlock x:Name="Hint" Margin="6,9,6,0" FontSize="12" Foreground="{StaticResource Dim}" TextWrapping="Wrap"
                 Text="Only the checked Discords are closed for a moment, the others keep running. Your Vencord settings are kept."/>

      <StackPanel x:Name="ProgressPanel" Margin="0,18,0,0" Visibility="Collapsed">
        <TextBlock x:Name="StepText" Foreground="{StaticResource Text}" Margin="2,0,0,8"/>
        <ProgressBar x:Name="Bar" Style="{StaticResource Bar}" Maximum="100"/>
      </StackPanel>

      <Border x:Name="ResultBox" CornerRadius="16" BorderThickness="1" BorderBrush="{StaticResource GlassEdge}" Padding="14,12" Margin="0,18,0,0" Visibility="Collapsed">
        <TextBlock x:Name="ResultText" TextWrapping="Wrap" Foreground="{StaticResource Title}" LineHeight="19"/>
      </Border>

      <Border x:Name="LogWrap" Style="{StaticResource Card}" Margin="0,10,0,0" Visibility="Collapsed" Background="#33000000">
        <TextBox x:Name="LogBox" Height="150" IsReadOnly="True" TextWrapping="Wrap" VerticalScrollBarVisibility="Auto"
                 FontFamily="Cascadia Mono, Consolas" FontSize="11" Background="Transparent" Foreground="{StaticResource Text}"
                 BorderThickness="0" Padding="10,8"/>
      </Border>

      <Grid Margin="0,20,0,0">
        <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
        <Button x:Name="LogToggle" Style="{StaticResource Link}" Content="Show details" Margin="6,0,0,0" HorizontalAlignment="Left"/>
        <Button x:Name="UninstallBtn" Grid.Column="1" Style="{StaticResource Btn}" Content="Uninstall" Margin="0,0,10,0"/>
        <Button x:Name="InstallBtn" Grid.Column="2" Style="{StaticResource Primary}" Content="Install"/>
      </Grid>
    </StackPanel>
  </Grid>
</Window>
'@

$win = [Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $Xaml))
$ui = @{}
foreach ($n in "Root", "Tint", "VersionText", "GitHubBtn", "CloseBtn","Logo", "Placeholder", "BranchList", "StartAfter", "Hint",
    "ProgressPanel", "StepText", "Bar", "ResultBox", "ResultText", "LogWrap", "LogBox", "LogToggle", "UninstallBtn", "InstallBtn") { $ui[$n] = $win.FindName($n) }

function Brush($hex) { [Windows.Media.BrushConverter]::new().ConvertFromString($hex) }

$win.Add_SourceInitialized({
    $hwnd = (New-Object Windows.Interop.WindowInteropHelper $win).Handle
    $glass = $false
    if ($CanGlass) {
        [Windows.Interop.HwndSource]::FromHwnd($hwnd).CompositionTarget.BackgroundColor = [Windows.Media.Colors]::Transparent
        try { $glass = if ($Embedded) { [VoidCordHost.Host]::Glass($hwnd) } else { [VoidCord.Dwm]::Glass($hwnd) } } catch { }
    }
    if (-not $glass) { $ui.Tint.Background = Brush "#1C1C20" }
})

function Load-Image($name) {
    $bytes = Get-Asset $name
    if (-not $bytes) { return }
    $img = New-Object Windows.Media.Imaging.BitmapImage
    $img.BeginInit()
    $img.StreamSource = New-Object IO.MemoryStream (, $bytes)
    $img.CacheOption = "OnLoad"
    $img.EndInit()
    $img
}
# logo.png = emblem with wordmark for the header, icon.png = emblem only for the taskbar
$logo = Load-Image "logo.png"
if ($logo) {
    $ui.Logo.Source = $logo
    $ui.Logo.Visibility = "Visible"
    $ui.Placeholder.Visibility = "Collapsed"
}
$icon = Load-Image "icon.png"
if ($icon) { $win.Icon = $icon }

$ui.VersionText.Text = if ($HasLocalDist -and $Version) { "Version $Version" }
    elseif ($HasLocalDist) { "Discord with extra plugins" }
    else { "Downloads the latest version from GitHub" }

if ($Uninstall) {
    $ui.UninstallBtn.Style = $win.FindResource("Danger")
    $ui.InstallBtn.Style = $win.FindResource("Btn")
}

$StateLook = @{
    custom = @("#30D158", "Installed")
    other  = @("#FF9F0A", "Other Vencord build")
    lost   = @("#FF9F0A", "Removed by a Discord update")
    none   = @("#8E8E93", "Not installed")
}
$script:Rows = @()
$script:Busy = $false

function Update-Buttons {
    $selectedStates = @($script:Rows | Where-Object { $_.Check.IsChecked } | ForEach-Object { $_.State })
    $any = $selectedStates.Count -gt 0
    $ui.InstallBtn.Content = if ($selectedStates -contains "lost") { "Repair" }
        elseif ($any -and -not ($selectedStates | Where-Object { $_ -ne "custom" })) { "Reinstall" }
        else { "Install" }
    $ui.InstallBtn.IsEnabled = $any -and -not $script:Busy
    $ui.UninstallBtn.IsEnabled = $any -and -not $script:Busy
}

function Update-Branches {
    $wasChecked = @{}
    foreach ($r in $script:Rows) { $wasChecked[$r.Branch.Id] = [bool]$r.Check.IsChecked }
    $ui.BranchList.Children.Clear()
    $script:Rows = @()

    $found = @(Get-InstalledBranches)
    if (-not $found) {
        $t = New-Object Windows.Controls.TextBlock
        $t.Text = "No Discord installation found. Install Discord first, start it once, then open this installer again."
        $t.TextWrapping = "Wrap"
        $t.Margin = "14,12"
        $t.Foreground = $win.FindResource("Text")
        [void]$ui.BranchList.Children.Add($t)
        Update-Buttons
        return
    }

    $states = @{}
    foreach ($b in $found) { $states[$b.Id] = Get-BranchState $b }
    $anyCustom = @($states.Values | Where-Object { $_ -ne "none" }).Count -gt 0

    foreach ($b in $found) {
        if ($script:Rows.Count) {
            $sep = New-Object Windows.Controls.Border
            $sep.Height = 1
            $sep.Margin = "46,0,0,0"
            $sep.Background = $win.FindResource("Sep")
            [void]$ui.BranchList.Children.Add($sep)
        }
        $state = $states[$b.Id]

        $row = New-Object Windows.Controls.DockPanel
        $row.Margin = "14,12"
        $row.LastChildFill = $true

        $status = New-Object Windows.Controls.StackPanel
        $status.Orientation = "Horizontal"
        $status.VerticalAlignment = "Center"
        $dot = New-Object Windows.Shapes.Ellipse
        $dot.Width = 8; $dot.Height = 8
        $dot.Fill = Brush $StateLook[$state][0]
        $dot.Margin = "0,1,7,0"
        $dot.VerticalAlignment = "Center"
        $label = New-Object Windows.Controls.TextBlock
        $label.Text = $StateLook[$state][1]
        $label.FontSize = 12
        $label.Foreground = $win.FindResource("Text")
        [void]$status.Children.Add($dot)
        [void]$status.Children.Add($label)
        [Windows.Controls.DockPanel]::SetDock($status, "Right")

        $cb = New-Object Windows.Controls.CheckBox
        $cb.Style = $win.FindResource("Check")
        $cb.Content = $b.Name
        # Default: everything already modded, otherwise just the first Discord
        $cb.IsChecked = if ($wasChecked.ContainsKey($b.Id)) { $wasChecked[$b.Id] }
            elseif ($anyCustom) { $state -ne "none" }
            else { $b -eq $found[0] }
        $cb.Add_Click({ Update-Buttons })

        [void]$row.Children.Add($status)
        [void]$row.Children.Add($cb)
        [void]$ui.BranchList.Children.Add($row)
        $script:Rows += @{ Branch = $b; Check = $cb; State = $state }
    }

    Update-Buttons
}

function Show-Result($ok, $text) {
    $ui.ResultBox.Background = Brush $(if ($ok) { "#2E30D158" } else { "#38FF453A" })
    $ui.ResultText.Text = $text
    $ui.ResultBox.Visibility = "Visible"
}

function Set-LogVisible($show) {
    $ui.LogWrap.Visibility = if ($show) { "Visible" } else { "Collapsed" }
    $ui.LogToggle.Content = if ($show) { "Hide details" } else { "Show details" }
}

function Start-Job2($mode) {
    $selected = @($script:Rows | Where-Object { $_.Check.IsChecked } | ForEach-Object { $_.Branch })
    if (-not $selected) { return }

    $script:Busy = $true
    $script:Mode = $mode
    $script:Selected = $selected
    Update-Buttons
    foreach ($r in $script:Rows) { $r.Check.IsEnabled = $false }
    $ui.StartAfter.IsEnabled = $false
    $ui.CloseBtn.IsEnabled = $false
    $ui.ResultBox.Visibility = "Collapsed"
    $ui.ProgressPanel.Visibility = "Visible"
    $ui.Bar.Value = 0
    $ui.LogBox.Clear()

    $script:Sync = [hashtable]::Synchronized(@{
        Queue = New-Object Collections.Concurrent.ConcurrentQueue[string]
        Step = "Starting..."; Pct = 0; Done = $false; Error = $null
    })
    $script:Runspace = [runspacefactory]::CreateRunspace()
    $script:Runspace.Open()
    $script:Job = [powershell]::Create()
    $script:Job.Runspace = $script:Runspace
    [void]$script:Job.AddScript($Worker).AddArgument($mode).AddArgument($selected).AddArgument($Here).AddArgument($Target).
        AddArgument($Repo).AddArgument([bool]$ui.StartAfter.IsChecked).AddArgument($script:LatestTag).AddArgument($script:Sync)
    [void]$script:Job.BeginInvoke()
    $script:Timer.Start()
}

function Complete-Job {
    $script:Timer.Stop()
    $script:Job.Dispose()
    $script:Runspace.Close()
    $script:Busy = $false
    $ui.StartAfter.IsEnabled = $true
    $ui.CloseBtn.IsEnabled = $true
    $ui.ProgressPanel.Visibility = "Collapsed"

    $names = ($script:Selected | ForEach-Object { $_.Name }) -join ", "
    $err = $script:Sync.Error
    if ($err) {
        Show-Result $false "Something went wrong:`n$err"
        Set-LogVisible $true
    } elseif ($script:Mode -eq "install") {
        $arrow = [char]0x203A
        Show-Result $true ("Done! VoidCord is installed in $names.`n`n" +
            "First time? In Discord open Settings $arrow Vencord $arrow Plugins, turn on PluginHub and press Ctrl+R. " +
            "The grid icon at the top left then lets you manage all custom plugins.")
    } else {
        Show-Result $true "Uninstalled. $names is back to normal."
    }
    Update-Branches
}

$script:Timer = New-Object Windows.Threading.DispatcherTimer
$script:Timer.Interval = [TimeSpan]::FromMilliseconds(80)
$script:Timer.Add_Tick({
    $line = $null
    while ($script:Sync.Queue.TryDequeue([ref]$line)) { $ui.LogBox.AppendText("$line`r`n") }
    $ui.LogBox.ScrollToEnd()
    $ui.StepText.Text = $script:Sync.Step
    $ui.Bar.Value = $script:Sync.Pct
    if ($script:Sync.Done) { Complete-Job }
})

$win.Add_MouseLeftButtonDown({ $win.DragMove() })
$ui.CloseBtn.Add_Click({ $win.Close() })
$ui.LogToggle.Add_Click({ Set-LogVisible ($ui.LogWrap.Visibility -ne "Visible") })
$ui.InstallBtn.Add_Click({ Start-Job2 "install" })
$ui.UninstallBtn.Add_Click({ Start-Job2 "uninstall" })
$win.Add_Closing({ if ($script:Busy) { $_.Cancel = $true } })
$win.Add_KeyDown({ if ($_.Key -eq "Escape" -and -not $script:Busy) { $win.Close() } })
# A bug in a click handler shows up in the window instead of closing the whole installer
$win.Dispatcher.Add_UnhandledException({
    $_.Handled = $true
    $msg = $_.Exception.Message
    if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
    $ui.LogBox.AppendText("ERROR: $msg`r`n")
    Show-Result $false "Something went wrong in the installer:`n$msg"
})

$ui.GitHubBtn.Add_Click({ Start-Process "https://github.com/$Repo" })

# ---------------------------------------------------------------------------
# Update check: is there a newer release than the one this installer was built from?
# Newer release -> download the new VoidCord-Installer.exe, swap it in place of this one and restart it.
# If that fails (e.g. the exe sits in a read-only folder), the newest plugins are downloaded from GitHub on install.
# Only for the packaged installer (it has a version), never for the script in the project folder.

$script:LatestTag = $null

# Returns $true when the installer replaced itself
function Update-Self($release) {
    $asset = "VoidCord-Installer.exe"
    if ($Updated -or $script:Busy -or -not $ExePath -or -not ($release.assets | Where-Object { $_.name -eq $asset })) { return $false }
    $new = "$ExePath.new"
    $old = "$ExePath.old"
    try {
        $wc = New-Object Net.WebClient
        $wc.Headers.Add("User-Agent", "VoidCord-Installer")
        try { $wc.DownloadFile("https://github.com/$Repo/releases/download/$($release.tag_name)/$asset", $new) } finally { $wc.Dispose() }
        # A running exe can't be overwritten but can be renamed; the new exe deletes the .old file on start
        Remove-Item $old -ErrorAction SilentlyContinue
        Move-Item $ExePath $old
        Move-Item $new $ExePath
        Start-Process $ExePath -ArgumentList (@("/updated") + $(if ($Uninstall) { "/uninstall" }))
        $win.Close()
        return $true
    } catch {
        if (-not (Test-Path $ExePath) -and (Test-Path $old)) { Move-Item $old $ExePath -ErrorAction SilentlyContinue }
        Remove-Item $new -ErrorAction SilentlyContinue
        return $false
    }
}

if ($Version) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $script:CheckClient = New-Object Net.WebClient
    $script:CheckClient.Headers.Add("User-Agent", "VoidCord-Installer")
    $script:CheckClient.Headers.Add("Accept", "application/vnd.github+json")
    $script:CheckTask = $script:CheckClient.DownloadStringTaskAsync("https://api.github.com/repos/$Repo/releases/latest")
    $ui.VersionText.Text = "Version $Version - checking for updates..."

    $script:CheckTimer = New-Object Windows.Threading.DispatcherTimer
    $script:CheckTimer.Interval = [TimeSpan]::FromMilliseconds(150)
    $script:CheckTimer.Add_Tick({
        if (-not $script:CheckTask.IsCompleted) { return }
        $script:CheckTimer.Stop()
        $script:CheckClient.Dispose()
        if ($script:CheckTask.Status -ne "RanToCompletion") { $ui.VersionText.Text = "Version $Version"; return }
        $release = $script:CheckTask.Result | ConvertFrom-Json
        $tag = $release.tag_name
        if (-not $tag -or $tag -eq $Version) { $ui.VersionText.Text = "Version $Version - up to date"; return }
        $ui.VersionText.Text = "Updating the installer..."
        if (Update-Self $release) { return }
        $script:LatestTag = $tag
        $ui.VersionText.Text = "Version $tag - newest, downloaded from GitHub"
    })
    $script:CheckTimer.Start()
}

Update-Branches
[void]$win.ShowDialog()
