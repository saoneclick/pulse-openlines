"""Собирает PDF «ПУЛЬС — для собственника» из docs/owner-brief.html."""
from __future__ import annotations

from pathlib import Path
from shutil import copyfile

from playwright.sync_api import sync_playwright

BASE = Path(__file__).resolve().parent.parent
SOURCE = BASE / "docs" / "owner-brief.html"
TARGET = BASE / "docs" / "ПУЛЬС — как работает бот (для собственника).pdf"
ALIAS = BASE / "docs" / "pulse-owner.pdf"


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1240, "height": 1754})
        page.goto(SOURCE.as_uri(), wait_until="networkidle")
        page.emulate_media(media="print")
        page.pdf(
            path=str(TARGET),
            format="A4",
            print_background=True,
            margin={"top": "0", "right": "0", "bottom": "0", "left": "0"},
            prefer_css_page_size=True,
        )
        browser.close()
    copyfile(TARGET, ALIAS)
    print(f"PDF: {ALIAS} ({ALIAS.stat().st_size / 1024:.0f} КБ)")


if __name__ == "__main__":
    main()
