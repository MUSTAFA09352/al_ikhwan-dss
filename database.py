"""
database.py
===========
Al-Ikhwan Company - Executive Decision Support System (DSS)
SQLite schema definition and deterministic seed-data generator.

Run directly to (re)build the database::

    python database.py           # create tables + seed if empty
    python database.py --reset   # drop everything and rebuild from scratch

The module exposes :func:`get_connection` and :func:`init_db` which the Flask
API layer (``server.py``) imports.
"""

from __future__ import annotations

import os
import random
import sqlite3
from datetime import date, timedelta

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "dss_database.db")

# Fixed seed => reproducible demo dataset every time the DB is rebuilt.
RANDOM_SEED = 20261011

# Six trailing reporting months (inclusive of the current month).
MONTHS = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]

PAYMENT_METHODS = ["Cash", "Card", "Bank Transfer", "Credit"]
PAYMENT_WEIGHTS = [0.30, 0.28, 0.24, 0.18]

CUSTOMERS = [
    "Gulf Retail Group", "Al-Noor Trading", "Metro Hypermarket", "Crescent Electronics",
    "Baity Home Center", "Falcon Wholesale", "Sunrise Mart", "Dar Al-Salam Markets",
    "Northgate Supplies", "Pearl City Stores", "Atlas Distribution", "Horizon Traders",
    "Emerald Commercial Co.", "Vista Retail Chain", "Zahra General Trading", "Orion Supplies",
    "Blue Harbour Group", "Al-Faisal Stores", "Delta Wholesale", "Cedar Markets",
]

# ---------------------------------------------------------------------------
# Static reference data
# ---------------------------------------------------------------------------

# sku, name, name_ar, category, cost, price, stock, reorder_point, velocity
PRODUCTS = [
    ("ELC-TV55", "Smart LED TV 55\"", "تلفزيون ذكي 55 بوصة", "Electronics", 332, 480, 45, 60, 120),
    ("ELC-PH20", "Smartphone X20", "هاتف ذكي X20", "Electronics", 210, 320, 780, 300, 260),
    ("ELC-LP14", "Laptop Pro 14\"", "حاسوب محمول برو 14", "Electronics", 610, 850, 60, 80, 90),
    ("ELC-TB10", "Tablet Air 10\"", "جهاز لوحي إير 10", "Electronics", 155, 240, 340, 150, 135),
    ("COM-SG50", "Bulk Sugar 50kg", "سكر بالجملة 50 كغ", "Commercial Goods", 31, 42, 1800, 600, 400),
    ("COM-OL20", "Cooking Oil 20L", "زيت طبخ 20 لتر", "Commercial Goods", 20, 28, 4200, 800, 520),
    ("COM-RC25", "Basmati Rice 25kg", "أرز بسمتي 25 كغ", "Commercial Goods", 34, 49, 2200, 700, 460),
    ("COM-TF10", "Flour Pack 10kg", "كيس طحين 10 كغ", "Commercial Goods", 9, 14, 3100, 900, 610),
    ("HOM-RF40", "Refrigerator 400L", "ثلاجة 400 لتر", "Home Appliances", 470, 650, 210, 140, 70),
    ("HOM-WM08", "Washing Machine 8kg", "غسالة 8 كغ", "Home Appliances", 300, 420, 95, 120, 85),
    ("HOM-AC12", "Air Conditioner 1.5T", "مكيف 1.5 طن", "Home Appliances", 385, 540, 150, 110, 95),
    ("HOM-MW30", "Microwave Oven 30L", "فرن مايكروويف 30 لتر", "Home Appliances", 78, 120, 260, 160, 140),
    ("SPR-BP01", "Brake Pads Set", "طقم فحمات فرامل", "Spare Parts", 40, 65, 1500, 400, 300),
    ("SPR-EO05", "Engine Oil 5L", "زيت محرك 5 لتر", "Spare Parts", 13, 22, 900, 500, 640),
    ("SPR-AF02", "Air Filter", "فلتر هواء", "Spare Parts", 6, 12, 2400, 700, 520),
    ("SPR-BT70", "Car Battery 70Ah", "بطارية سيارة 70 أمبير", "Spare Parts", 58, 95, 320, 200, 180),
]

