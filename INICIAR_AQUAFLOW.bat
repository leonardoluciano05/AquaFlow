@echo off
chcp 65001 >nul
title AquaFlow
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao foi encontrado.
  echo Instale o Node.js 18 ou superior e tente novamente.
  pause
  exit /b 1
)

if not exist .env (
  copy .env.example .env >nul
  echo Arquivo .env criado a partir do exemplo.
  echo Para Google e envio real de e-mails, configure as credenciais nesse arquivo.
  echo.
)

if not exist node_modules (
  echo Instalando dependencias do AquaFlow...
  call npm install
  if errorlevel 1 (
    echo Falha ao instalar dependencias.
    pause
    exit /b 1
  )
)

echo.
echo Iniciando AquaFlow em http://localhost:3000
start "" http://localhost:3000
call npm start
