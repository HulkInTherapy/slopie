#!/usr/bin/env python3
"""Drive the real `slopie audit` TUI in a pty against a fixture recording and save raw ANSI
captures (one .ansi per moment, each the full stream up to then, so a replay shows that screen).

  drive.py <fixture.json> <kinds.json> <out-dir> [cols rows]
"""
import fcntl, json, os, pty, select, signal, struct, sys, tempfile, termios, threading, time

fixture, kinds_file, out = sys.argv[1], sys.argv[2], sys.argv[3]
cols, rows = (int(sys.argv[4]), int(sys.argv[5])) if len(sys.argv) > 5 else (120, 40)
kinds = json.load(open(kinds_file))
repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
history = tempfile.mkdtemp(prefix='slopie-cap-history-')
os.makedirs(out, exist_ok=True)

def run(tag, steps, size=(cols, rows)):
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ, SLOPIE_AUDIT_FIXTURE=fixture, COLORTERM='truecolor', TERM='xterm-256color',
                   SLOPIE_AUDIT_HISTORY_DIR=history, FORCE_COLOR='1')
        os.execvpe('node', ['node', os.path.join(repo, 'packages/cli/bin/slopie.js'), 'audit'], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', size[1], size[0], 0, 0))
    buf = bytearray()
    stop = threading.Event()
    def reader():
        while not stop.is_set():
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try: data = os.read(fd, 65536)
                except OSError: break
                if not data: break
                buf.extend(data)
    th = threading.Thread(target=reader, daemon=True); th.start()
    for step in steps:
        kind = step[0]
        if kind == 'wait': time.sleep(step[1])
        elif kind == 'key': os.write(fd, step[1].encode()); time.sleep(step[2] if len(step) > 2 else 0.15)
        elif kind == 'resize':
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', step[2], step[1], 0, 0)); os.kill(pid, signal.SIGWINCH); time.sleep(0.6)
        elif kind == 'snap':
            name = f'{tag}-{step[1]}'
            open(os.path.join(out, name + '.ansi'), 'wb').write(bytes(buf))
            print(name, step[2] if len(step) > 2 else f'{cols}x{rows}', flush=True)
    os.write(fd, b'q'); time.sleep(0.5)
    stop.set()
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    os.waitpid(pid, 0)

idx = {k: i for i, k in enumerate(kinds)}
R = '\x1b[C'
first = [('wait', 0.5), ('snap', '00-loading'), ('wait', 2.0), ('snap', '00-loading-done'), ('wait', 3.0), ('snap', '01-teaser'),
         ('key', R, 2.2), ('snap', '02-cold-open'), ('key', R, 2.2), ('snap', '03-scale'), ('key', R, 2.5), ('snap', '04-spend')]
first += [('key', R, 0.15)] * (idx['guess'] - idx['bill'] - 1) + [('key', R, 1.6), ('snap', '05-quiz'), ('key', '1', 2.0), ('snap', '06-quiz-answer'),
          ('key', R, 2.2), ('snap', '07-model-lineup'), ('key', R, 2.6), ('snap', '08-the-turn')]
first += [('key', R, 0.15)] * (idx['archetype'] - idx['mood'] - 1)
first += [('key', R, 0.0)]
t = 0.0
for at, name in [(0.35, 'a'), (1.0, 'b'), (1.5, 'c'), (2.0, 'd'), (2.25, 'e'), (2.6, 'f'), (3.0, 'g'), (4.2, 'h')]:
    first += [('wait', at - t), ('snap', f'09-reveal-{name}')]; t = at
first += [('key', R, 2.5), ('snap', '10-awards'), ('key', R, 2.2), ('snap', '11-board'),
          ('resize', 100, 30), ('snap', '12-board-100x30', '100x30'), ('resize', 80, 24), ('snap', '13-board-80x24', '80x24'), ('resize', cols, rows)]
run('run1', first)
# Re-run: history exists, so the TUI opens on the board with the ticker.
run('run2', [('wait', 4.5), ('snap', '14-rerun-board'), ('key', '\x1b[D', 2.5), ('snap', '15-replay-teaser')])
print('history', history)
