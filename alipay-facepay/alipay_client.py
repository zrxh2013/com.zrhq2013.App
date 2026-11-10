# -*- coding: utf-8 -*-
"""支付宝客户端封装。

- RealAlipayClient：基于 python-alipay-sdk 的真实当面付（alipay.trade.precreate）
- DemoAlipayClient：无密钥演示模式，本地模拟预下单与支付成功，接口形态与真实客户端一致

所有敏感配置只从环境变量读取，启动时缺失即报错，绝不硬编码。
"""
import os
import re
import threading
import uuid

from alipay import AliPay

# 三种运行模式
MODE_DEMO = "demo"          # 无密钥，全本地模拟
MODE_SANDBOX = "sandbox"    # 支付宝沙箱
MODE_PRODUCTION = "production"

MODE = os.environ.get("ALIPAY_MODE", MODE_DEMO).lower()
NOTIFY_URL = os.environ.get("ALIPAY_NOTIFY_URL", "").strip()


def _normalize_pem(key: str, kind: str) -> str:
    """把单行 base64 密钥补成标准 PEM；兼容 PKCS#1 / PKCS#8 两种头。

    kind: 'private' 或 'public'
    """
    key = key.strip().replace("\\n", "\n")
    if "BEGIN" in key:
        return key
    body = "\n".join(key[i:i + 64] for i in range(0, len(key), 64))
    if kind == "private":
        # 无法从内容判断 PKCS#1/PKCS#8 时统一包成 PKCS#8（cryptography 均可解析）
        header = "PRIVATE KEY"
    else:
        header = "PUBLIC KEY"
    return f"-----BEGIN {header}-----\n{body}\n-----END {header}-----\n"


class RealAlipayClient:
    """真实环境 / 沙箱环境客户端。"""

    def __init__(self):
        appid = os.environ.get("ALIPAY_APPID", "").strip()
        private_key = os.environ.get("ALIPAY_APP_PRIVATE_KEY", "").strip()
        public_key = os.environ.get("ALIPAY_PUBLIC_KEY", "").strip()
        missing = [n for n, v in (
            ("ALIPAY_APPID", appid),
            ("ALIPAY_APP_PRIVATE_KEY", private_key),
            ("ALIPAY_PUBLIC_KEY", public_key),
        ) if not v]
        if missing:
            raise RuntimeError(
                "缺少必要环境变量: %s。请参考 .env.example 配置，或设置 ALIPAY_MODE=demo 先跑演示。"
                % ", ".join(missing)
            )

        self.appid = appid
        self.sdk = AliPay(
            appid=appid,
            app_notify_url=NOTIFY_URL or None,
            app_private_key_string=_normalize_pem(private_key, "private"),
            alipay_public_key_string=_normalize_pem(public_key, "public"),
            sign_type="RSA2",
            debug=(MODE == MODE_SANDBOX),  # debug=True 时 SDK 自动切换沙箱网关
        )

    def precreate(self, subject: str, out_trade_no: str, total_amount: str) -> str:
        """预下单，返回二维码字符串内容（qr_code），失败抛异常。"""
        result = self.sdk.api_alipay_trade_precreate(
            subject=subject,
            out_trade_no=out_trade_no,
            total_amount=total_amount,
            notify_url=NOTIFY_URL or None,
        )
        if result.get("code") != "10000":
            raise RuntimeError(
                "预下单失败: %s %s" % (result.get("code"), result.get("msg"))
            )
        return result["qr_code"]

    def query(self, out_trade_no: str) -> dict:
        """主动查询交易状态，返回支付宝原始响应中的 trade 节点。"""
        result = self.sdk.api_alipay_trade_query(out_trade_no=out_trade_no)
        if result.get("code") != "10000":
            raise RuntimeError(
                "查询失败: %s %s" % (result.get("code"), result.get("msg"))
            )
        return {
            "trade_status": result.get("trade_status"),
            "trade_no": result.get("trade_no"),
            "raw": result,
        }

    def close_order(self, out_trade_no: str) -> dict:
        """关闭未支付交易（alipay.trade.close）。"""
        result = self.sdk.api_alipay_trade_close(out_trade_no=out_trade_no)
        if result.get("code") != "10000":
            raise RuntimeError(
                "关单失败: %s %s" % (result.get("code"), result.get("msg"))
            )
        return result

    def refund(self, out_trade_no: str, refund_amount: str,
               out_request_no: str, reason: str | None = None) -> dict:
        """退款（alipay.trade.refund），out_request_no 为退款请求幂等键。"""
        kwargs = {"out_request_no": out_request_no}
        if reason:
            kwargs["refund_reason"] = reason
        result = self.sdk.api_alipay_trade_refund(
            refund_amount=refund_amount,
            out_trade_no=out_trade_no,
            **kwargs,
        )
        if result.get("code") != "10000":
            raise RuntimeError(
                "退款失败: %s %s" % (result.get("code"), result.get("msg"))
            )
        return result

    def refund_query(self, out_trade_no: str, out_request_no: str) -> dict:
        """退款查询（alipay.trade.fastpay.refund.query）。"""
        result = self.sdk.api_alipay_trade_fastpay_refund_query(
            out_request_no=out_request_no,
            out_trade_no=out_trade_no,
        )
        if result.get("code") != "10000":
            raise RuntimeError(
                "退款查询失败: %s %s" % (result.get("code"), result.get("msg"))
            )
        return result

    def bill_download_url(self, bill_type: str, bill_date: str) -> str:
        """查询对账单下载地址（alipay.data.dataservice.bill.downloadurl.query）。

        bill_type: trade 业务订单明细 / signcustomer 商家签约结算明细
        bill_date: YYYY-MM-DD
        """
        result = self.sdk.server_api(
            "alipay.data.dataservice.bill.downloadurl.query",
            {"bill_type": bill_type, "bill_date": bill_date},
        )
        if result.get("code") != "10000":
            raise RuntimeError(
                "对账地址查询失败: %s %s" % (result.get("code"), result.get("msg"))
            )
        return result["bill_download_url"]

    def verify_notify(self, form: dict) -> bool:
        """异步通知验签。form 为支付宝 POST 的全部表单字段。"""
        data = dict(form)
        signature = data.pop("sign", "")
        data.pop("sign_type", None)
        if not signature:
            return False
        return self.sdk.verify(data, signature)


