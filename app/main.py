"""Точка входа ПУЛЬС: API, панель, приём событий Битрикс24."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api import router
from app.config import BASE_DIR, UI_DIR, settings
from app.db import init_db
from app.seed import seed

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("pulse")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    created = seed()
    log.info("Старт ПУЛЬС: demo=%s, база=%s%s", settings.demo, settings.database_url, " (демо создано)" if created else "")
    yield


app = FastAPI(title=f"{settings.app_name} · {settings.app_sub}", version=settings.version, docs_url="/api/docs", lifespan=lifespan)
app.include_router(router)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(UI_DIR / "index.html")


@app.get("/favicon.svg")
def favicon() -> FileResponse:
    return FileResponse(UI_DIR / "favicon.svg")


@app.post("/webhook/bitrix24")
async def bitrix24_webhook(request: Request) -> JSONResponse:
    """Единая точка приёма событий портала. В демо просто подтверждает приём."""
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    log.info("Bitrix24 event: %s", payload.get("event", "unknown"))
    return JSONResponse({"ok": True})


app.mount("/assets", StaticFiles(directory=UI_DIR), name="assets")
app.mount("/docs", StaticFiles(directory=BASE_DIR / "docs"), name="docs")
