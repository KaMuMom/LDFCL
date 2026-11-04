// All variable input is JSON data. No user paths are interpolated into script
// source or a shell command. Compatible with stock Windows PowerShell 5.1.
export const UPDATE_HELPER = String.raw`param([Parameter(Mandatory=$true)][string]$Transaction)
$ErrorActionPreference = 'Stop'
$AttemptFolder = [System.IO.Path]::GetDirectoryName($Transaction)
$LogFile = [System.IO.Path]::Combine($AttemptFolder, 'update.log')
$Config = $null
$OriginalMoved = $false
$ReplacementMoved = $false
$NewProcess = $null
function Write-Log([string]$Message) {
  [System.IO.File]::AppendAllText($LogFile, ([DateTime]::UtcNow.ToString('o') + ' ' + $Message + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
}
function Write-Json([string]$File, $Value) {
  $Temporary = $File + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  [System.IO.File]::WriteAllText($Temporary, ($Value | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding($false)))
  if ([System.IO.File]::Exists($File)) { [System.IO.File]::Replace($Temporary, $File, $null) }
  else { [System.IO.File]::Move($Temporary, $File) }
}
function Get-Hash([string]$File) {
  $Stream = [System.IO.File]::OpenRead($File)
  $Hasher = [System.Security.Cryptography.SHA256]::Create()
  try { return [System.BitConverter]::ToString($Hasher.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
  finally { $Stream.Dispose(); $Hasher.Dispose() }
}
function Assert-Regular([string]$File) {
  $Attributes = [System.IO.File]::GetAttributes($File)
  if (($Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or ($Attributes -band [System.IO.FileAttributes]::Directory)) { throw 'Update path must be a regular file' }
}
function Assert-Staged {
  Assert-Regular $Config.staged
  if ((Get-Hash $Config.staged) -ne $Config.expected) { throw 'Update checksum mismatch' }
}
function Assert-NotCancelled {
  if ([System.IO.File]::Exists([System.IO.Path]::Combine($AttemptFolder, 'cancel'))) { throw 'Update cancelled before launcher exit' }
}
function Wait-TargetReleased([int]$Timeout) {
  $Deadline = [DateTime]::UtcNow.AddMilliseconds($Timeout)
  do {
    Assert-NotCancelled
    $Owners = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath -eq $Config.target })
    if (-not $Owners.Count) {
      try {
        $Probe = [System.IO.File]::Open($Config.target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $Probe.Dispose()
        return
      } catch {}
    }
    [System.Threading.Thread]::Sleep(200)
  } while ([DateTime]::UtcNow -lt $Deadline)
  throw 'Portable launcher is still running or its file is locked; original file was kept'
}
function Quote-Argument([string]$Value) {
  $Escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $Escaped = [regex]::Replace($Escaped, '(\\+)$', '$1$1')
  return '"' + $Escaped + '"'
}
function Start-Launcher([bool]$Updating) {
  $Start = New-Object System.Diagnostics.ProcessStartInfo
  $Start.FileName = $Config.target
  $Start.WorkingDirectory = [System.IO.Path]::GetDirectoryName($Config.target)
  $Start.UseShellExecute = $false
  $Start.CreateNoWindow = $true
  $Start.Arguments = (@($Config.arguments | ForEach-Object { Quote-Argument ([string]$_) }) -join ' ')
  foreach ($Key in @($Start.EnvironmentVariables.Keys)) {
    if ($Key -like 'PORTABLE_EXECUTABLE*' -or $Key -in @('ELECTRON_RUN_AS_NODE', 'LDFCL_UPDATE_TRANSACTION', 'LDFCL_UPDATE_NONCE')) { $Start.EnvironmentVariables.Remove($Key) }
  }
  if ($Updating) {
    $Start.EnvironmentVariables['LDFCL_UPDATE_TRANSACTION'] = $Transaction
    $Start.EnvironmentVariables['LDFCL_UPDATE_NONCE'] = $Config.nonce
  }
  return [System.Diagnostics.Process]::Start($Start)
}
function Publish-Result([string]$Status, [string]$Message) {
  $Result = @{ id=$Config.id; status=$Status; version=$Config.version; target=$Config.target; completedAt=[DateTime]::UtcNow.ToString('o'); message=$Message; logPath=$LogFile }
  Write-Json ([System.IO.Path]::Combine($AttemptFolder, 'result.json')) $Result
  $Root = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($Config.target), '.ldfcl-update')
  Write-Json ([System.IO.Path]::Combine($Root, 'last-result.json')) $Result
  Write-Log ($Status + ': ' + $Message)
}
try {
  Write-Log 'Helper entered; reading transaction'
  $Config = [System.IO.File]::ReadAllText($Transaction) | ConvertFrom-Json
  if ($Config.schema -ne 1 -or $Config.nonce -notmatch '^[a-f0-9]{64}$' -or $Config.expected -notmatch '^[a-f0-9]{64}$') { throw 'Invalid update transaction' }
  Assert-Regular $Config.target
  Assert-Staged
  Write-Json ([System.IO.Path]::Combine($AttemptFolder, 'ready.json')) @{ id=$Config.id; nonce=$Config.nonce; helperPid=$PID }
  Write-Log 'Ready handshake published; waiting for current Electron process'
  $Deadline = [DateTime]::UtcNow.AddMilliseconds($Config.exitTimeoutMs)
  do {
    Assert-NotCancelled
    $Owner = $null
    try { $Owner = [System.Diagnostics.Process]::GetProcessById([int]$Config.launcherPid) } catch {}
    if (-not $Owner -or $Owner.HasExited) { break }
    if ([DateTime]::UtcNow -ge $Deadline) { throw 'Current launcher did not exit; original file was kept' }
    [System.Threading.Thread]::Sleep(100)
  } while ($true)
  Write-Log 'Electron exited; waiting for portable wrapper and file lock'
  Wait-TargetReleased $Config.replaceTimeoutMs
  Assert-Staged
  [System.IO.File]::Move($Config.target, $Config.backup)
  $OriginalMoved = $true
  [System.IO.File]::Move($Config.staged, $Config.target)
  $ReplacementMoved = $true
  Write-Log 'Replacement published; starting new launcher with clean portable environment'
  $NewProcess = Start-Launcher $true
  $Deadline = [DateTime]::UtcNow.AddMilliseconds($Config.healthTimeoutMs)
  $Healthy = $false
  $Receipt = $null
  do {
    $HealthyFile = [System.IO.Path]::Combine($AttemptFolder, 'healthy.json')
    if ([System.IO.File]::Exists($HealthyFile)) {
      $Receipt = [System.IO.File]::ReadAllText($HealthyFile) | ConvertFrom-Json
      if ($Receipt.id -ne $Config.id -or $Receipt.nonce -ne $Config.nonce -or $Receipt.version -ne $Config.version) { throw 'New launcher returned an invalid health receipt' }
      $Alive = [System.Diagnostics.Process]::GetProcessById([int]$Receipt.processId)
      if ($Alive.HasExited) { throw 'New launcher exited before becoming healthy' }
      [System.Threading.Thread]::Sleep($Config.healthGraceMs)
      $Alive.Refresh()
      if ($Alive.HasExited) { throw 'New launcher exited immediately after startup' }
      $Healthy = $true
      break
    }
    $NewProcess.Refresh()
    if ($NewProcess.HasExited) { throw ('New portable launcher exited before readiness (code ' + $NewProcess.ExitCode + ')') }
    [System.Threading.Thread]::Sleep(100)
  } while ([DateTime]::UtcNow -lt $Deadline)
  if (-not $Healthy) { throw 'New launcher did not confirm application readiness in time' }
  Publish-Result 'installed' 'Updated launcher confirmed application readiness; previous executable retained as backup'
} catch {
  $Reason = $_.Exception.Message
  try { Write-Log ('Failure: ' + $Reason) } catch {}
  $Status = 'failed'
  if ($OriginalMoved) {
    try {
      if ($NewProcess -and -not $NewProcess.HasExited) {
        & ([System.IO.Path]::Combine($env:SystemRoot, 'System32', 'taskkill.exe')) /PID $NewProcess.Id /T /F 2>$null | Out-Null
        $NewProcess.WaitForExit(10000) | Out-Null
      }
      if ($ReplacementMoved) {
        Wait-TargetReleased $Config.replaceTimeoutMs
        [System.IO.File]::Move($Config.target, $Config.staged)
      }
      [System.IO.File]::Move($Config.backup, $Config.target)
      $Status = 'rolled-back'
      Write-Log 'Original executable restored'
      Publish-Result $Status $Reason
      try { $Restarted = Start-Launcher $false; Write-Log ('Restarted previous portable launcher PID ' + $Restarted.Id) }
      catch { $Reason += '; previous launcher restart failed: ' + $_.Exception.Message }
    } catch { $Reason += '; rollback could not finish; backup retained at ' + $Config.backup + ': ' + $_.Exception.Message }
  }
  if ($Config) { try { Publish-Result $Status $Reason } catch { try { Write-Log $_.Exception.Message } catch {} } }
  exit 1
}
`;
