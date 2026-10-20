"""Revenue report over orders."""

from decimal import Decimal


def build_report(orders):
    revenue = Decimal("0")
    units_by_sku = {}
    for order in orders:
        revenue += order.total
        units_by_sku[order.sku] = units_by_sku.get(order.sku, 0) + order.quantity
    return {"orders": len(orders), "revenue": revenue, "units_by_sku": dict(sorted(units_by_sku.items()))}


def render(report):
    lines = [f"orders: {report['orders']}", f"revenue: {report['revenue']:.2f}"]
    lines += [f"  {sku}: {units}" for sku, units in report["units_by_sku"].items()]
    return "\n".join(lines)
