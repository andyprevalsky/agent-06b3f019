"""Order model over a normalized CSV row."""

from decimal import Decimal


class Order:
    REQUIRED = ("sku", "unit_price", "quantity")

    def __init__(self, row):
        self.row = row

    @property
    def sku(self):
        return self.row["sku"]

    @property
    def quantity(self):
        return int(self.row["quantity"])

    @property
    def total(self):
        return Decimal(self.row["unit_price"]) * self.quantity
