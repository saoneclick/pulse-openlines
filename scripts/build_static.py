"""Собирает статическую демо-версию ПУЛЬСа для Netlify.

Результат — папка dist/: index.html, assets/, favicon.svg, state-*.json,
pulse-owner.pdf. Сервер не нужен: SPA читает заранее собранный срез.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

from app.api import state  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.seed import seed  # noqa: E402

DIST = BASE / "dist"
UI = BASE / "app" / "ui"


def main() -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / "assets").mkdir(parents=True)

    init_db()
    seed()
    db = SessionLocal()
    try:
        for period in (7, 14, 30):
            data = state(period, db)
            (DIST / f"state-{period}.json").write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
    finally:
        db.close()

    shutil.copy2(UI / "index.html", DIST / "index.html")
    shutil.copy2(UI / "app.css", DIST / "assets" / "app.css")
    shutil.copy2(UI / "app.js", DIST / "assets" / "app.js")
    shutil.copy2(UI / "favicon.svg", DIST / "favicon.svg")
    shutil.copytree(UI / "fonts", DIST / "assets" / "fonts", dirs_exist_ok=True)

    pdf = BASE / "docs" / "pulse-owner.pdf"
    if pdf.exists():
        shutil.copy2(pdf, DIST / "pulse-owner.pdf")

    (DIST / "robots.txt").write_text("User-agent: *\nAllow: /\n", encoding="utf-8")

    html = (DIST / "index.html").read_text(encoding="utf-8")
    inline = (
        "<script>"
        "window.PULSE_STATIC = true;"
        'window.PULSE_GITHUB = "https://github.com/saoneclick/pulse-openlines";'
        "</script>\n"
    )
    html = html.replace('<script src="/assets/app.js', inline + '<script src="/assets/app.js', 1)
    (DIST / "index.html").write_text(html, encoding="utf-8")

    total = sum(p.stat().st_size for p in DIST.rglob("*") if p.is_file())
    print(f"dist готов: {len(list(DIST.rglob('*')))} файлов, {total / 1024:.0f} КБ")


if __name__ == "__main__":
    main()
