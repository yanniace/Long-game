#!/usr/bin/env python3
"""
The Long Game · Bridge Server
Port 8000 · macOS

- Serves phd_dashboard.html
- Persists dashboard data to data.json (same folder)
- Optional: syncs Apple Reminders + Calendar
"""

import datetime, http.server, json, subprocess, sys, os, tempfile, threading, time, mimetypes
from urllib.parse import unquote

PORT = int(os.environ.get('TLG_PORT', '8000'))
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE   = os.path.join(SCRIPT_DIR, 'data.json')
DATA_LOCK   = threading.RLock()
MAX_DATA_BYTES = 10 * 1024 * 1024
STATIC_FILES = {
    '/config.js': 'config.js',
    '/cloud-sync.js': 'cloud-sync.js',
    '/sync.css': 'sync.css',
    '/manifest.webmanifest': 'manifest.webmanifest',
    '/service-worker.js': 'service-worker.js',
    '/icons/icon-192.svg': 'icons/icon-192.svg',
    '/icons/icon-512.svg': 'icons/icon-512.svg',
    '/icons/icon-192.png': 'icons/icon-192.png',
    '/icons/icon-512.png': 'icons/icon-512.png',
}
INBOX_LIST  = 'TLG Inbox'
INBOX_POLL_SECONDS = 60
INBOX_STATUS = {'lastRun': None, 'configSynced': False, 'imported': [], 'errors': []}

def load_data():
    with DATA_LOCK:
        if not os.path.exists(DATA_FILE):
            return None
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)

def save_data_atomic(data, backup=False):
    """Write complete JSON without leaving a half-written data file."""
    with DATA_LOCK:
        if backup and os.path.exists(DATA_FILE):
            with open(DATA_FILE, 'rb') as src, open(DATA_FILE + '.inbox-backup', 'wb') as dst:
                dst.write(src.read())
        fd, tmp = tempfile.mkstemp(prefix='.data-', suffix='.json', dir=SCRIPT_DIR)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, DATA_FILE)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

# ── Apple AppleScript helpers ──────────────────────────────
def run_applescript(script):
    with tempfile.NamedTemporaryFile(mode='w', suffix='.applescript',
                                     delete=False, encoding='utf-8') as f:
        f.write(script); tmp = f.name
    try:
        r = subprocess.run(['osascript', tmp], capture_output=True, text=True, timeout=20)
        return r.stdout.strip(), r.stderr.strip()
    finally:
        os.unlink(tmp)

REMINDERS_SCRIPT = r"""
tell application "Reminders"
    set out to ""
    set today to current date
    set s to today - (time of today)
    set e to s + 86399
    repeat with L in lists
        repeat with r in (reminders in L whose completed is false)
            try
                set dd to due date of r
                if dd >= s and dd <= e then
                    set yr to year of dd as integer
                    set mo to (month of dd) as integer
                    set dy to day of dd as integer
                    set hh to hours of dd as integer
                    set mm to minutes of dd as integer
                    set ds to (yr as text)&"-"&text -2 thru -1 of("0"&mo)&"-"&text -2 thru -1 of("0"&dy)&" "&text -2 thru -1 of("0"&hh)&":"&text -2 thru -1 of("0"&mm)
                    set out to out&(name of r)&"|||"&ds&"|||"&(name of L)&"\n"
                end if
            end try
        end repeat
    end repeat
    return out
end tell
"""

