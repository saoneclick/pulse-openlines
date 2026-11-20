"""Настройки платформы ПУЛЬС."""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
UI_DIR = BASE_DIR / "app" / "ui"
DATA_DIR.mkdir(exist_ok=True)

try:  # .env рядом с проектом; в production переменные задаёт окружение
    from dotenv import load_dotenv

    load_dotenv(BASE_DIR / ".env")
except Exception:  # noqa: BLE001
    pass


class Settings:
    app_name = "ПУЛЬС"
    app_sub = "AI-контроль открытых линий"
    version = "1.0.0"

    company = os.getenv("COMPANY_NAME", "Бухгалтерия «Основа»")
    owner = os.getenv("OWNER_NAME", "Сергей Иванов")
    owner_role = os.getenv("OWNER_ROLE", "Собственник")

    database_url = os.getenv(
        "DATABASE_URL", f"sqlite:///{(DATA_DIR / 'pulse.db').as_posix()}"
    )
    demo = os.getenv("DEMO_MODE", "1") == "1"
    admin_password = os.getenv("ADMIN_PASSWORD", "pulse")

    # Bitrix24 (заполняется при подключении портала)
    b24_domain = os.getenv("BITRIX24_DOMAIN", "buh-osnova.bitrix24.ru")
    b24_webhook = os.getenv("BITRIX24_WEBHOOK", "")
    b24_bot_id = os.getenv("BITRIX24_BOT_ID", "")
    b24_lines = os.getenv("BITRIX24_LINES", "Бухгалтерия, Налоги, Зарплата и кадры")

    timezone = os.getenv("TZ_NAME", "Asia/Yekaterinburg")

    # Пороги контроля (минуты)
    first_response_warn = int(os.getenv("FIRST_RESPONSE_WARN", "30"))
    first_response_critical = int(os.getenv("FIRST_RESPONSE_CRITICAL", "240"))
    waiting_warn = int(os.getenv("WAITING_WARN", "60"))
    waiting_critical = int(os.getenv("WAITING_CRITICAL", "240"))


settings = Settings()
