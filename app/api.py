"""REST API платформы ПУЛЬС: срез, чаты, люди, обещания, отчёт, настройки."""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.analysis import SEVERITY_RANK, fmt_minutes
from app.config import settings
from app.db import get_session
from app.models import (
    ActionLog,
    Chat,
    Client,
    DailyMetric,
    Employee,
    Finding,
    Message,
    Promise,
    Setting,
    Task,
)
from app.seed import LAST7, PLAN, seed

router = APIRouter(prefix="/api")

MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"]

NOTE_LABELS = {
    "slow_first": ("Поздний первый ответ", "bad"),
    "client_waiting": ("Клиент ждёт", "bad"),
    "promise_overdue": ("Обещание просрочено", "bad"),
    "client_risk": ("Риск ухода", "bad"),
    "client_upset": ("Клиент нервничает", "bad"),
    "client_risk_soft": ("Боится штрафа", "bad"),
    "rude": ("Резкий тон", "bad"),
    "deadline_risk": ("Срок под угрозой", "bad"),
    "no_handoff": ("Нет передачи", "bad"),
    "repeat_question": ("Повторный вопрос", "bad"),
    "promise_kept": ("Обещание выполнено", "good"),
    "thanks": ("Благодарность", "good"),
    "proactive": ("Инициатива", "good"),
    "crisis_solved": ("Кризис закрыт", "good"),
    "escalation": ("Эскалация", "good"),
    "new_client": ("Новый клиент", "good"),
    "documents_done": ("Документы закрыты", "good"),
    "fast_reply": ("Быстрый ответ", "good"),
}

CODE_PRIORITY = {
    "client_risk": 100,
    "no_handoff": 95,
    "client_waiting": 90,
    "promise_overdue": 85,
    "rude": 80,
    "deadline_risk": 75,
    "slow_first": 70,
    "client_upset": 60,
    "client_risk_soft": 50,
    "repeat_question": 40,
}

RULES = [
    {"code": "first_response", "title": "Первый ответ дольше", "value": "30 минут", "critical": "2 часа", "weight": "высокий", "enabled": True},
    {"code": "waiting", "title": "Клиент ждёт ответа", "value": "1 час", "critical": "4 часа", "weight": "критичный", "enabled": True},
    {"code": "promise", "title": "Обещание не выполнено", "value": "к сроку", "critical": "просрочка", "weight": "критичный", "enabled": True},
    {"code": "words", "title": "Риск ухода в переписке", "value": "«другой бухгалтер», «уходим»", "critical": "сразу", "weight": "критичный", "enabled": True},
    {"code": "tone", "title": "Резкий тон сотрудника", "value": "упреки, обвинения", "critical": "повтор", "weight": "высокий", "enabled": True},
    {"code": "deadline", "title": "Срок отчётности под угрозой", "value": "за 5 дней", "critical": "за 1 день", "weight": "высокий", "enabled": True},
    {"code": "handoff", "title": "Нет передачи диалога", "value": "30 минут без ответа", "critical": "2 часа", "weight": "критичный", "enabled": True},
]


# ---------------------------------------------------------------- helpers
def iso(value: datetime | None) -> str | None:
    return value.isoformat(timespec="minutes") if value else None


def day_label(day) -> str:
    return f"{day.day} {MONTHS[day.month - 1][:3]}"


def plural(n: int, one: str, few: str, many: str) -> str:
    n = abs(int(n))
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def period_label(days: list) -> str:
    if not days:
        return ""
    first, last = days[0], days[-1]
    if first.month == last.month:
        return f"{first.day}–{last.day} {MONTHS[last.month - 1]} {last.year}"
    return f"{first.day} {MONTHS[first.month - 1]} – {last.day} {MONTHS[last.month - 1]} {last.year}"


def client_of(db: Session, chat: Chat) -> Client:
    return db.get(Client, chat.client_id)


def employee_of(db: Session, chat: Chat) -> Employee:
    return db.get(Employee, chat.employee_id)


def finding_out(f: Finding, chat: Chat, client: Client, employee: Employee) -> dict:
    return {
        "id": f.id,
        "code": f.code,
        "tone": f.tone,
        "severity": f.severity,
        "title": f.title,
        "detail": f.detail,
        "quote": f.quote,
        "recommendation": f.recommendation,
        "message_id": f.message_id,
        "chat_id": chat.id,
        "client": client.name,
        "client_kind": client.kind,
        "employee": employee.name,
        "employee_id": employee.id,
        "topic": chat.topic,
        "score": chat.score,
        "at": iso(chat.last_activity),
    }