CALENDAR_SCRIPT = r"""
tell application "Calendar"
    set out to ""
    set today to current date
    set s to today - (time of today)
    set e to s + 86399
    set targets to {"Official","Others","日历"}
    repeat with c in every calendar
        if name of c is in targets then
            try
                repeat with ev in (every event of c whose start date >= s and start date <= e)
                    try
                        set sD to start date of ev
                        set eD to end date of ev
                        set sY to year of sD as integer
                        set sM to (month of sD) as integer
                        set sDy to day of sD as integer
                        set sH to hours of sD as integer
                        set sMin to minutes of sD as integer
                        set eH to hours of eD as integer
                        set eMin to minutes of eD as integer
                        set ss to (sY as text)&"-"&text -2 thru -1 of("0"&sM)&"-"&text -2 thru -1 of("0"&sDy)&" "&text -2 thru -1 of("0"&sH)&":"&text -2 thru -1 of("0"&sMin)
                        set es to text -2 thru -1 of("0"&eH)&":"&text -2 thru -1 of("0"&eMin)
                        set out to out&(summary of ev)&"|||"&ss&"|||"&es&"|||"&(name of c)&"\n"
                    end try
                end repeat
            end try
        end if
    end repeat
    return out
end tell
"""

COLORS = {"Official":"sky","Others":"purple","日历":"mint"}

def get_reminders():
    out,_ = run_applescript(REMINDERS_SCRIPT)
    items = []
    for line in out.splitlines():
        line = line.strip()
        if not line: continue
        p = line.split("|||")
        items.append({"name":p[0],"dueTime":p[1] if len(p)>1 else "","list":p[2] if len(p)>2 else ""})
    return items

def get_calendar():
    out,_ = run_applescript(CALENDAR_SCRIPT)
    items = []
    for line in out.splitlines():
        line = line.strip()
        if not line: continue
        p = line.split("|||")
        cal = p[3] if len(p)>3 else ""
        items.append({"title":p[0],"startTime":p[1] if len(p)>1 else "","endTime":p[2] if len(p)>2 else "","calendar":cal,"color":COLORS.get(cal,"orange")})
    items.sort(key=lambda x: x["startTime"])
    return items

# ── TLG Inbox importer ────────────────────────────────────
# Reminder title format:
# FOCUS|YYYY-MM-DD|HH:MM|HH:MM|Project|Subproject|Topic
TLG_INBOX_SCRIPT = r'''
tell application "Reminders"
    if not (exists list "TLG Inbox") then return ""
    set out to ""
    repeat with r in (reminders of list "TLG Inbox" whose completed is false)
        try
            set out to out & (id of r) & "|||" & (name of r) & linefeed
        end try
    end repeat
    return out
end tell
'''

def applescript_string(value):
    return str(value).replace('\\', '\\\\').replace('"', '\\"')

def get_tlg_inbox_reminders():
    out, err = run_applescript(TLG_INBOX_SCRIPT)
    if err:
        raise RuntimeError(err)
    items = []
    for line in out.splitlines():
        if '|||' not in line:
            continue
        reminder_id, title = line.split('|||', 1)
        items.append({'id': reminder_id.strip(), 'title': title.strip()})
    return items

def complete_tlg_inbox_reminder(reminder_id):
    rid = applescript_string(reminder_id)
    script = f'''
tell application "Reminders"
    if not (exists list "{INBOX_LIST}") then return
    set matches to (reminders of list "{INBOX_LIST}" whose id is "{rid}")
    if (count of matches) > 0 then set completed of item 1 of matches to true
end tell
'''
    _, err = run_applescript(script)
    if err:
        raise RuntimeError(err)

def build_tlg_config(data):
    archived = set(data.get('archivedProjects') or [])
    subprojects = data.get('subprojects') or {}
    projects = {}
    for project in data.get('projects') or []:
        if project and project not in archived:
            projects[project] = list(subprojects.get(project) or [])
    return {
        'version': 1,
        'updatedAt': datetime.datetime.now().isoformat(timespec='seconds'),
        'projects': projects,
    }

