"""Движок разбора переписки.

В демо-версии разбор детерминированный: время ответа и ожидания считаются
по сообщениям, смысловые события (обещания, риск ухода, тон) размечены в
демо-базе. В боевом контуре те же события извлекает LLM по той же таксономии
(см. docs/04-МЕТОДИКА-ОЦЕНКИ.md).
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from app.config import settings
from app.models import Chat, Finding, Message, Promise

SEVERITY_PENALTY = {"low": 3, "medium": 7, "high": 12, "critical": 20}
SEVERITY_REWARD = {"low": 1, "medium": 3, "high": 5, "critical": 6}
SEVERITY_RANK = {"critical": 4, "high": 3, "medium": 2, "low": 1}

FLAGS: dict[str, dict] = {
    "client_risk": {
        "tone": "bad",
        "severity": "critical",
        "title": "Клиент говорит об уходе",
        "detail": "В переписке прозвучала угроза перейти к другому бухгалтеру.",
        "recommendation": "Позвонить лично сегодня, предложить встречу с руководителем и план исправления.",
    },
    "client_upset": {
        "tone": "bad",
        "severity": "high",
        "title": "Клиент нервничает",
        "detail": "Клиент пишет о срочности и рисках, ждёт конкретного ответа.",
        "recommendation": "Снять напряжение: извиниться за ожидание, назвать точное время ответа.",
    },
    "client_risk_soft": {
        "tone": "bad",
        "severity": "medium",
        "title": "Клиент боится последствий",
        "detail": "Клиент прямо говорит о штрафе и не хочет рисковать.",
        "recommendation": "Подтвердить, что срок контролируется, и дать статус в ближайшие 30 минут.",
    },
    "rude": {
        "tone": "bad",
        "severity": "high",
        "title": "Резкий тон в ответе",
        "detail": "Сотрудник упрекает клиента вместо того, чтобы помочь решить задачу.",
        "recommendation": "Переформулировать без обвинений: «Чтобы успеть, нужно…». Провести короткий коучинг.",
    },
    "deadline_risk": {
        "tone": "bad",
        "severity": "high",
        "title": "Срок под угрозой",
        "detail": "До контрольной даты осталось мало времени, подтверждения готовности нет.",
        "recommendation": "Зафиксировать дедлайн, ответственного и ближайший контрольный шаг.",
    },
    "no_handoff": {
        "tone": "bad",
        "severity": "critical",
        "title": "Диалог не передан",
        "detail": "Сотрудник недоступен, но клиентский вопрос не передан другому бухгалтеру.",
        "recommendation": "Назначить замену и передать контекст. Клиент не должен искать ответ сам.",
    },
    "repeat_question": {
        "tone": "bad",
        "severity": "low",
        "title": "Клиент переспрашивает",
        "detail": "Один и тот же вопрос задан повторно — ответ был неполным или его не было.",
        "recommendation": "Проверить, закрыт ли вопрос по существу, а не формально.",
    },
    "promise_done": {
        "tone": "good",
        "severity": "high",
        "title": "Обещание выполнено в срок",
        "detail": "Сотрудник сделал работу и сообщил клиенту результат.",
        "recommendation": "Так держать: фиксировать результат в чате, а не только «в работе».",
    },
    "thanks": {
        "tone": "good",
        "severity": "medium",
        "title": "Клиент благодарит",
        "detail": "В переписке есть явная благодарность за скорость или качество.",
        "recommendation": "Можно использовать как пример для обучения команды.",
    },
    "proactive": {
        "tone": "good",
        "severity": "medium",
        "title": "Проявлена инициатива",
        "detail": "Сотрудник предупредил о риске или предложил следующий шаг без просьбы клиента.",
        "recommendation": "Закрепить как стандарт: предлагать следующий шаг в каждом диалоге.",
    },
    "crisis_solved": {
        "tone": "good",
        "severity": "high",
        "title": "Кризис закрыт",
        "detail": "Сложная ситуация решена, клиент получил результат.",
        "recommendation": "Разобрать на планёрке как удачный пример действий.",
    },
    "escalation": {
        "tone": "good",
        "severity": "medium",
        "title": "Руководитель подключился вовремя",
        "detail": "Эскалация сработала: руководитель взял диалог и довёл до результата.",
        "recommendation": "Сохранить как пример для спорных ситуаций.",
    },
    "new_client": {
        "tone": "good",
        "severity": "high",
        "title": "Новый клиент и доп. услуга",
        "detail": "Сотрудник квалифицировал запрос и предложил сопровождение.",
        "recommendation": "Передать в CRM и закрепить ответственного.",
    },
    "documents_done": {
        "tone": "good",
        "severity": "low",
        "title": "Документы закрыты",
        "detail": "Акты и подтверждения загружены, след в системе есть.",
        "recommendation": "Проверить, что клиент получил копию.",
    },
}


def fmt_minutes(value: int | None) -> str:
    if value is None:
        return "—"
    value = max(0, int(value))
    if value < 60:
        return f"{value} мин"
    hours, minutes = divmod(value, 60)
    if hours < 24:
        return f"{hours} ч {minutes} мин" if minutes else f"{hours} ч"
    days, hours = divmod(hours, 24)
    return f"{days} д {hours} ч" if hours else f"{days} д"


def _short(text: str, limit: int = 300) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _is_closing(text: str) -> bool:
    """Короткие «спасибо/ок» не считаем ожиданием ответа."""
    low = (text or "").lower().strip()
    if not low:
        return False
    markers = ("спасибо", "благодар", "супер", "отлично", "всё получил", "все получил", "понял", "принял", "договорились", "хорошо")
    return len(low) < 90 and any(marker in low for marker in markers)


def _dt(value: datetime) -> str:
    return value.strftime("%d.%m %H:%M")


def _finding(chat: Chat, code: str, **kwargs) -> Finding:
    return Finding(chat_id=chat.id, employee_id=chat.employee_id, code=code, **kwargs)


def _add_flag_findings(chat: Chat, messages: list[Message], out: list[Finding], seen: set[str]) -> None:
    for message in messages:
        flags = (message.meta or {}).get("flags") or []
        for flag in flags:
            config = FLAGS.get(flag)
            if not config or config["tone"] != "bad":
                continue
            if flag in seen:
                continue
            seen.add(flag)
            out.append(
                _finding(
                    chat,
                    flag,
                    tone="bad",
                    severity=config["severity"],
                    title=config["title"],
                    detail=config["detail"],
                    quote=_short(message.text),
                    recommendation=config["recommendation"],
                    message_id=message.id,
                )
            )
        for flag in flags:
            config = FLAGS.get(flag)
            if not config or config["tone"] != "good":
                continue
            if flag in seen:
                continue
            seen.add(flag)
            out.append(
                _finding(
                    chat,
                    flag,
                    tone="good",
                    severity=config["severity"],
                    title=config["title"],
                    detail=config["detail"],
                    quote=_short(message.text),
                    recommendation=config["recommendation"],
                    message_id=message.id,
                )
            )


def rebuild(db: Session, now: datetime | None = None) -> None:
    now = now or datetime.now().replace(second=0, microsecond=0)
    chats: list[Chat] = db.query(Chat).all()

    for chat in chats:
        messages: list[Message] = (
            db.query(Message).filter(Message.chat_id == chat.id).order_by(Message.created_at, Message.id).all()
        )
        promises: list[Promise] = db.query(Promise).filter(Promise.chat_id == chat.id).all()
        if not messages:
            continue

        db.query(Finding).filter(Finding.chat_id == chat.id).delete()

        client_msgs = [m for m in messages if m.author == "client"]
        employee_msgs = [m for m in messages if m.author == "employee"]

        first_response = None
        if client_msgs and employee_msgs:
            first_client = client_msgs[0].created_at
            later = [m for m in employee_msgs if m.created_at >= first_client]
            if later:
                first_response = int((later[0].created_at - first_client).total_seconds() // 60)

        deltas: list[int] = []
        for client_msg in client_msgs:
            later = [m for m in employee_msgs if m.created_at > client_msg.created_at]
            if later:
                deltas.append(int((later[0].created_at - client_msg.created_at).total_seconds() // 60))
        avg_response = int(sum(deltas) / len(deltas)) if deltas else None

        waiting = None
        human = [m for m in messages if m.author in ("client", "employee")]
        if human and human[-1].author == "client" and not _is_closing(human[-1].text):
            waiting = int((now - human[-1].created_at).total_seconds() // 60)

        chat.first_response_min = first_response
        chat.avg_response_min = avg_response
        chat.waiting_min = waiting
        chat.last_activity = human[-1].created_at if human else messages[-1].created_at

        findings: list[Finding] = []
        seen: set[str] = set()

        if first_response is not None and first_response > settings.first_response_warn:
            severity = "critical" if first_response > settings.first_response_critical else "high"
            findings.append(
                _finding(
                    chat,
                    "slow_first",
                    tone="bad",
                    severity=severity,
                    title="Первый ответ слишком поздно",
                    detail=f"Клиент написал, ответ пришёл через {fmt_minutes(first_response)}. Норма — до {settings.first_response_warn} минут.",
                    quote=_short(client_msgs[0].text),
                    recommendation="Проверить график дежурств и уведомления на телефоне. Для срочных тем — автоэскалация руководителю.",
                    message_id=client_msgs[0].id,
                )
            )
            seen.add("slow_first")
        elif first_response is not None and first_response <= 10:
            findings.append(
                _finding(
                    chat,
                    "fast_reply",
                    tone="good",
                    severity="low",
                    title="Быстрый первый ответ",
                    detail=f"Ответ за {first_response} мин — клиент не ждёт.",
                    quote=_short(client_msgs[0].text),
                    recommendation="Поддерживать скорость на входящих.",
                    message_id=client_msgs[0].id,
                )
            )

        if waiting is not None and waiting > settings.waiting_warn:
            severity = "critical" if waiting > settings.waiting_critical else "high"
            last_client = [m for m in messages if m.author == "client"][-1]
            findings.append(
                _finding(
                    chat,
                    "client_waiting",
                    tone="bad",
                    severity=severity,
                    title="Клиент ждёт ответа",
                    detail=f"Последнее сообщение клиента {fmt_minutes(waiting)} назад, ответа до сих пор нет.",
                    quote=_short(last_client.text),
                    recommendation="Ответить сейчас. Если вопрос вне компетенции — передать ответственному и сказать об этом клиенту.",
                    message_id=last_client.id,
                )
            )
            seen.add("client_waiting")

        _add_flag_findings(chat, messages, findings, seen)

        for promise in promises:
            if promise.status == "overdue":
                overdue = max(0, int((now - promise.due_at).total_seconds() // 60))
                severity = "critical" if overdue > 12 * 60 else "high"
                if "promise_overdue" not in seen:
                    seen.add("promise_overdue")
                    findings.append(
                        _finding(
                            chat,
                            "promise_overdue",
                            tone="bad",
                            severity=severity,
                            title="Обещание просрочено",
                            detail=f"«{promise.text}». Срок — {_dt(promise.due_at)}, просрочено на {fmt_minutes(overdue)}.",
                            quote="",
                            recommendation="Написать клиенту новую дату и предупредить руководителя. Не ждать, пока клиент спросит сам.",
                            message_id=promise.source_message_id,
                        )
                    )
            elif promise.status == "kept" and "promise_kept" not in seen and "promise_done" not in seen:
                seen.add("promise_kept")
                findings.append(
                    _finding(
                        chat,
                        "promise_kept",
                        tone="good",
                        severity="high",
                        title="Обещание выполнено в срок",
                        detail=f"«{promise.text}» — результат подтверждён клиенту.",
                        quote="",
                        recommendation="Фиксировать результат в чате: клиент видит, что работа закрыта.",
                        message_id=promise.source_message_id,
                    )
                )

        penalty = sum(SEVERITY_PENALTY[f.severity] for f in findings if f.tone == "bad")
        reward = min(6, sum(SEVERITY_REWARD[f.severity] for f in findings if f.tone == "good"))
        score = max(0, min(99, 100 - penalty + reward))
        chat.score = score

        worst = max((SEVERITY_RANK[f.severity] for f in findings if f.tone == "bad"), default=0)
        if worst >= SEVERITY_RANK["critical"] or score < 60:
            chat.verdict = "critical"
        elif worst >= SEVERITY_RANK["high"] or score < 85:
            chat.verdict = "watch"
        else:
            chat.verdict = "ok"

        for finding in findings:
            db.add(finding)

    db.flush()
