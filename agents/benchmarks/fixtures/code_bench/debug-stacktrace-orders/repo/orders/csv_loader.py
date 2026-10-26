"""Load order rows from CSV exports."""

import csv


def normalize_header(name):
    """Normalize a CSV header to the snake_case key used by the models."""
    return name.strip().lower()


def load_rows(path):
    """Return one dict per CSV row, keyed by normalized header."""
    with open(path, newline="") as handle:
        reader = csv.DictReader(handle)
        return [{normalize_header(key): value.strip() for key, value in row.items()} for row in reader]