class DemoAlipayClient:
    """演示模式：不发起任何真实网络请求，本地模拟完整闭环。"""

    def __init__(self):
        self.appid = "DEMO_APPID"

    def precreate(self, subject: str, out_trade_no: str, total_amount: str) -> str:
        # 二维码内容使用自定义 scheme，仅用于演示页面渲染
        return f"demo-facepay://pay?out_trade_no={out_trade_no}&amount={total_amount}"

    def query(self, out_trade_no: str) -> dict:
        raise RuntimeError("演示模式不支持主动查询，状态由模拟回调驱动")

    def verify_notify(self, form: dict) -> bool:
        return False

    def close_order(self, out_trade_no: str) -> dict:
        return {"code": "10000", "trade_status": "TRADE_CLOSED",
                "out_trade_no": out_trade_no, "demo": True}

    def refund(self, out_trade_no: str, refund_amount: str,
               out_request_no: str, reason: str | None = None) -> dict:
        # 演示模式：退款立即成功
        return {
            "code": "10000",
            "fund_change": "Y",
            "out_trade_no": out_trade_no,
            "out_request_no": out_request_no,
            "refund_fee": refund_amount,
            "trade_no": "DEMO" + uuid.uuid4().hex[:16].upper(),
            "demo": True,
        }

    def refund_query(self, out_trade_no: str, out_request_no: str) -> dict:
        return {"code": "10000", "refund_status": "REFUND_SUCCESS",
                "out_request_no": out_request_no, "demo": True}

    def bill_download_url(self, bill_type: str, bill_date: str) -> str:
        raise RuntimeError("演示模式不产生真实对账单，请在 sandbox/production 模式调用")

    def simulate_paid(self, out_trade_no: str, on_paid):
        """8 秒后模拟买家扫码付款成功，回调走与真实 notify 相同的业务入口。"""
        def _job():
            trade_no = "DEMO" + uuid.uuid4().hex[:16].upper()
            on_paid(
                out_trade_no=out_trade_no,
                trade_no=trade_no,
                raw={
                    "app_id": self.appid,
                    "out_trade_no": out_trade_no,
                    "trade_status": "TRADE_SUCCESS",
                    "trade_no": trade_no,
                    "note": "演示模式模拟回调",
                },
            )

        timer = threading.Timer(8.0, _job)
        timer.daemon = True
        timer.start()


def build_client():
    if MODE == MODE_DEMO:
        return DemoAlipayClient()
    return RealAlipayClient()


def is_demo() -> bool:
    return MODE == MODE_DEMO


_AMOUNT_RE = re.compile(r"^\d+(\.\d{1,2})?$")


def validate_amount(total_amount: str) -> float:
    if not _AMOUNT_RE.match(total_amount or ""):
        raise ValueError("金额格式不正确，应为正数且最多两位小数")
    amount = float(total_amount)
    if not (0.01 <= amount <= 1_000_000):
        raise ValueError("金额需在 0.01 ~ 1000000 之间")
    return amount
