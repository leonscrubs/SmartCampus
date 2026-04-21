#!/usr/bin/env python3
"""Run a local HTTP server to serve IndoorNav (React via CDN + Babel standalone).
Babel standalone requires HTTP (not file://) to load external .jsx files.

Usage:  python3 serve.py
Then open:  http://localhost:3000
"""
import http.server, socketserver, os, webbrowser, threading

PORT = 3000
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # suppress request logs

def open_browser():
    import time; time.sleep(0.5)
    webbrowser.open(f"http://localhost:{PORT}")

threading.Thread(target=open_browser, daemon=True).start()
print(f"IndoorNav running at  http://localhost:{PORT}")
print("Press Ctrl+C to stop.\n")
with socketserver.TCPServer(("", PORT), Handler) as httpd:
    httpd.serve_forever()
