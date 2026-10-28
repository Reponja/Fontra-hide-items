#!/usr/bin/env python3
"""Serve the plugin locally with the headers Fontra needs for module imports."""

from __future__ import annotations

import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class PluginRequestHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".json": "application/json",
    }

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8002)
    parser.add_argument(
        "--bind",
        default="127.0.0.1",
        help="address to listen on (default: 127.0.0.1)",
    )
    args = parser.parse_args()

    plugin_dir = str(Path(__file__).resolve().parent)
    handler = functools.partial(PluginRequestHandler, directory=plugin_dir)
    server = ThreadingHTTPServer((args.bind, args.port), handler)
    print(f"Serving {plugin_dir} at http://{args.bind}:{args.port}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
