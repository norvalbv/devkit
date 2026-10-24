#!/bin/sh
# The box's init: one desktop (Xvfb :1, xfce), its live view (noVNC on 6080), Chromium with CDP
# (published on 9223), and the slot's port block forwarded to the host so URLs match light mode.
set -eu
Xvfb :1 -screen 0 1280x800x24 -nolisten tcp &
until xdpyinfo >/dev/null 2>&1; do sleep 0.1; done
dbus-launch --exit-with-session startxfce4 >/tmp/xfce.log 2>&1 &
# Chromium waits for the window manager and panel (at most 20 s), or its window lands unmanaged.
for _ in $(seq 200); do
  xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id' &&
    xdotool search --class xfce4-panel >/dev/null 2>&1 && break
  sleep 0.1
done
x11vnc -storepasswd "$VNC_PASSWORD" /tmp/vncpass >/dev/null 2>&1
x11vnc -display :1 -forever -shared -rfbauth /tmp/vncpass -quiet -localhost -rfbport 5900 >/tmp/vnc.log 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 &
for port in $(seq "$PORT_BLOCK" $((PORT_BLOCK + 9))); do
  socat "TCP-LISTEN:$port,bind=127.0.0.1,fork,reuseaddr" "TCP:host.docker.internal:$port" &
done
chromium --no-sandbox --test-type --no-first-run --no-default-browser-check --disable-dev-shm-usage \
  --remote-debugging-port=9222 --user-data-dir=/home/agent/.chromium \
  --window-position=0,0 --window-size=1280,760 "${OPEN_URL:-about:blank}" >/tmp/chromium.log 2>&1 &
echo ready
exec sleep infinity
