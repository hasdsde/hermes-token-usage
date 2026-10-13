"""token-usage 后端：只读查询 state.db 的 token 用量。

挂载在 /api/plugins/token-usage/ 下（gateway 进程内运行）。

GET /usage?start=<epoch秒>&end=<epoch秒>
  按 (billing_provider, model) 分组返回输入/输出/缓存读写/推理 token、
  调用次数、费用，以及每组下每条 session 的明细。
  时间过滤用重叠区间：usage 行的 [first_seen, last_seen] 与查询区间相交即计入。
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from fastapi import APIRouter, Query

router = APIRouter()

_TOKEN_COLS = (
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
)


def _state_db() -> Path:
    home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    return Path(home) / "state.db"


@router.get("/usage")
def usage(start: float = Query(...), end: float = Query(...)):
    if end < start:
        start, end = end, start

    db = _state_db()
    if not db.exists():
        return {"start": start, "end": end, "groups": [], "error": f"state.db 不存在: {db}"}

    # 只读连接：gateway 正在写同一个库（WAL），ro 快照读不会阻塞也不会被锁。
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=3.0)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT u.session_id, u.model, u.billing_provider,
                   u.api_call_count,
                   u.input_tokens, u.output_tokens,
                   u.cache_read_tokens, u.cache_write_tokens, u.reasoning_tokens,
                   u.estimated_cost_usd, u.actual_cost_usd,
                   u.first_seen, u.last_seen,
                   s.title, s.started_at, s.source
            FROM session_model_usage u
            LEFT JOIN sessions s ON s.id = u.session_id
            WHERE COALESCE(u.last_seen, s.started_at, 0) >= ?
              AND COALESCE(u.first_seen, s.started_at, 0) <= ?
            """,
            (start, end),
        ).fetchall()
    finally:
        conn.close()

    groups: dict[tuple[str, str], dict] = {}
    for r in rows:
        provider = r["billing_provider"] or "unknown"
        key = (provider, r["model"])
        g = groups.get(key)
        if g is None:
            g = groups[key] = {
                "provider": provider,
                "model": r["model"],
                "api_call_count": 0,
                **{c: 0 for c in _TOKEN_COLS},
                "total_tokens": 0,
                "estimated_cost_usd": 0.0,
                "actual_cost_usd": 0.0,
                "sessions": [],
            }

        row_total = sum(r[c] or 0 for c in _TOKEN_COLS)
        g["api_call_count"] += r["api_call_count"] or 0
        for c in _TOKEN_COLS:
            g[c] += r[c] or 0
        g["total_tokens"] += row_total
        g["estimated_cost_usd"] += r["estimated_cost_usd"] or 0.0
        g["actual_cost_usd"] += r["actual_cost_usd"] or 0.0

        g["sessions"].append({
            "session_id": r["session_id"],
            "title": r["title"] or (r["session_id"] or "")[:12],
            "source": r["source"] or "",
            "started_at": r["started_at"],
            "api_call_count": r["api_call_count"] or 0,
            **{c: (r[c] or 0) for c in _TOKEN_COLS},
            "total_tokens": row_total,
            "estimated_cost_usd": r["estimated_cost_usd"] or 0.0,
            "actual_cost_usd": r["actual_cost_usd"] or 0.0,
        })

    out = sorted(groups.values(), key=lambda g: -g["total_tokens"])
    for g in out:
        g["sessions"].sort(key=lambda s: -s["total_tokens"])
    return {"start": start, "end": end, "groups": out}