# name, name_ar, role, department, salary, performance, hire_date
EMPLOYEES = [
    ("Omar Al-Rashid", "عمر الراشد", "Chief Executive Officer", "Executive", 18000, 96, "2018-03-01"),
    ("Layla Nasser", "ليلى ناصر", "Finance Director", "Finance", 12500, 92, "2019-06-15"),
    ("Khalid Mansour", "خالد منصور", "Sales Director", "Sales", 13000, 94, "2018-09-10"),
    ("Sara Haddad", "سارة حداد", "Senior Sales Executive", "Sales", 8200, 89, "2020-01-20"),
    ("Yousef Karim", "يوسف كريم", "Sales Executive", "Sales", 6800, 78, "2021-05-03"),
    ("Nadia Salem", "نادية سالم", "Sales Executive", "Sales", 6900, 84, "2021-07-19"),
    ("Ahmed Fadel", "أحمد فاضل", "Warehouse Manager", "Warehouse", 7500, 81, "2019-11-02"),
    ("Mona Aziz", "منى عزيز", "Procurement Officer", "Procurement", 7200, 87, "2020-08-25"),
    ("Tariq Zayed", "طارق زايد", "IT Administrator", "IT", 8000, 85, "2020-02-14"),
    ("Rania Odeh", "رانيا عودة", "HR Manager", "Human Resources", 9000, 90, "2019-04-08"),
    ("Bilal Sami", "بلال سامي", "Accountant", "Finance", 6500, 76, "2022-03-11"),
    ("Huda Bakr", "هدى بكر", "Customer Service Lead", "Operations", 6200, 83, "2021-10-30"),
]

# name, contact, phone, email, category, rating, balance
SUPPLIERS = [
    ("TechSource Global", "David Chen", "+971-4-555-0101", "sales@techsource.example", "Electronics", 4.6, 42000),
    ("Eastern Electronics Ltd.", "Rami Halabi", "+962-6-555-0212", "orders@easternelec.example", "Electronics", 4.1, 28000),
    ("FMCG Wholesale Partners", "Hassan Idris", "+966-11-555-0323", "b2b@fmcgw.example", "Commercial Goods", 4.4, 15500),
    ("GreenFields Foods", "Aisha Rahman", "+20-2-555-0434", "trade@greenfields.example", "Commercial Goods", 3.9, 9800),
    ("HomeTech Distributors", "Carlos Mendes", "+34-91-555-0545", "supply@hometech.example", "Home Appliances", 4.3, 33500),
    ("CoolAir Systems", "Yara Khoury", "+961-1-555-0656", "info@coolair.example", "Home Appliances", 4.0, 21000),
    ("AutoParts Direct", "Mustafa Adel", "+90-212-555-0767", "export@autoparts.example", "Spare Parts", 4.5, 12700),
    ("Mena Spare Trading", "Sami Farouk", "+964-1-555-0878", "sales@menaspare.example", "Spare Parts", 3.8, 6400),
]

# Monthly operational expenses keyed by month, then category.
# Categories: Rent, Salaries, Marketing, Utilities, Logistics.
EXPENSE_BASE = {
    "Rent": 18000,
    "Salaries": 52000,
    "Marketing": 18000,
    "Utilities": 7200,
    "Logistics": 9600,
}

