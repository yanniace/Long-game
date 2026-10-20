#!/bin/zsh
# The Long Game · restart the local bridge, then open the dashboard.
cd "$(dirname "$0")" || exit 1

# Restart only our own bridge. Do not kill an unrelated app on port 8000.
pids=$(lsof -nP -tiTCP:8000 -sTCP:LISTEN 2>/dev/null)
if [[ -n "$pids" ]]; then
  for pid in $(printf '%s\n' "$pids"); do
    cmd=$(ps -p "$pid" -o command= 2>/dev/null)
    if [[ "$cmd" != *"phd_bridge.py"* ]]; then
      echo "Port 8000 belongs to another process: $cmd"
      echo "Close that process before starting The Long Game."
      exit 1
    fi
    kill "$pid" 2>/dev/null
  done
  for attempt in {1..25}; do
    lsof -nP -tiTCP:8000 -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 0.2
  done
fi
if lsof -nP -tiTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 8000 is still busy. Close the old bridge and try again."
  exit 1
fi

# nohup keeps the bridge alive after the Terminal window or browser closes.
nohup /usr/bin/python3 -u "$PWD/phd_bridge.py" >> "$PWD/phd_bridge.log" 2>&1 </dev/null &
sleep 1.5
if curl -fsS --max-time 3 http://localhost:8000/api/ping >/dev/null; then
  open http://localhost:8000
  echo "The Long Game is running. You can close this Terminal window."
else
  echo "The bridge did not start. Check phd_bridge.log in this folder."
  exit 1
fi
