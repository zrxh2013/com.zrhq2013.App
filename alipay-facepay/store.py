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
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS refunds (
                out_request_no  TEXT PRIMARY KEY,
                out_trade_no    TEXT NOT NULL,
                refund_amount   TEXT NOT NULL,
                reason          TEXT,
                status          TEXT NOT NULL DEFAULT 'PROCESSING',
                trade_no        TEXT,
                raw             TEXT,
                created_at      TEXT NOT NULL,
                updated_at      TEXT NOT NULL
            )
            """
        )
        # 轻量迁移：为旧版 orders 表补退款累计金额字段
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(orders)")}
        if "refunded_amount" not in cols:
            conn.execute("ALTER TABLE orders ADD COLUMN refunded_amount TEXT NOT NULL DEFAULT '0.00'")


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


# ---------------------------------------------------------------- 退款

from decimal import Decimal


def create_refund(out_request_no: str, out_trade_no: str,
                  refund_amount: str, reason: str | None) -> dict | None:
    """创建退款单。out_request_no 是幂等键：重复请求直接返回已存在的记录。"""
    now = datetime.now().isoformat(timespec="seconds")
    with _LOCK, _connect() as conn:
        existing = conn.execute(
            "SELECT * FROM refunds WHERE out_request_no=?", (out_request_no,)
        ).fetchone()
        if existing:
            return dict(existing)
        conn.execute(
            "INSERT INTO refunds(out_request_no, out_trade_no, refund_amount, reason,"
            " status, created_at, updated_at) VALUES (?,?,?,?, 'PROCESSING', ?, ?)",
            (out_request_no, out_trade_no, refund_amount, reason, now, now),
        )
    return get_refund(out_request_no)


def get_refund(out_request_no: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM refunds WHERE out_request_no=?", (out_request_no,)
        ).fetchone()
    return dict(row) if row else None


def list_refunds(out_trade_no: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM refunds WHERE out_trade_no=? ORDER BY created_at",
            (out_trade_no,),
        ).fetchall()
    return [dict(r) for r in rows]


def mark_refund_success(out_request_no: str, trade_no: str | None,
                        raw: dict | None) -> tuple[bool, dict | None]:
    """退款成功落账，幂等：同一退款单重复通知只处理一次，并原子累加订单退款额。"""
    refund = get_refund(out_request_no)
    if refund is None:
        return False, None
    if refund["status"] == "REFUND_SUCCESS":
        return False, refund

    now = datetime.now().isoformat(timespec="seconds")
    raw_text = json.dumps(raw, ensure_ascii=False) if raw else None
    with _LOCK, _connect() as conn:
        cur = conn.execute(
            "UPDATE refunds SET status='REFUND_SUCCESS', trade_no=COALESCE(?, trade_no),"
            " raw=COALESCE(?, raw), updated_at=?"
            " WHERE out_request_no=? AND status != 'REFUND_SUCCESS'",
            (trade_no, raw_text, now, out_request_no),
        )
        if cur.rowcount:
            # Decimal 计算避免浮点误差，原子累加订单累计退款额
            row = conn.execute(
                "SELECT refunded_amount FROM orders WHERE out_trade_no=?",
                (refund["out_trade_no"],),
            ).fetchone()
            total = (Decimal(row["refunded_amount"]) + Decimal(refund["refund_amount"]))
            conn.execute(
                "UPDATE orders SET refunded_amount=?, updated_at=? WHERE out_trade_no=?",
                (format(total, ".2f"), now, refund["out_trade_no"]),
            )
        changed = cur.rowcount > 0
    return changed, get_refund(out_request_no)
