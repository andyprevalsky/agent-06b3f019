"""Exact browser activity cleanup receipts across timeout and continuation."""

from browser_cleanup_receipt_cases import run_all_tests


if __name__ == "__main__":
    import asyncio

    asyncio.run(run_all_tests())
