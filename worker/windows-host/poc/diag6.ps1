# 診斷 6:遊戲的模擬器 / 虛擬機偵測設定,以及這台主機會被看到的虛擬化特徵。
"== emulator_detection_config.json"
Get-Content C:\Games\SouthPark\InannaLua\emulator_detection_config.json -Encoding UTF8
"== UserDefault.xml"
Get-Content C:\Games\SouthPark\UserDefault.xml -Encoding UTF8
"== VM signals"
Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer, Model, HypervisorPresent | Format-List | Out-String
Get-CimInstance Win32_BIOS | Select-Object Manufacturer, SMBIOSBIOSVersion, SerialNumber | Format-List | Out-String
Get-CimInstance Win32_BaseBoard | Select-Object Manufacturer, Product | Format-List | Out-String