def sync_tlg_config(data):
    """Publish the current TLG project hierarchy to one iCloud reminder."""
    config = json.dumps(build_tlg_config(data), ensure_ascii=False,
                        separators=(',', ':'))
    config_text = applescript_string(config)
    script = f'''
tell application "Reminders"
    if not (exists list "{INBOX_LIST}") then error "TLG Inbox list not found"
    set targetList to list "{INBOX_LIST}"
    set matches to (reminders of targetList whose name is "TLG_CONFIG" and completed is false)
    if (count of matches) is 0 then
        set configReminder to make new reminder at end of targetList with properties {{name:"TLG_CONFIG", body:"{config_text}"}}
    else
        set configReminder to item 1 of matches
        set body of configReminder to "{config_text}"
    end if
    return id of configReminder
end tell
'''
    reminder_id, err = run_applescript(script)
    if err:
        raise RuntimeError(err)
    return reminder_id

def parse_focus_reminder(title, data, reminder_id):
    parts = [x.strip() for x in title.replace('\n', ' ').split('|', 6)]
    if len(parts) != 7 or parts[0].upper() != 'FOCUS':
        raise ValueError('格式应为 FOCUS|日期|开始|结束|Project|Subproject|Topic')
    _, date_str, start_str, end_str, project, subproject, topic = parts
    try:
        start = datetime.datetime.strptime(date_str + ' ' + start_str, '%Y-%m-%d %H:%M')
        end = datetime.datetime.strptime(date_str + ' ' + end_str, '%Y-%m-%d %H:%M')
    except ValueError:
        raise ValueError('日期或时间格式无效；请使用 YYYY-MM-DD 和 HH:MM')
    if end <= start:
        raise ValueError('结束时间必须晚于开始时间')
    duration = int((end - start).total_seconds() // 60)
    if duration < 1 or duration > 720:
        raise ValueError('专注时长必须在 1 分钟到 12 小时之间')
    if not project:
        raise ValueError('Project 不能为空')
    if project not in (data.get('projects') or []):
        raise ValueError('未知 Project：' + project)
    known_subprojects = (data.get('subprojects') or {}).get(project, [])
    if subproject and known_subprojects and subproject not in known_subprojects:
        raise ValueError('未知 Subproject：' + subproject)
    if not topic:
        raise ValueError('Topic 不能为空')

    start_ms = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)
    for existing in data.get('focusSessions') or []:
        existing_start = existing.get('startTimestamp')
        existing_end = existing.get('endTimestamp')
        if existing_start is None or existing_end is None:
            continue
        if start_ms < existing_end and end_ms > existing_start:
            label = existing.get('topic') or 'Deep work'
            raise ValueError('与已有记录重叠：' + label)

    return {
        'startTimestamp': start_ms,
        'endTimestamp': end_ms,
        'durationMinutes': duration,
        'dateStr': date_str,
        'topic': topic,
        'project': project,
        'subproject': subproject,
        'startTimeStr': date_str + ' ' + start_str,
        'source': 'tlg-inbox',
        'sourceId': reminder_id,
    }

def import_tlg_inbox():
    global INBOX_STATUS
    result = {'lastRun': datetime.datetime.now().isoformat(timespec='seconds'),
              'configSynced': False, 'imported': [], 'errors': []}
    try:
        config_data = load_data()
        if config_data is None:
            raise RuntimeError('data.json 不存在')
        sync_tlg_config(config_data)
        result['configSynced'] = True
        reminders = get_tlg_inbox_reminders()
        with DATA_LOCK:
            data = load_data()
            if data is None:
                raise RuntimeError('data.json 不存在')
            imports = data.setdefault('inboxImports', [])
            imported_ids = {x.get('reminderId') for x in imports}
            to_complete = []
            changed = False
            for item in reminders:
                rid, title = item['id'], item['title']
                if title == 'TLG_CONFIG':
                    continue
                if rid in imported_ids:
                    to_complete.append(rid)
                    continue
                try:
                    session = parse_focus_reminder(title, data, rid)
                    data.setdefault('focusSessions', []).append(session)
                    imports.append({
                        'reminderId': rid,
                        'importedAt': result['lastRun'],
                        'type': 'focus',
                        'title': title,
                    })
                    imported_ids.add(rid)
                    to_complete.append(rid)
                    result['imported'].append({
                        'topic': session['topic'],
                        'date': session['dateStr'],
                        'durationMinutes': session['durationMinutes'],
                    })
                    changed = True
                except Exception as exc:
                    result['errors'].append({'title': title, 'error': str(exc)})
            if changed:
                data['inboxImports'] = imports[-500:]
                save_data_atomic(data, backup=True)
        for rid in to_complete:
            try:
                complete_tlg_inbox_reminder(rid)
            except Exception as exc:
                result['errors'].append({'title': rid, 'error': '已写入，但无法标记提醒事项为完成：' + str(exc)})
    except Exception as exc:
        result['errors'].append({'title': INBOX_LIST, 'error': str(exc)})
    INBOX_STATUS = result
    return result

