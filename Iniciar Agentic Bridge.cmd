@echo off
title Agentic Bridge
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias por primera vez...
  call npm install --no-audit --no-fund
)
node server\index.js --open
pause
