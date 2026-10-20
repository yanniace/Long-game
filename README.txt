The Long Game · v42 background reminders
========================================
Contains:
  phd_dashboard.html  - v41 reports + browser fallback when the bridge is offline
  phd_bridge.py       - v42 local server + macOS notification watcher
  start.command       - safely restarts the bridge and keeps it running in background

How to install on your Mac
1. In the CURRENT dashboard, click Backup and keep the exported JSON somewhere safe.
2. Quit the currently running TLG bridge / close its Terminal window if desired.
3. Copy your existing phd_dashboard.html, phd_bridge.py, start.command AND data.json
   to a separate backup folder. Never replace or delete your existing data.json.
4. Put these three new files in the SAME TLG folder as data.json. In particular,
   the HTML filename must be phd_dashboard.html, which the bridge serves at /.
5. Double-click start.command. If macOS prevents it from running, open Terminal,
   change into your TLG folder, run: chmod +x start.command; ./start.command
6. Open http://localhost:8000. Click Enable alerts (shows "Alerts on · Mac").
   Allow notifications from Terminal / osascript if macOS asks.

Timing
- Focus Timer: first alert after 120 min, then every 30 min while still running.
- Office Hours: first alert from your selected check-out time (default 18:00),
  then every 30 min until you check out. If you clock in AFTER that time,
  the first alert is 2 hours after clock-in instead of immediately.
- Only today's/yesterday's open office intervals are eligible. No historical
  cleanup, time change, automatic checkout, or data.json migration is performed.
- On Mac sleep, alerts may be delayed; alerts cannot run while the computer is off.
- The background monitor works while the Python bridge keeps running, even with
  the browser closed. The notification center may be muted by macOS Focus mode.
- If you use only the HTML without the new bridge, the older browser-only
  notification behavior remains available.

Your saved D.reminderSettings.enabled flag is respected. The first activation
still requires clicking Enable alerts in the dashboard. The new bridge does
not automatically opt you in or copy or modify your historical data.