def inbox_poll_loop():
    time.sleep(3)
    while True:
        import_tlg_inbox()
        time.sleep(INBOX_POLL_SECONDS)

def merge_server_managed_data(incoming, current):
    """Prevent a stale dashboard save from erasing inbox-imported sessions."""
    if not isinstance(incoming, dict) or not isinstance(current, dict):
        return incoming
    sessions = incoming.setdefault('focusSessions', [])
    source_ids = {s.get('sourceId') for s in sessions if s.get('sourceId')}
    for session in current.get('focusSessions') or []:
        sid = session.get('sourceId')
        if sid and sid not in source_ids:
            sessions.append(session)
            source_ids.add(sid)
    imports_by_id = {x.get('reminderId'): x for x in current.get('inboxImports') or []}
    for item in incoming.get('inboxImports') or []:
        if item.get('reminderId'):
            imports_by_id[item['reminderId']] = item
    incoming['inboxImports'] = list(imports_by_id.values())[-500:]
    return incoming


# ── Unfinished-session macOS notifications ─────────────────
# Read-only monitor: never ends timers or changes data.json.
# The browser controls the opt-in flag in D.reminderSettings.enabled.
ALERT_POLL_SECONDS = 60
ALERT_REPEAT_MS = 30 * 60 * 1000
FOCUS_ALERT_AFTER_MS = 120 * 60 * 1000
ALERT_MAX_AGE_MS = 36 * 60 * 60 * 1000
ALERT_LAST_SENT = {}  # in-memory only; avoids adding private alert metadata to data.json


def alert_int_ms(value):
    if isinstance(value, bool):
        return None
    try:
        result = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if result > 0 else None


def alert_candidates(data, now_ms=None):
    """Return eligible reminders, excluding stale historical open intervals."""
    if not isinstance(data, dict):
        return []
    settings = data.get('reminderSettings') or {}
    if not isinstance(settings, dict) or settings.get('enabled') is not True:
        return []
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    now = datetime.datetime.fromtimestamp(now_ms / 1000)
    results = []

    active = data.get('activeFocus') or {}
    if isinstance(active, dict):
        started = alert_int_ms(active.get('startTimestamp'))
        if started and FOCUS_ALERT_AFTER_MS <= now_ms - started <= ALERT_MAX_AGE_MS:
            results.append({
                'type': 'focus', 'id': str(started),
                'title': 'The Long Game · Focus Timer',
                'body': "Still focusing? End your timer if you're done."
            })

    checkout_time = settings.get('checkoutTime') or '18:00'
    try:
        checkout_hour, checkout_minute = map(int, checkout_time.split(':'))
        if not (0 <= checkout_hour <= 23 and 0 <= checkout_minute <= 59):
            raise ValueError('Invalid checkout time')
    except (ValueError, TypeError, AttributeError):
        checkout_hour, checkout_minute = 18, 0

    open_intervals = []
    records = data.get('clockRecords') or {}
    if isinstance(records, dict):
        # Today and yesterday only: old forgotten check-outs should not spam.
        for offset in (0, 1):
            day = now.date() - datetime.timedelta(days=offset)
            ds = day.isoformat()
            day_record = records.get(ds) or {}
            if not isinstance(day_record, dict):
                continue
            cutoff_dt = datetime.datetime.combine(
                day, datetime.time(checkout_hour, checkout_minute))
            cutoff_ms = int(cutoff_dt.timestamp() * 1000)
            for key in ('morning', 'afternoon', 'evening'):
                rec = day_record.get(key) or {}
                if not isinstance(rec, dict):
                    continue
                segments = rec.get('segments')
                if not isinstance(segments, list) or not segments:
                    segments = [rec] if rec.get('inTs') else []
                for segment in segments:
                    if not isinstance(segment, dict) or segment.get('outTs'):
                        continue
                    started = alert_int_ms(segment.get('inTs'))
                    if not started or not (0 <= now_ms - started <= ALERT_MAX_AGE_MS):
                        continue
                    # An evening check-in after the configured check-out time
                    # should not trigger a notification just one minute later.
                    due_ms = (started + FOCUS_ALERT_AFTER_MS
                              if started > cutoff_ms
                              else max(cutoff_ms, started + 60 * 1000))
                    if now_ms >= due_ms:
                        open_intervals.append((started, ds, key))
    if open_intervals:
        # Use the most recently started open interval, not an older open segment.
        started, ds, key = max(open_intervals)
        results.append({
            'type': 'office', 'id': f'{ds}|{key}|{started}',
            'title': 'The Long Game · Office Hours',
            'body': "Still checked in? Check out if you've left."
        })
    return results


