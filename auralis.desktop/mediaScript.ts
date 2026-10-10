// SPDX-License-Identifier: GPL-3.0-or-later
// Fixed script. No renderer arguments are interpolated into PowerShell.
export const mediaScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
    $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq ('IAsyncOperation' + [char]96 + '1')
    } | Select-Object -First 1
    function Await-WinRT($operation, $resultType) {
        $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
        if (-not $task.Wait(4000)) { throw 'timeout' }
        return $task.Result
    }
    $manager = Await-WinRT ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    while ($true) {
    $sessions = @($manager.GetSessions() | Where-Object {
        $_.SourceAppUserModelId -match '^(Spotify\.exe|Spotify|SpotifyAB\.SpotifyMusic_.+!Spotify)$'
    })
    $session = $sessions | Where-Object { $_.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing' } | Select-Object -First 1
    if (-not $session) { $session = $sessions | Select-Object -First 1 }
    if (-not $session) {
        @{ status = 'idle'; track = $null } | ConvertTo-Json -Compress
        [Console]::Out.Flush()
        Start-Sleep -Milliseconds 500
        continue
    }
    $media = Await-WinRT ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $playing = $session.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing'
    $timeline = $session.GetTimelineProperties()
    $now = [DateTimeOffset]::UtcNow
    $duration = [Math]::Max(0, ($timeline.EndTime - $timeline.StartTime).TotalMilliseconds)
    $position = [Math]::Max(0, ($timeline.Position - $timeline.StartTime).TotalMilliseconds)
    if ($playing -and $duration -gt 0) {
        $elapsed = [Math]::Max(0, ($now - $timeline.LastUpdatedTime).TotalMilliseconds)
        $position = [Math]::Min($duration, $position + $elapsed)
    }
    @{ status = 'ready'; track = @{
        title = [string]$media.Title
        artist = [string]$media.Artist
        album = [string]$media.AlbumTitle
        playing = $playing
        positionMs = [Math]::Round($position)
        durationMs = [Math]::Round($duration)
        observedAt = $now.ToUnixTimeMilliseconds()
    }} | ConvertTo-Json -Compress -Depth 3
    [Console]::Out.Flush()
    Start-Sleep -Milliseconds 500
    }
} catch {
    @{ status = 'error'; track = $null } | ConvertTo-Json -Compress
    exit 0
}
`;

// One-shot: prints the current Spotify session's cover as base64 together with its title and artist, so the caller
// can check that the picture belongs to the song it asked about. Also a fixed script without arguments.
export const coverScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
    $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]
    $null = [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq ('IAsyncOperation' + [char]96 + '1')
    } | Select-Object -First 1
    function Await-WinRT($operation, $resultType) {
        $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
        if (-not $task.Wait(4000)) { throw 'timeout' }
        return $task.Result
    }
    $manager = Await-WinRT ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    $sessions = @($manager.GetSessions() | Where-Object {
        $_.SourceAppUserModelId -match '^(Spotify\.exe|Spotify|SpotifyAB\.SpotifyMusic_.+!Spotify)$'
    })
    $session = $sessions | Where-Object { $_.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing' } | Select-Object -First 1
    if (-not $session) { $session = $sessions | Select-Object -First 1 }
    if (-not $session) { throw 'no session' }
    $media = Await-WinRT ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if (-not $media.Thumbnail) { throw 'no cover' }
    $stream = Await-WinRT ($media.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    # PowerShell can't call the stream's own methods; the reflection call lets .NET cast it to IInputStream.
    $asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [type[]]@([Windows.Storage.Streams.IInputStream]))
    $memory = [System.IO.MemoryStream]::new()
    $asStream.Invoke($null, @($stream)).CopyTo($memory)
    @{ title = [string]$media.Title; artist = [string]$media.Artist; data = [Convert]::ToBase64String($memory.ToArray()) } | ConvertTo-Json -Compress
} catch {
    '{}'
}
`;
