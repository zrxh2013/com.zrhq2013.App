# -*- coding: utf-8 -*-
"""订单存储层：SQLite + 订单状态机 + 幂等更新。

状态流转：
    CREATED        本地订单已创建，尚未拿到二维码
    WAIT_BUYER_PAY 已预下单（precreate 成功），等待买家扫码付款
    TRADE_CLOSED   交易关闭（超时未付 / 主动关单）
    TRADE_SUCCESS  支付成功（终态，幂等保护，只允许落一次）
    TRADE_FINISHED 交易完成（不可退款终态，等同成功处理）
"""
import json
import os
import sqlite3
import threading
from datetime import datetime

DB_PATH = os.environ.get("FACEPAY_DB", os.path.join(os.path.dirname(__file__), "facepay.db"))

_LOCK = threading.Lock()

# 终态：一旦进入就不允许再被覆盖
_SUCCESS_STATES = ("TRADE_SUCCESS", "TRADE_FINISHED")


def _connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS orders (
                out_trade_no  TEXT PRIMARY KEY,
                subject       TEXT NOT NULL,
                total_amount  TEXT NOT NULL,
                status        TEXT NOT NULL DEFAULT 'CREATED',
                qr_code       TEXT,
                trade_no      TEXT,
                notify_raw    TEXT,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL,
                paid_at       TEXT
            )
            """
        )


def create_order(out_trade_no: str, subject: str, total_amount: str) -> dict:
    now = datetime.now().isoformat(timespec="seconds")
    with _LOCK, _connect() as conn:
        conn.execute(
            "INSERT INTO orders(out_trade_no, subject, total_amount, status, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?)",
            (out_trade_no, subject, total_amount, "CREATED", now, now),
        )
    return get_order(out_trade_no)


def mark_waiting(out_trade_no: str, qr_code: str):
    """预下单成功，保存二维码内容并进入等待支付状态。"""
    now = datetime.now().isoformat(timespec="seconds")
    with _LOCK, _connect() as conn:
        conn.execute(
            "UPDATE orders SET qr_code=?, status='WAIT_BUYER_PAY', updated_at=?"
            " WHERE out_trade_no=? AND status='CREATED'",
            (qr_code, now, out_trade_no),
        )


def get_order(out_trade_no: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM orders WHERE out_trade_no=?", (out_trade_no,)
        ).fetchone()
    return dict(row) if row else None


def apply_trade_status(out_trade_no: str, status: str, trade_no: str | None,
                       notify_raw: dict | None) -> tuple[bool, dict | None]:
    """驱动状态机，返回 (是否发生变更, 最新订单)。

    幂等关键：终态订单直接 no-op；UPDATE 语句带状态保护，配合行级锁，
    保证支付宝重复回调 / 主动查询补单并发到达时“只入账一次”。
    """
    order = get_order(out_trade_no)
    if order is None:
        return False, None
    if order["status"] in _SUCCESS_STATES:
        return False, order

    now = datetime.now().isoformat(timespec="seconds")
    paid_at = now if status in _SUCCESS_STATES else None
    raw = json.dumps(notify_raw, ensure_ascii=False) if notify_raw else None

    with _LOCK, _connect() as conn:
        if status in _SUCCESS_STATES:
            cur = conn.execute(
                "UPDATE orders SET status=?, trade_no=COALESCE(?, trade_no),"
                " notify_raw=COALESCE(?, notify_raw), paid_at=?, updated_at=?"
                " WHERE out_trade_no=? AND status NOT IN ('TRADE_SUCCESS','TRADE_FINISHED')",
                (status, trade_no, raw, paid_at, now, out_trade_no),
            )
        else:
            cur = conn.execute(
                "UPDATE orders SET status=?, trade_no=COALESCE(?, trade_no),"
                " notify_raw=COALESCE(?, notify_raw), updated_at=?"
                " WHERE out_trade_no=? AND status NOT IN ('TRADE_SUCCESS','TRADE_FINISHED')",
                (status, trade_no, raw, now, out_trade_no),
            )
        changed = cur.rowcount > 0
    return changed, get_order(out_trade_no)
