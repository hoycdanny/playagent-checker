# 在互動式桌面測旋轉(由 run-script.ps1 觸發):結果寫到 C:\poc\out\interactive.log。
$log = 'C:\poc\out\interactive.log'
Add-Type -Path C:\poc\PocHelper.cs -ReferencedAssemblies System.Drawing
[PocHelper]::Init()
"displays:`n$([PocHelper]::Displays())" | Add-Content $log -Encoding UTF8
"rotate DISPLAY2: $([PocHelper]::TryRotate('\\.\DISPLAY2'))" | Add-Content $log -Encoding UTF8
'done' | Set-Content C:\poc\out\interactive.done