def mac_alert(title, body):
    """Use macOS's notification center (no browser window required)."""
    script = 'display notification ' + applescript_string_literal(body) +              ' with title ' + applescript_string_literal(title)
    proc = subprocess.run(
        ['osascript', '-e', script], text=True, capture_output=True, timeout=15)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or 'osascript failed').strip())


def applescript_string_literal(value):
    return '"' + applescript_string(value).replace('\r', ' ').replace('\n', ' ') + '"'


def alert_check_once(data, now_ms=None, last_sent=None, sender=None):
    """Check a snapshot. Optional clock/sender make behavior testable without macOS."""
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    if last_sent is None:
        last_sent = ALERT_LAST_SENT
    if sender is None:
        sender = mac_alert
    candidates = alert_candidates(data, now_ms)
    active_types = {item['type'] for item in candidates}
    for old_type in list(last_sent):
        if old_type not in active_types:
            del last_sent[old_type]
    delivered = []
    for item in candidates:
        prior = last_sent.get(item['type']) or {}
        if (prior.get('id') == item['id'] and
                now_ms - prior.get('at', 0) < ALERT_REPEAT_MS):
            continue
        sender(item['title'], item['body'])
        last_sent[item['type']] = {'id': item['id'], 'at': now_ms}
        delivered.append(item['type'])
    return delivered


def alert_poll_loop():
    # Startup is intentionally delayed; the browser may still be loading data.
    time.sleep(3)
    while True:
        try:
            alert_check_once(load_data())
        except Exception as exc:
            print('[TLG alerts] ' + str(exc), file=sys.stderr, flush=True)
        time.sleep(ALERT_POLL_SECONDS)

