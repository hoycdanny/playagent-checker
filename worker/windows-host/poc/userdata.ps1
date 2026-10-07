<powershell>
# PoC 主機保險:4 小時後自動關機(實例設定為關機即終止),避免忘記關機持續計費。
shutdown.exe /s /t 14400 /c "playagent windows poc auto-terminate"
</powershell>