# Deterministic month-over-month variation factors.
EXPENSE_VARIATION = {
    "Rent": [1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
    "Salaries": [0.97, 1.0, 1.02, 1.01, 1.03, 1.05],
    "Marketing": [0.85, 0.9, 0.95, 1.0, 1.1, 1.15],
    "Utilities": [0.82, 0.95, 1.12, 1.2, 1.05, 0.9],
    "Logistics": [0.9, 0.94, 1.0, 1.05, 1.08, 1.12],
}

# Revenue targets per month (management plan).
TARGETS = [320000, 330000, 345000, 355000, 365000, 380000]


# ---------------------------------------------------------------------------
# Connection helpers
# ---------------------------------------------------------------------------

def get_connection() -> sqlite3.Connection:
    """Return a SQLite connection with row access by column name."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    sku           TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL,
    name_ar       TEXT,
    category      TEXT    NOT NULL,
    cost          REAL    NOT NULL,
    price         REAL    NOT NULL,
    stock         INTEGER NOT NULL,
    reorder_point INTEGER NOT NULL,
    velocity      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS employees (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    name_ar           TEXT,
    role              TEXT NOT NULL,
    department        TEXT NOT NULL,
    salary            REAL NOT NULL,
    performance_score REAL NOT NULL,
    hire_date         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppliers (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL,
    contact  TEXT,
    phone    TEXT,
    email    TEXT,
    category TEXT,
    rating   REAL DEFAULT 0,
    balance  REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice        TEXT NOT NULL UNIQUE,
    customer       TEXT NOT NULL,
    date           TEXT NOT NULL,
    total          REAL NOT NULL,
    payment_method TEXT NOT NULL,
    employee_id    INTEGER REFERENCES employees(id),
    status         TEXT NOT NULL DEFAULT 'Paid'
);

CREATE TABLE IF NOT EXISTS sale_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id    INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    qty        INTEGER NOT NULL,
    unit_price REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    po_number   TEXT NOT NULL UNIQUE,
    supplier_id INTEGER REFERENCES suppliers(id),
    product_id  INTEGER REFERENCES products(id),
    qty         INTEGER NOT NULL,
    unit_cost   REAL NOT NULL,
    date        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'Pending'
);

CREATE TABLE IF NOT EXISTS expenses (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    amount   REAL NOT NULL,
    month    TEXT NOT NULL,
    notes    TEXT
);

CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);
CREATE INDEX IF NOT EXISTS idx_expenses_month ON expenses(month);
"""


# ---------------------------------------------------------------------------
# Seed helpers
# ---------------------------------------------------------------------------

def _month_days(month: str) -> list[str]:
    """Return every ISO date string inside a 'YYYY-MM' month."""
    year, mon = (int(x) for x in month.split("-"))
    first = date(year, mon, 1)
    if mon == 12:
        nxt = date(year + 1, 1, 1)
    else:
        nxt = date(year, mon + 1, 1)
    days = []
    d = first
    while d < nxt:
        days.append(d.isoformat())
        d += timedelta(days=1)
    return days


def _weighted_product_ids(products, rnd):
    """Precompute a weighted sampling list where cheaper/faster SKUs sell more."""
    ids, weights = [], []
    for p in products:
        ids.append(p["id"])
        weights.append(max(1, p["velocity"]))
    return ids, weights


def seed_database(conn: sqlite3.Connection) -> None:
    """Populate all tables with a deterministic, realistic demo dataset."""
    rnd = random.Random(RANDOM_SEED)
    cur = conn.cursor()

    # --- Products ----------------------------------------------------------
    cur.executemany(
        """INSERT INTO products (sku, name, name_ar, category, cost, price, stock, reorder_point, velocity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        PRODUCTS,
    )

    # --- Employees ---------------------------------------------------------
    cur.executemany(
        """INSERT INTO employees (name, name_ar, role, department, salary, performance_score, hire_date)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        EMPLOYEES,
    )

    # --- Suppliers ---------------------------------------------------------
    cur.executemany(
        """INSERT INTO suppliers (name, contact, phone, email, category, rating, balance)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        SUPPLIERS,
    )

    # --- Expenses ----------------------------------------------------------
    expense_rows = []
    for mi, month in enumerate(MONTHS):
        for cat, base in EXPENSE_BASE.items():
            factor = EXPENSE_VARIATION[cat][mi]
            # small deterministic jitter to avoid perfectly flat lines
            jitter = 1 + rnd.uniform(-0.03, 0.03)
            amount = round(base * factor * jitter, 2)
            expense_rows.append((cat, amount, month, f"{cat} - {month}"))
    cur.executemany(
        "INSERT INTO expenses (category, amount, month, notes) VALUES (?, ?, ?, ?)",
        expense_rows,
    )

    # --- Sales + sale items ------------------------------------------------
    products = [dict(r) for r in cur.execute(
        "SELECT id, price, cost, velocity FROM products").fetchall()]
    prod_by_id = {p["id"]: p for p in products}
    ids, weights = _weighted_product_ids(products, rnd)

    # Sales staff (for employee attribution).
    sales_staff = [r["id"] for r in cur.execute(
        "SELECT id FROM employees WHERE department = 'Sales'").fetchall()]

    invoice_seq = 1000

    for mi, month in enumerate(MONTHS):
        days = _month_days(month)
        # Higher volume in later months (growth trend).
        n_invoices = 88 + mi * 6 + rnd.randint(-5, 5)
        for _ in range(n_invoices):
            invoice_seq += 1
            invoice = f"INV-{invoice_seq}"
            day = rnd.choice(days)
            customer = rnd.choice(CUSTOMERS)
            method = rnd.choices(PAYMENT_METHODS, weights=PAYMENT_WEIGHTS, k=1)[0]
            employee_id = rnd.choice(sales_staff) if sales_staff else None

            # 1-4 line items, sampled by velocity weighting.
            n_items = rnd.choices([1, 2, 3, 4], weights=[0.45, 0.30, 0.18, 0.07], k=1)[0]
            chosen = set()
            lines = []
            total = 0.0
            for _ in range(n_items):
                pid = rnd.choices(ids, weights=weights, k=1)[0]
                if pid in chosen:
                    continue
                chosen.add(pid)
                prod = prod_by_id[pid]
                # Cheaper goods sell in larger quantities.
                if prod["price"] < 50:
                    qty = rnd.randint(10, 120)
                elif prod["price"] < 200:
                    qty = rnd.randint(3, 40)
                else:
                    qty = rnd.randint(1, 12)
                unit_price = round(prod["price"] * rnd.choice([1.0, 1.0, 0.97, 0.95]), 2)
                total += qty * unit_price
                lines.append((pid, qty, unit_price))
            if not lines:
                continue

            cur.execute(
                """INSERT INTO sales (invoice, customer, date, total, payment_method, employee_id, status)
                   VALUES (?, ?, ?, ?, ?, ?, 'Paid')""",
                (invoice, customer, day, round(total, 2), method, employee_id),
            )
            sale_id = cur.lastrowid
            cur.executemany(
                "INSERT INTO sale_items (sale_id, product_id, qty, unit_price) VALUES (?, ?, ?, ?)",
                [(sale_id, pid, qty, price) for pid, qty, price in lines],
            )

    # --- Purchase orders ---------------------------------------------------
    supplier_ids = [r["id"] for r in cur.execute("SELECT id FROM suppliers").fetchall()]
    po_seq = 5000
    statuses = ["Received", "Received", "Approved", "Pending", "Pending", "Cancelled"]
    today = date(2026, 10, 11)
    for _ in range(24):
        po_seq += 1
        prod = prod_by_id[rnd.choices(ids, weights=weights, k=1)[0]]
        qty = rnd.randint(20, 300)
        unit_cost = round(prod["cost"] * rnd.uniform(0.97, 1.03), 2)
        offset = rnd.randint(0, 150)
        po_date = (today - timedelta(days=offset)).isoformat()
        cur.execute(
            """INSERT INTO purchase_orders (po_number, supplier_id, product_id, qty, unit_cost, date, status)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (f"PO-{po_seq}", rnd.choice(supplier_ids), prod["id"], qty, unit_cost, po_date,
             rnd.choice(statuses)),
        )

    conn.commit()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def init_db(reset: bool = False) -> None:
    """Create the schema and seed the database.

    Parameters
    ----------
    reset : bool
        When True, drop all tables first (full rebuild).
    """
    conn = get_connection()
    try:
        if reset:
            cur = conn.cursor()
            for table in ("sale_items", "sales", "purchase_orders", "expenses",
                          "products", "employees", "suppliers"):
                cur.execute(f"DROP TABLE IF EXISTS {table}")
            conn.commit()

        conn.executescript(SCHEMA)

        # Seed only when the products table is empty.
        count = conn.execute("SELECT COUNT(*) AS c FROM products").fetchone()["c"]
        if count == 0:
            seed_database(conn)
            print(f"[database] Seed data written to {DB_PATH}")
        else:
            print(f"[database] Existing data detected ({count} products) - skipping seed")
    finally:
        conn.close()


if __name__ == "__main__":
    import sys

    init_db(reset="--reset" in sys.argv)
    print("[database] Ready.")
