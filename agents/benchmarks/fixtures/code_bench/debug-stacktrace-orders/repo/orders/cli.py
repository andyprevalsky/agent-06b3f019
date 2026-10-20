"""Command line entry point: python3 -m orders.cli <export.csv>"""

import sys

from orders.csv_loader import load_rows
from orders.models import Order
from orders.report import build_report, render


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    orders = [Order(row) for row in load_rows(args[0])]
    print(render(build_report(orders)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
