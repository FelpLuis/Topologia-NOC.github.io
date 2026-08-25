@echo off
REM Ponto de entrada do coletor GPON quando ele roda como Tarefa Agendada.
REM Existe por tres motivos que a acao da tarefa sozinha nao resolve:
REM   1. o coletor le .collector.env de path.resolve(".collector.env"), entao o
REM      diretorio de trabalho precisa ser a raiz do projeto, e nao system32;
REM   2. a saida (erros de OLT, IXC e push) precisa ir para algum lugar onde
REM      alguem possa ler depois - tarefa agendada nao guarda stdout;
REM   3. o log e rotacionado a cada partida, senao um erro repetido a cada 30 s
REM      enche o disco em semanas de operacao continua.
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
if exist "logs\collector.log" (
  if exist "logs\collector.prev.log" del /q "logs\collector.prev.log"
  move /y "logs\collector.log" "logs\collector.prev.log" >nul
)
echo [%DATE% %TIME%] iniciando coletor GPON>> "logs\collector.log"
"C:\Program Files\nodejs\node.exe" collector\server.mjs >> "logs\collector.log" 2>&1
echo [%DATE% %TIME%] coletor encerrou com codigo %ERRORLEVEL%>> "logs\collector.log"
exit /b %ERRORLEVEL%
