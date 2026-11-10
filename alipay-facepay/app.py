# -*- coding: utf-8 -*-
"""支付宝当面付最小闭环服务。

闭环链路：
  1. POST /api/orders        预下单(alipay.trade.precreate) → 返回二维码
  2. 买家扫码支付
  3. POST /api/notify        支付宝异步通知 → RSA2 验签 → 字段校验 → 幂等入账
  4. GET  /api/orders/<no>   前端轮询；真实模式下顺带主动查询补单，防止 notify 丢失

启动：python3 app.py
"""
import base64
import io
import logging
import os
import re
import secrets
from datetime import datetime
from decimal import Decimal

from dotenv import load_dotenv

load_dotenv()  # 必须在导入 alipay_client 前加载，保证环境变量生效

import qrcode
from flask import Flask, jsonify, request, send_from_directory

import store
from alipay_client import (
    MODE,
    MODE_DEMO,
    MODE_PRODUCTION,
    MODE_SANDBOX,
    build_client,
    is_demo,
    validate_amount,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("facepay")

app = Flask(__name__, static_folder="static")
client = build_client()
store.init_db()


# ---------------------------------------------------------------- 业务入口

def apply_paid_success(out_trade_no: str, trade_no: str | None, raw: dict) -> bool:
    """支付成功的唯一业务入口，真实 notify 与演示模拟回调共用，保证幂等。"""
    changed, order = store.apply_trade_status(
        out_trade_no, "TRADE_SUCCESS", trade_no, raw
    )
    if order is None:
        log.warning("回调订单不存在: %s", out_trade_no)
        return False
    if changed:
        log.info("支付成功入账: %s 金额=%s 流水=%s",
                 out_trade_no, order["total_amount"], trade_no)
    else:
        log.info("重复回调已忽略(幂等): %s", out_trade_no)
    return changed


def make_qr_data_uri(text: str) -> str:
    img = qrcode.make(text, box_size=8, border=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def gen_out_trade_no() -> str:
    return "ORDER" + datetime.now().strftime("%Y%m%d%H%M%S") + secrets.token_hex(3)


# ---------------------------------------------------------------- 页面

@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/health")
def health():
    return jsonify({
        "mode": MODE,
        "mode_label": {
            MODE_DEMO: "演示模式（模拟支付，无需密钥）",
            MODE_SANDBOX: "支付宝沙箱环境",
            MODE_PRODUCTION: "正式生产环境",
        }.get(MODE, MODE),
    })


# ---------------------------------------------------------------- 下单

@app.post("/api/orders")
def create_order():
    payload = request.get_json(silent=True) or {}
    subject = (payload.get("subject") or "").strip()
    total_amount = str(payload.get("total_amount") or "").strip()

    if not subject or len(subject) > 256:
        return jsonify({"error": "商品名称不能为空且不超过256字"}), 400
    try:
        validate_amount(total_amount)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    out_trade_no = gen_out_trade_no()
    store.create_order(out_trade_no, subject, total_amount)

    try:
        qr_code = client.precreate(subject, out_trade_no, total_amount)
    except Exception as exc:  # 预下单失败，订单保留为 CREATED 便于排查
        log.exception("预下单失败")
        return jsonify({"error": f"预下单失败: {exc}"}), 502

    store.mark_waiting(out_trade_no, qr_code)

    if is_demo():
        # 演示模式：8 秒后模拟支付成功，走与真实 notify 完全相同的入账入口
        client.simulate_paid(out_trade_no, apply_paid_success)

    order = store.get_order(out_trade_no)
    log.info("订单已创建: %s 金额=%s 模式=%s", out_trade_no, total_amount, MODE)
    return jsonify({
        "out_trade_no": out_trade_no,
        "subject": subject,
        "total_amount": total_amount,
        "status": order["status"],
        "qr_code": qr_code,
        "qr_image": make_qr_data_uri(qr_code),
        "demo": is_demo(),
    })


# ---------------------------------------------------------------- 轮询 / 补单

@app.get("/api/orders/<out_trade_no>")
def query_order(out_trade_no: str):
    order = store.get_order(out_trade_no)
    if order is None:
        return jsonify({"error": "订单不存在"}), 404

    # 真实模式下，订单仍未终结时主动查询支付宝做补单，防止异步通知丢失
    if not is_demo() and order["status"] not in ("TRADE_SUCCESS", "TRADE_FINISHED", "TRADE_CLOSED"):
        try:
            result = client.query(out_trade_no)
            remote_status = result.get("trade_status")
            if remote_status in ("TRADE_SUCCESS", "TRADE_FINISHED"):
                store.apply_trade_status(
                    out_trade_no, remote_status, result.get("trade_no"), result.get("raw")
                )
                order = store.get_order(out_trade_no)
            elif remote_status == "TRADE_CLOSED":
                store.apply_trade_status(out_trade_no, "TRADE_CLOSED", None, result.get("raw"))
                order = store.get_order(out_trade_no)
        except Exception:
            log.exception("主动查询补单失败，保留本地状态: %s", out_trade_no)

    return jsonify({
        "out_trade_no": order["out_trade_no"],
        "subject": order["subject"],
        "total_amount": order["total_amount"],
        "status": order["status"],
        "trade_no": order["trade_no"],
        "paid_at": order["paid_at"],
        "refunded_amount": order.get("refunded_amount", "0.00"),
        "refunds": store.list_refunds(out_trade_no),
    })


# ---------------------------------------------------------------- 异步通知

@app.post("/api/notify")
def notify():
    """支付宝异步回调：必须返回纯文本 success，否则支付宝会持续重投。"""
    form = request.form.to_dict()
    log.info("收到异步通知: out_trade_no=%s", form.get("out_trade_no"))

    if is_demo():
        return "failure", 400

    # 1. RSA2 验签
    if not client.verify_notify(form):
        log.warning("验签失败，拒绝该通知")
        return "failure", 400

    out_trade_no = form.get("out_trade_no", "")
    order = store.get_order(out_trade_no)
    if order is None:
        log.warning("通知对应订单不存在: %s", out_trade_no)
        return "failure", 404

    # 2. 关键业务字段校验（app_id、金额、订单号）
    if form.get("app_id") != client.appid:
        log.warning("app_id 不匹配: %s", form.get("app_id"))
        return "failure", 400
    if form.get("total_amount") != order["total_amount"]:
        log.warning("金额不一致: 通知=%s 订单=%s",
                    form.get("total_amount"), order["total_amount"])
        return "failure", 400

    # 3. 按交易状态驱动状态机（内部含幂等保护）
    trade_status = form.get("trade_status")
    if trade_status in ("TRADE_SUCCESS", "TRADE_FINISHED"):
        apply_paid_success(out_trade_no, form.get("trade_no"), form)
    elif trade_status == "TRADE_CLOSED":
        store.apply_trade_status(out_trade_no, "TRADE_CLOSED", None, form)
    else:
        log.info("忽略中间状态通知: %s", trade_status)

    return "success"


# ---------------------------------------------------------------- 关单

@app.post("/api/orders/<out_trade_no>/close")
def close_order(out_trade_no: str):
    order = store.get_order(out_trade_no)
    if order is None:
        return jsonify({"error": "订单不存在"}), 404
    if order["status"] not in ("CREATED", "WAIT_BUYER_PAY"):
        return jsonify({"error": f"当前状态 {order['status']} 不允许关单"}), 409

    try:
        client.close_order(out_trade_no)
    except Exception as exc:
        log.exception("关单失败")
        return jsonify({"error": f"关单失败: {exc}"}), 502

    store.apply_trade_status(out_trade_no, "TRADE_CLOSED", None, {"action": "manual_close"})
    log.info("订单已关闭: %s", out_trade_no)
    return jsonify(store.get_order(out_trade_no))


# ---------------------------------------------------------------- 退款

def gen_out_request_no() -> str:
    return "RF" + datetime.now().strftime("%Y%m%d%H%M%S") + secrets.token_hex(3)


@app.post("/api/orders/<out_trade_no>/refund")
def refund_order(out_trade_no: str):
    order = store.get_order(out_trade_no)
    if order is None:
        return jsonify({"error": "订单不存在"}), 404
    if order["status"] not in ("TRADE_SUCCESS", "TRADE_FINISHED"):
        return jsonify({"error": "仅支付成功的订单可以退款"}), 409

    payload = request.get_json(silent=True) or {}
    refund_amount = str(payload.get("refund_amount") or "").strip()
    reason = (payload.get("reason") or "").strip() or None
    try:
        validate_amount(refund_amount)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    # 可退余额校验：订单总额 - 已累计退款
    remaining = Decimal(order["total_amount"]) - Decimal(order.get("refunded_amount", "0.00"))
    if Decimal(refund_amount) > remaining:
        return jsonify({
            "error": f"退款金额超过可退余额，剩余可退 {format(remaining, '.2f')} 元"
        }), 409

    out_request_no = gen_out_request_no()
    # 先落本地退款单（PROCESSING），out_request_no 作为全局幂等键
    store.create_refund(out_request_no, out_trade_no, refund_amount, reason)

    try:
        result = client.refund(out_trade_no, refund_amount, out_request_no, reason)
    except Exception as exc:
        # 网络抖动等场景退款单保留 PROCESSING，可通过退款查询接口对账补状态
        log.exception("退款请求失败: %s", out_request_no)
        return jsonify({
            "error": f"退款失败: {exc}",
            "out_request_no": out_request_no,
            "hint": "退款单已保留，可调用退款查询接口确认最终状态",
        }), 502

    changed, refund = store.mark_refund_success(
        out_request_no, result.get("trade_no"), result
    )
    log.info("退款成功: 订单=%s 退款单=%s 金额=%s 幂等变更=%s",
             out_trade_no, out_request_no, refund_amount, changed)
    latest_order = store.get_order(out_trade_no)
    latest_order["refunds"] = store.list_refunds(out_trade_no)
    return jsonify({
        "refund": refund,
        "order": latest_order,
    })


@app.get("/api/orders/<out_trade_no>/refunds")
def list_refunds(out_trade_no: str):
    if store.get_order(out_trade_no) is None:
        return jsonify({"error": "订单不存在"}), 404
    return jsonify(store.list_refunds(out_trade_no))


@app.get("/api/refunds/<out_request_no>")
def query_refund(out_request_no: str):
    """退款查询：本地状态 + 支付宝侧状态对账，PROCESSING 单可借此补单。"""
    refund = store.get_refund(out_request_no)
    if refund is None:
        return jsonify({"error": "退款单不存在"}), 404

    remote = None
    if refund["status"] != "REFUND_SUCCESS":
        try:
            remote = client.refund_query(refund["out_trade_no"], out_request_no)
            # 支付宝侧已退成功但本地仍在处理中：补落账（内部幂等）
            if remote.get("refund_status") == "REFUND_SUCCESS" or remote.get("code") == "10000":
                store.mark_refund_success(out_request_no, remote.get("trade_no"), remote)
                refund = store.get_refund(out_request_no)
        except Exception:
            log.exception("退款查询失败，保留本地状态: %s", out_request_no)

    return jsonify({"refund": refund, "remote": remote})


# ---------------------------------------------------------------- 对账单

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@app.get("/api/bills")
def bill_url():
    bill_type = request.args.get("bill_type", "trade")
    bill_date = request.args.get("bill_date", "").strip()
    if bill_type not in ("trade", "signcustomer"):
        return jsonify({"error": "bill_type 仅支持 trade 或 signcustomer"}), 400
    if not _DATE_RE.match(bill_date):
        return jsonify({"error": "bill_date 格式应为 YYYY-MM-DD"}), 400

    try:
        url = client.bill_download_url(bill_type, bill_date)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify({"bill_type": bill_type, "bill_date": bill_date, "download_url": url})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    log.info("当面付服务启动，模式=%s，端口=%d", MODE, port)
    app.run(host="0.0.0.0", port=port, debug=False)
