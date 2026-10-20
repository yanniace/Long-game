#!/bin/zsh

cd "$(dirname "$0")"

lsof -ti:8000 | xargs kill -9 2>/dev/null
sleep 0.5

/usr/bin/python3 phd_bridge.py &

sleep 1.5
open http://localhost:8000