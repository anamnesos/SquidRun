@echo off
cd /d D:\projects\hivemind
echo Starting Hivemind... > hivemind_log.txt 2>&1
echo Working directory: %CD% >> hivemind_log.txt 2>&1
python --version >> hivemind_log.txt 2>&1
echo Running hivemind... >> hivemind_log.txt 2>&1
python -m src.hivemind >> hivemind_log.txt 2>&1
echo Exit code: %ERRORLEVEL% >> hivemind_log.txt 2>&1
notepad hivemind_log.txt
