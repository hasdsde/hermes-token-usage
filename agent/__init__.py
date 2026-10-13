"""token-usage — desktop「用量」页的 agent 侧包。

只提供 dashboard/plugin_api.py 后端路由（只读查询 state.db 的
session_model_usage），不注册任何 hook / 工具。
"""

from __future__ import annotations


def register(ctx):  # noqa: ARG001 - 无 agent 侧能力，仅挂载 dashboard 后端
    pass
