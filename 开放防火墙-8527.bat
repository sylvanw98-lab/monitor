@echo off
chcp 65001 >nul
echo 正在添加防火墙放行规则: Dreamina Monitor 8527 ...
netsh advfirewall firewall add rule name="Dreamina Monitor 8527" dir=in action=allow protocol=TCP localport=8527
if %errorlevel%==0 (
  echo.
  echo 成功！其他电脑现在可以访问 http://10.10.10.248:8527
) else (
  echo.
  echo 添加失败，请确认已"以管理员身份运行"本脚本。
)
pause