def promise_out(p: Promise, chat: Chat, client: Client, employee: Employee) -> dict:
    overdue = 0
    if p.status == "overdue":
        overdue = max(0, int((datetime.now() - p.due_at).total_seconds() // 60))
    return {
        "id": p.id,
        "text": p.text,
        "status": p.status,
        "due_at": iso(p.due_at),
        "kept_at": iso(p.kept_at),
        "overdue_min": overdue,
        "chat_id": chat.id,
        "client": client.name,
        "client_kind": client.kind,
        "employee": employee.name,
        "employee_id": employee.id,
        "topic": chat.topic,
    }


def chat_out(db: Session, chat: Chat, with_messages: bool = True) -> dict:
    client = client_of(db, chat)
    employee = employee_of(db, chat)
    findings = (
        db.query(Finding)
        .filter(Finding.chat_id == chat.id)
        .order_by(Finding.tone.desc(), Finding.id)
        .all()
    )
    promises = db.query(Promise).filter(Promise.chat_id == chat.id).order_by(Promise.due_at).all()

    notes: dict[int, list] = {}
    for f in findings:
        if not f.message_id:
            continue
        label = NOTE_LABELS.get(f.code)
        if not label:
            continue
        bucket = notes.setdefault(f.message_id, [])
        if len(bucket) < 2 and all(item["text"] != label[0] for item in bucket):
            bucket.append({"text": label[0], "tone": label[1], "kind": "finding"})
    for p in promises:
        if p.status == "overdue" and p.source_message_id:
            bucket = notes.setdefault(p.source_message_id, [])
            if len(bucket) < 2 and all(item["text"] != "Обещание просрочено" for item in bucket):
                bucket.append({"text": "Обещание просрочено", "tone": "bad", "kind": "promise"})

    data = {
        "id": chat.id,
        "external_id": chat.external_id,
        "client": client.name,
        "client_kind": client.kind,
        "industry": client.industry,
        "contact": client.contact,
        "contract_value": client.contract_value,
        "employee": employee.name,
        "employee_id": employee.id,
        "employee_role": employee.role,
        "initials": employee.initials,
        "line": chat.line,
        "topic": chat.topic,
        "tags": chat.tags or [],
        "status": chat.status,
        "score": chat.score,
        "verdict": chat.verdict,
        "summary": chat.summary,
        "risk_amount": chat.risk_amount,
        "first_response_min": chat.first_response_min,
        "avg_response_min": chat.avg_response_min,
        "waiting_min": chat.waiting_min,
        "opened_at": iso(chat.opened_at),
        "last_activity": iso(chat.last_activity),
        "findings": [finding_out(f, chat, client, employee) for f in findings],
        "promises": [promise_out(p, chat, client, employee) for p in promises],
    }
    if with_messages:
        messages = (
            db.query(Message).filter(Message.chat_id == chat.id).order_by(Message.created_at, Message.id).all()
        )
        data["messages"] = [
            {
                "id": m.id,
                "author": m.author,
                "author_name": m.author_name,
                "text": m.text,
                "at": iso(m.created_at),
                "internal": m.author == "system",
                "notes": notes.get(m.id, []),
            }
            for m in messages
        ]
    else:
        data["messages"] = []
    return data


def employee_cards(db: Session) -> list[dict]:
    employees = db.query(Employee).order_by(Employee.id).all()
    chats = db.query(Chat).all()
    findings = db.query(Finding).all()
    promises = db.query(Promise).all()
    cards = []

    for employee in employees:
        own = [c for c in chats if c.employee_id == employee.id]
        if not own:
            continue
        scores = [c.score for c in own]
        score = round(sum(scores) / len(scores))
        first = [c.first_response_min for c in own if c.first_response_min is not None]
        avg_first = round(sum(first) / len(first)) if first else None
        own_promises = [p for p in promises if p.employee_id == employee.id]
        resolved = [p for p in own_promises if p.status in ("kept", "overdue")]
        kept = [p for p in resolved if p.status == "kept"]
        kept_pct = round(len(kept) * 100 / len(resolved)) if resolved else None
        own_findings = [f for f in findings if f.employee_id == employee.id]
        good = sorted([f for f in own_findings if f.tone == "good"], key=lambda f: -SEVERITY_RANK[f.severity])
        bad = sorted([f for f in own_findings if f.tone == "bad"], key=lambda f: -SEVERITY_RANK[f.severity])
        strengths = []
        for f in good:
            if f.title not in [s["title"] for s in strengths]:
                strengths.append({"title": f.title, "quote": f.quote, "chat_id": f.chat_id})
            if len(strengths) == 2:
                break
        weaknesses = []
        for f in bad:
            if f.title not in [w["title"] for w in weaknesses]:
                weaknesses.append({"title": f.title, "quote": f.quote, "chat_id": f.chat_id})
            if len(weaknesses) == 2:
                break
        cards.append(
            {
                "id": employee.id,
                "name": employee.name,
                "role": employee.role,
                "initials": employee.initials,
                "since": employee.since,
                "score": score,
                "verdict": "ok" if score >= 85 else ("watch" if score >= 65 else "critical"),
                "chats": len(own),
                "critical": len([c for c in own if c.verdict == "critical"]),
                "avg_first_response_min": avg_first,
                "no_response": len([c for c in own if c.first_response_min is None]),
                "promises_kept_pct": kept_pct,
                "promises_kept": len(kept),
                "promises_total": len(resolved),
                "risk_amount": sum(c.risk_amount for c in own),
                "risk_chats": len([c for c in own if c.risk_amount > 0]),
                "strengths": strengths,
                "weaknesses": weaknesses,
                "chat_ids": [c.id for c in sorted(own, key=lambda c: c.last_activity, reverse=True)],
            }
        )
    return sorted(cards, key=lambda c: -c["score"])


def dedupe_findings(items: list[dict], limit: int) -> list[dict]:
    out, seen, per_chat = [], set(), {}
    for item in items:
        key = item["title"]
        if key in seen:
            continue
        if per_chat.get(item["chat_id"], 0) >= 2:
            continue
        seen.add(key)
        per_chat[item["chat_id"]] = per_chat.get(item["chat_id"], 0) + 1
        out.append(item)
        if len(out) >= limit:
            break
    return out


def build_report(chats: list[dict], people: list[dict], promises: list[dict], attention: list[dict], good: list[dict], bad: list[dict], pulse: int, money: float, days: list) -> dict:
    scope = period_label(days)
    resolved = [p for p in promises if p["status"] in ("kept", "overdue")]
    kept = [p for p in resolved if p["status"] == "kept"]
    kept_pct = round(len(kept) * 100 / len(resolved)) if resolved else 0
    firsts = [c["first_response_min"] for c in chats if c["first_response_min"] is not None]
    avg_first = round(sum(firsts) / len(firsts)) if firsts else 0

    money_str = f"{int(money):,}".replace(",", " ")
    lead = (
        f"За период {scope} под контролем {len(chats)} диалогов. "
        f"Требуют вмешательства: {len([c for c in chats if c['verdict'] == 'critical'])}. "
        f"Средний первый ответ — {avg_first} мин, обещания в срок — {kept_pct}%. "
        f"Под риском {money_str} ₽ выручки."
    )

    good_items = [
        {"text": f"{g['title']}: {g['client']} · {g['employee']}. {g['detail']}", "chat_id": g["chat_id"]}
        for g in good[:4]
    ]
    bad_items = [
        {"text": f"{b['title']}: {b['client']} · {b['employee']}. {b['detail']}", "chat_id": b["chat_id"]}
        for b in bad[:5]
    ]
    money_items = [
        {"text": f"{a['client']}: под угрозой {int(a['risk_amount']):,} ₽. {a['reason']}".replace(",", " "), "chat_id": a["chat_id"]}
        for a in attention
        if a["risk_amount"] > 0
    ] or [{"text": "Клиентов с явным риском потери выручки не выявлено.", "chat_id": None}]
    people_items = [
        {
            "text": f"{p['name']} — {p['score']} баллов, {p['chats']} чатов, первый ответ {p['avg_first_response_min'] or '—'} мин"
            + (f", обещания {p['promises_kept_pct']}%" if p["promises_kept_pct"] is not None else "")
            + f". Сильное: {p['strengths'][0]['title'].lower() if p['strengths'] else '—'}; зона роста: {p['weaknesses'][0]['title'].lower() if p['weaknesses'] else '—'}.",
            "chat_id": None,
        }
        for p in people
    ]
    plan_items = [{"text": f"{p['title']}. {p['detail']}", "chat_id": p["chat_id"]} for p in PLAN]

    conclusion = (
        "Команда быстро отвечает на простые вопросы и хорошо закрывает кризисы, но дисциплина обещаний "
        "и контроль ожидания проседают. Точка роста недели — «Альфа-Строй»: клиент уже говорит об уходе. "
        "Нужен личный звонок собственника и публичный план по сверке."
    )

    sections = [
        {"title": "Что хорошо", "tone": "good", "items": good_items},
        {"title": "Что плохо", "tone": "bad", "items": bad_items},
        {"title": "Деньги", "tone": "bad", "items": money_items},
        {"title": "Люди", "tone": "neutral", "items": people_items},
        {"title": "План на неделю", "tone": "neutral", "items": plan_items},
    ]

    md = [
        f"# {settings.app_name}. Отчёт по открытым линиям",
        f"**Период:** {scope}  ",
        f"**Оценка недели:** {pulse}/100  ",
        f"**Подготовлено:** {datetime.now().strftime('%d.%m.%Y %H:%M')}",
        "",
        lead,
        "",
    ]
    for section in sections:
        md.append(f"## {section['title']}")
        for item in section["items"]:
            md.append(f"- {item['text']}")
        md.append("")
    md += ["## Вывод", conclusion, "", "---", "Подготовлено платформой ПУЛЬС. Демонстрационные данные."]

    return {
        "title": "Отчёт по открытым линиям",
        "company": settings.company,
        "period": scope,
        "generated_at": iso(datetime.now()),
        "score": pulse,
        "lead": lead,
        "sections": sections,
        "conclusion": conclusion,
        "markdown": "\n".join(md),
    }


# ---------------------------------------------------------------- state
@router.get("/state")
def state(period: int = Query(7, ge=7, le=30), db: Session = Depends(get_session)) -> dict:
    chats_db = db.query(Chat).order_by(Chat.last_activity.desc()).all()
    chat_items = [chat_out(db, c) for c in chats_db]
    people = employee_cards(db)
    promises = []
    for p in db.query(Promise).order_by(Promise.due_at).all():
        chat = db.get(Chat, p.chat_id)
        promises.append(promise_out(p, chat, client_of(db, chat), employee_of(db, chat)))

    active = [c for c in chat_items if c["status"] == "active"]
    critical = [c for c in active if c["verdict"] == "critical"]
    watch = [c for c in active if c["verdict"] == "watch"]
    ok = [c for c in active if c["verdict"] == "ok"]
    pulse = round(sum(c["score"] for c in active) / len(active)) if active else 0

    attention = sorted(critical + watch, key=lambda c: (c["verdict"] != "critical", c["score"]))
    attention_items = []
    for c in attention:
        bad = sorted(
            [f for f in c["findings"] if f["tone"] == "bad"],
            key=lambda f: (-SEVERITY_RANK[f["severity"]], -CODE_PRIORITY.get(f["code"], 0)),
        )
        reason = bad[0]["title"] if bad else "Требуется внимание"
        attention_items.append(
            {
                "chat_id": c["id"],
                "client": c["client"],
                "client_kind": c["client_kind"],
                "employee": c["employee"],
                "initials": c["initials"],
                "topic": c["topic"],
                "score": c["score"],
                "verdict": c["verdict"],
                "reason": reason,
                "waiting_min": c["waiting_min"],
                "risk_amount": c["risk_amount"],
                "last_activity": c["last_activity"],
            }
        )

    all_findings = []
    for c in active:
        all_findings.extend([f for f in c["findings"] if f["tone"] in ("good", "bad")])
    bad_sorted = sorted(
        [f for f in all_findings if f["tone"] == "bad"],
        key=lambda f: (-SEVERITY_RANK[f["severity"]], -CODE_PRIORITY.get(f["code"], 0), f["score"]),
    )
    good_sorted = sorted(
        [f for f in all_findings if f["tone"] == "good"],
        key=lambda f: (-SEVERITY_RANK[f["severity"]], -f["score"]),
    )
    good = dedupe_findings(good_sorted, 5)
    bad = dedupe_findings(bad_sorted, 5)

    resolved = [p for p in promises if p["status"] in ("kept", "overdue")]
    kept = [p for p in resolved if p["status"] == "kept"]
    kept_pct = round(len(kept) * 100 / len(resolved)) if resolved else 0
    firsts = [c["first_response_min"] for c in active if c["first_response_min"] is not None]
    avg_first = round(sum(firsts) / len(firsts)) if firsts else 0
    money = sum(c["risk_amount"] for c in active)
    risk_clients = len([c for c in active if c["risk_amount"] > 0])

    metrics = db.query(DailyMetric).order_by(DailyMetric.day).all()
    trend = [
        {
            "date": m.day.isoformat(),
            "label": day_label(m.day),
            "score": m.score,
            "critical": m.critical_count,
            "response": m.avg_response_min,
        }
        for m in metrics
    ][-period:]
    days = [m.day for m in metrics][-period:]

    delta = 0
    if len(trend) >= 7:
        delta = trend[-1]["score"] - trend[0]["score"]

    lead_chat = next((c for c in attention if c["risk_amount"] > 0), attention[0] if attention else None)
    caption = f"Требуют вмешательства: {len(critical)} из {len(active)} чатов."
    if lead_chat:
        caption += f" Главный риск — {lead_chat['client']}"
        if lead_chat["risk_amount"]:
            caption += f" ({int(lead_chat['risk_amount']):,} ₽/год)".replace(",", " ")
        caption += "."

    overview = {
        "pulse": {
            "score": pulse,
            "label": "В норме" if pulse >= 85 else ("Внимание" if pulse >= 65 else "Проблема"),
            "delta": delta,
            "caption": caption,
            "critical": len(critical),
            "watch": len(watch),
            "ok": len(ok),
        },
        "kpis": [
            {"key": "chats", "label": "Чатов под контролем", "value": len(active), "note": f"Сотрудников: {len(people)} · линий: 3", "tone": "neutral"},
            {"key": "attention", "label": "Требуют вмешательства", "value": len(critical), "note": f"Под наблюдением: {len(watch)}", "tone": "bad"},
            {"key": "response", "label": "Средний первый ответ", "value": avg_first, "unit": "мин", "note": "Норма — до 30 минут", "tone": "warn" if avg_first > 30 else "good"},
            {"key": "promises", "label": "Обещания в срок", "value": kept_pct, "unit": "%", "note": f"Закрыто в срок: {len(kept)} из {len(resolved)}", "tone": "warn" if kept_pct < 80 else "good"},
            {"key": "money", "label": "Выручка под риском", "value": int(money), "unit": "₽", "note": f"Клиентов с риском ухода: {risk_clients}", "tone": "bad"},
        ],
        "attention": attention_items,
        "good": good,
        "bad": bad,
        "plan": [
            {
                **p,
                "chat": next((c for c in chat_items if c["id"] == p["chat_id"]), None),
            }
            for p in PLAN
        ],
        "trend": trend,
        "team": people,
        "status_split": {"ok": len(ok), "watch": len(watch), "critical": len(critical)},
        "money_at_risk": money,
        "risk_clients": risk_clients,
        "digest": (
            f"Критичных чатов: {len(critical)}. Клиентов под риском: {risk_clients}. "
            f"Средний первый ответ — {avg_first} мин, обещания в срок — {kept_pct}%."
        ),
    }

    report = build_report(
        active, people, promises, attention_items, good, bad, pulse, money, days
    )

    presence = db.query(Setting).filter(Setting.key == "presence").first()
    notifications = db.query(Setting).filter(Setting.key == "notifications").first()
    rule_setting = db.query(Setting).filter(Setting.key == "rules").first()
    saved_rules = rule_setting.value if rule_setting and isinstance(rule_setting.value, dict) else {}
    rules_payload = [{**rule, "enabled": bool(saved_rules.get(rule["code"], rule["enabled"]))} for rule in RULES]
    settings_payload = {
        "bitrix": {
            "connected": bool(settings.b24_webhook) or settings.demo,
            "mode": "demo" if settings.demo else "live",
            "domain": settings.b24_domain,
            "bot": "ПУЛЬС · наблюдатель",
            "bot_id": settings.b24_bot_id or "не подключён",
            "lines": [x.strip() for x in settings.b24_lines.split(",") if x.strip()],
            "last_event": iso(datetime.now() - timedelta(minutes=2)),
            "webhook": bool(settings.b24_webhook),
        },
        "presence": presence.value if presence else {},
        "notifications": notifications.value if notifications else {},
        "rules": rules_payload,
        "access": [
            {"role": "Собственник", "scope": "Все линии, все сотрудники, суммы и риски"},
            {"role": "Руководитель отдела", "scope": "Свои линии, все чаты, без финансов клиентов"},
            {"role": "Бухгалтер", "scope": "Только свои чаты и подсказки ПУЛЬС"},
        ],
    }

    return {
        "meta": {
            "app": settings.app_name,
            "sub": settings.app_sub,
            "version": settings.version,
            "company": settings.company,
            "owner": settings.owner,
            "owner_role": settings.owner_role,
            "generated_at": iso(datetime.now()),
            "demo": settings.demo,
            "period": period,
        },
        "overview": overview,
        "chats": chat_items,
        "people": people,
        "promises": promises,
        "report": report,
        "settings": settings_payload,
    }


@router.get("/chats/{chat_id}")
def chat_detail(chat_id: int, db: Session = Depends(get_session)) -> dict:
    chat = db.get(Chat, chat_id)
    if not chat:
        raise HTTPException(404, "Чат не найден")
    return chat_out(db, chat)


# ---------------------------------------------------------------- actions
class NotifyIn(BaseModel):
    text: str


class TaskIn(BaseModel):
    title: str
    due_at: str | None = None


class SettingsIn(BaseModel):
    presence_mode: str = "observer"
    silent_in_client_chat: bool = True
    helper_to_employee: bool = True
    escalate_to_owner: bool = True
    daily_digest: bool = True
    weekly_report: bool = True
    instant_critical: bool = True
    rules: dict[str, bool] = Field(default_factory=dict)


@router.post("/chats/{chat_id}/notify")
def notify_employee(chat_id: int, payload: NotifyIn, db: Session = Depends(get_session)) -> dict:
    chat = db.get(Chat, chat_id)
    if not chat:
        raise HTTPException(404, "Чат не найден")
    db.add(ActionLog(chat_id=chat_id, kind="notify", payload={"text": payload.text, "to": chat.employee_id}))
    db.commit()
    employee = employee_of(db, chat)
    return {"ok": True, "message": f"Сообщение поставлено в очередь. Сотрудник: {employee.name} (демо)"}


@router.post("/chats/{chat_id}/task")
def create_task(chat_id: int, payload: TaskIn, db: Session = Depends(get_session)) -> dict:
    chat = db.get(Chat, chat_id)
    if not chat:
        raise HTTPException(404, "Чат не найден")
    due = None
    if payload.due_at:
        try:
            due = datetime.fromisoformat(payload.due_at)
        except ValueError:
            due = None
    task = Task(chat_id=chat_id, employee_id=chat.employee_id, title=payload.title, due_at=due)
    db.add(task)
    db.add(ActionLog(chat_id=chat_id, kind="task", payload={"title": payload.title}))
    db.commit()
    return {"ok": True, "task": {"id": task.id, "title": task.title, "due_at": iso(task.due_at)}}


@router.post("/settings")
def save_settings(payload: SettingsIn, db: Session = Depends(get_session)) -> dict:
    presence = db.query(Setting).filter(Setting.key == "presence").first()
    if not presence:
        presence = Setting(key="presence", value={})
        db.add(presence)
    presence.value = {
        "mode": payload.presence_mode,
        "silent_in_client_chat": payload.silent_in_client_chat,
        "helper_to_employee": payload.helper_to_employee,
        "escalate_to_owner": payload.escalate_to_owner,
    }
    notifications = db.query(Setting).filter(Setting.key == "notifications").first()
    if not notifications:
        notifications = Setting(key="notifications", value={})
        db.add(notifications)
    notifications.value = {
        "daily_digest": payload.daily_digest,
        "daily_time": "09:00",
        "weekly_report": payload.weekly_report,
        "weekly_day": "Пятница",
        "instant_critical": payload.instant_critical,
    }
    rule_setting = db.query(Setting).filter(Setting.key == "rules").first()
    if not rule_setting:
        rule_setting = Setting(key="rules", value={})
        db.add(rule_setting)
    rule_setting.value = payload.rules
    db.add(ActionLog(kind="settings", payload=payload.model_dump()))
    db.commit()
    return {"ok": True}


@router.post("/demo/reset")
def demo_reset() -> dict:
    seed(force=True)
    return {"ok": True}


@router.get("/health")
def health() -> dict:
    return {"ok": True, "app": settings.app_name, "version": settings.version}


@router.post("/webhook/bitrix24")
def bitrix_webhook(payload: dict, db: Session = Depends(get_session)) -> dict:
    """Заготовка приёма событий Битрикс24 (ONIMBOTV2MESSAGEADD, OnOpenLineMessageAdd)."""
    event = payload.get("event", "unknown")
    db.add(ActionLog(kind="bitrix.event", payload={"event": event, "keys": list(payload.keys())[:12]}))
    db.commit()
    return {"ok": True}
