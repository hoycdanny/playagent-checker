# 讓 NVIDIA L4 成為主要顯示器:停用 EC2 的 Microsoft Basic Display Adapter。
# 否則遊戲的 OpenGL context 建在基本顯示卡上(只有 GDI 的 OpenGL 1.1),Cocos 會跳「OpenGL Error」。
Get-PnpDevice -Class Display | Format-Table FriendlyName, Status, InstanceId -AutoSize | Out-String -Width 300
Get-PnpDevice -Class Display | Where-Object FriendlyName -like '*Basic Display*' | Disable-PnpDevice -Confirm:$false
Start-Sleep 5
Get-PnpDevice -Class Display | Format-Table FriendlyName, Status -AutoSize | Out-String -Width 300
