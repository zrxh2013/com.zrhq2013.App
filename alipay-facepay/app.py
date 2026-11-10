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
import secrets
import time
from datetime import datetime

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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    log.info("当面付服务启动，模式=%s，端口=%d", MODE, port)
    app.run(host="0.0.0.0", port=port, debug=False)
