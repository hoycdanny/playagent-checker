# Windows 主機 helper 程序:載入 WinHelper.cs,從 stdin 一行一個 JSON 指令,stdout 一行一個 JSON 回應。
# 由 windowsClient.mjs 啟動(必須在互動式桌面的 session 裡執行,才有畫面與輸入)。
# 指令:{ "id":1, "cmd":"shot|click|drag|type|key|size|launch|kill|running|foreground|fgname|focus|rect|audio", ... }
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -Path (Join-Path $PSScriptRoot 'WinHelper.cs') -ReferencedAssemblies System.Drawing
[WinHelper]::Init()
$stdout = [Console]::Out
$stdout.WriteLine((@{ id = 0; ok = $true; result = @{ ready = $true; width = [WinHelper]::Width; height = [WinHelper]::Height } } | ConvertTo-Json -Compress))
$stdout.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    $a = $req
    $result = switch ($req.cmd) {
      'shot' { [WinHelper]::Shot() }
      'size' { @{ width = [WinHelper]::Width; height = [WinHelper]::Height } }
      'click' { [WinHelper]::Click([int]$a.x, [int]$a.y); $true }
      'drag' { [WinHelper]::Drag([int]$a.x, [int]$a.y, [int]$a.x2, [int]$a.y2, [int]$a.ms); $true }
      'type' { [WinHelper]::TypeText([string]$a.text); $true }
      'key' { [WinHelper]::Key([int]$a.vk); $true }
      'launch' {
        $p = Start-Process -FilePath ([string]$a.exe) -WorkingDirectory (Split-Path ([string]$a.exe)) -PassThru
        $p.Id
      }
      'kill' { Get-Process -Name ([string]$a.name) -ErrorAction SilentlyContinue | Stop-Process -Force; $true }
      'running' { [bool](Get-Process -Name ([string]$a.name) -ErrorAction SilentlyContinue) }
      'foreground' { [WinHelper]::IsForeground([string]$a.name) }
      'fgname' { [WinHelper]::ForegroundName() }
      'focus' { [WinHelper]::Focus([string]$a.name) }
      'rect' { [WinHelper]::WindowRect([string]$a.name) }
      # 音量取樣:回一個 JSON 字串(由 C# 自己組),這裡原樣帶回不要再包一層。
      'audio' { [WinHelper]::AudioSample([int]$a.ms) }
      # 音訊鏈自我檢查:自己播一段正弦波,看音量表會不會動(只在遊戲啟動前跑)。
      'audiotest' { [WinHelper]::AudioSelfTest() }
      # 音訊診斷:列出所有輸出端點與程序層級 session,播測試音前後各量一輪(自我檢查失敗時才跑)。
      'audiodiag' { [WinHelper]::AudioDiagnose() }
      'quit' { exit 0 }
      default { throw "unknown cmd $($req.cmd)" }
    }
    $stdout.WriteLine((@{ id = $req.id; ok = $true; result = $result } | ConvertTo-Json -Compress -Depth 4))
  } catch {
    $id = if ($req) { $req.id } else { -1 }
    $stdout.WriteLine((@{ id = $id; ok = $false; error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress))
  }
  $stdout.Flush()
}