# ── HTTP Handler ───────────────────────────────────────────
class Handler(http.server.BaseHTTPRequestHandler):
    def _allowed_origin(self):
        origin = self.headers.get('Origin', '')
        allowed = {
            f'http://localhost:{PORT}', f'http://127.0.0.1:{PORT}',
            'http://localhost', 'http://127.0.0.1'
        }
        return origin if origin in allowed else None

    def _json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        origin = self._allowed_origin()
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods','GET,POST,OPTIONS')
        self.send_header('Access-Control-Allow-Headers','Content-Type')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _html(self, filename):
        path = os.path.join(SCRIPT_DIR, filename)
        if not os.path.exists(path):
            self.send_response(404); self.end_headers()
            self.wfile.write(b'File not found'); return
        with open(path,'rb') as f: body = f.read()
        self.send_response(200)
        self.send_header('Content-Type','text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _static(self, relative_path):
        path = os.path.realpath(os.path.join(SCRIPT_DIR, relative_path))
        root = os.path.realpath(SCRIPT_DIR) + os.sep
        if not path.startswith(root) or not os.path.isfile(path):
            self._json({'success':False,'error':'Not found'},404); return
        with open(path, 'rb') as f: body = f.read()
        content_type = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        if path.endswith('.webmanifest'): content_type = 'application/manifest+json'
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if self._allowed_origin(): self._json({})
        else: self._json({'success':False,'error':'Origin not allowed'},403)

    def do_GET(self):
        path = self.path.split('?')[0]

        if path in ('/', '/dashboard', '/phd_dashboard.html'):
            self._html('phd_dashboard.html')

        elif unquote(path) in STATIC_FILES:
            self._static(STATIC_FILES[unquote(path)])

        elif path == '/api/ping':
            self._json({'success':True,'message':'The Long Game Bridge is running'})

        elif path == '/api/alerts/status':
            self._json({'success':True,'backgroundNotifications':True})

        # ── Data persistence ──
        elif path == '/api/data':
            try:
                self._json({'success':True,'data':load_data()})
            except Exception:
                self._json({'success':False,'error':'Corrupt data file'},500)

        elif path == '/api/tlg-inbox/status':
            self._json({'success':True,'data':INBOX_STATUS,'format':'FOCUS|YYYY-MM-DD|HH:MM|HH:MM|Project|Subproject|Topic'})

        # ── Apple sync ──
        elif path == '/api/reminders':
            try: self._json({'success':True,'data':get_reminders()})
            except Exception as e: self._json({'success':False,'error':str(e)},500)

        elif path == '/api/calendar':
            try: self._json({'success':True,'data':get_calendar()})
            except Exception as e: self._json({'success':False,'error':str(e)},500)

        elif path == '/api/all':
            try: self._json({'success':True,'reminders':get_reminders(),'calendar':get_calendar()})
            except Exception as e: self._json({'success':False,'error':str(e)},500)

        else:
            self._json({'success':False,'error':'Not found'},404)

    def do_POST(self):
        path = self.path.split('?')[0]

        if path == '/api/data':
            length = int(self.headers.get('Content-Length',0))
            if length <= 0 or length > MAX_DATA_BYTES:
                self._json({'success':False,'error':'Invalid data size'},413); return
            body = self.rfile.read(length)
            try:
                data = json.loads(body.decode('utf-8'))
                if not isinstance(data, dict):
                    raise ValueError('Dashboard data must be a JSON object')
                with DATA_LOCK:
                    current = load_data() or {}
                    data = merge_server_managed_data(data, current)
                    save_data_atomic(data)
                self._json({'success':True})
            except Exception as e:
                self._json({'success':False,'error':str(e)},500)
        elif path == '/api/tlg-inbox/import':
            self._json({'success':True,'data':import_tlg_inbox()})
        else:
            self._json({'success':False,'error':'Not found'},404)

    def log_message(self, fmt, *args): pass

class Server(http.server.HTTPServer):
    allow_reuse_address = True

if __name__ == '__main__':
    if sys.platform != 'darwin':
        print('Requires macOS.'); sys.exit(1)
    print(f"""
╔══════════════════════════════════════════════════╗
║   The Long Game · Bridge Server · Port {PORT}      ║
║                                                  ║
║   Open:  http://localhost:{PORT}                   ║
║   Data:  {DATA_FILE[:44]}  ║
╚══════════════════════════════════════════════════╝
Press Ctrl+C to stop.
""")
    if os.environ.get('TLG_DISABLE_BACKGROUND') != '1':
        threading.Thread(target=inbox_poll_loop, daemon=True).start()
        threading.Thread(target=alert_poll_loop, daemon=True).start()
    Server(('localhost', PORT), Handler).serve_forever()
