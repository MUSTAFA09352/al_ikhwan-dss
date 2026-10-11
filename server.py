"""
server.py
=========
Al-Ikhwan Company - Executive Decision Support System (DSS)
Flask REST API + static file server.

Endpoints
---------
    GET  /                       -> serves index.html
    GET  /style.css, /app.js     -> static assets
    GET  /api/health             -> service + DB status
    GET  /api/overview           -> executive KPIs, monthly series, category mix
    GET  /api/sales              -> invoices, trend, top items, payment mix
    GET  /api/products           -> catalog + inventory status + summary
    POST /api/products/reorder   -> create a purchase-order (reorder request)
    POST /api/products/add       -> create a new product
    GET  /api/employees          -> directory, payroll, performance
    POST /api/employees/add      -> create a new employee
    GET  /api/suppliers          -> suppliers, purchase orders, spend
    GET  /api/finance            -> expenses, gross vs net profit, monthly P&L
    POST /api/sales/add          -> record a sale (header + items, stock -qty)

Run::

    python database.py      # build/seed the database (first run)
    python server.py        # start the API + web app on http://127.0.0.1:5000
"""

from __future__ import annotations

import os
from datetime import date, datetime

from flask import Flask, jsonify, request, send_from_directory

from database import DB_PATH, get_connection, init_db

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__)


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def query(sql: str, args: tuple = ()) -> list[dict]:
    """Run a SELECT and return a list of dict rows."""
    conn = get_connection()
    try:
        rows = conn.execute(sql, args).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def query_one(sql: str, args: tuple = ()) -> dict | None:
    """Run a SELECT and return the first row (or None)."""
    conn = get_connection()
    try:
        row = conn.execute(sql, args).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def r2(value: float | None) -> float:
    """Round to two decimals, guarding against None."""
    return round(value or 0, 2)


# ---------------------------------------------------------------------------
# Product / inventory classification (single source of truth)
# ---------------------------------------------------------------------------
#   reorder : stock on hand is at or below the reorder point
#   slow    : more than SLOW_COVERAGE months of stock coverage
#   optimal : safety cover within normal operating band
SLOW_COVERAGE_MONTHS = 6


def classify(stock: int, reorder_point: int, velocity: int) -> dict:
    coverage = (stock / velocity) if velocity else 999
    if stock <= reorder_point:
        return {"key": "reorder", "label": "Immediate Reorder", "coverage": round(coverage, 1)}
    if coverage > SLOW_COVERAGE_MONTHS:
        return {"key": "slow", "label": "Slow-Moving / Liquidate", "coverage": round(coverage, 1)}
    return {"key": "optimal", "label": "Stock Optimal", "coverage": round(coverage, 1)}


# ---------------------------------------------------------------------------
# CORS (lets the UI also be opened from file:// during development)
# ---------------------------------------------------------------------------

@app.after_request
def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


# ---------------------------------------------------------------------------
# Static file serving
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/style.css")
def stylesheet():
    return send_from_directory(BASE_DIR, "style.css")


@app.route("/app.js")
def script():
    return send_from_directory(BASE_DIR, "app.js")


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health():
    counts = query_one(
        """SELECT
             (SELECT COUNT(*) FROM products)   AS products,
             (SELECT COUNT(*) FROM sales)      AS sales,
             (SELECT COUNT(*) FROM employees)  AS employees,
             (SELECT COUNT(*) FROM suppliers)  AS suppliers,
             (SELECT COUNT(*) FROM expenses)   AS expenses"""
    )
    return jsonify(status="ok", database=os.path.basename(DB_PATH), counts=counts)


# ---------------------------------------------------------------------------
# 1. OVERVIEW DASHBOARD
# ---------------------------------------------------------------------------

@app.get("/api/overview")
def overview():
    months = [r["month"] for r in query(
        "SELECT DISTINCT substr(date,1,7) AS month FROM sales ORDER BY month")]
    current = months[-1]
    previous = months[-2] if len(months) > 1 else current

    # --- Revenue + COGS per month -----------------------------------------
    fin = {
        r["month"]: r for r in query(
            """SELECT substr(s.date,1,7) AS month,
                      ROUND(SUM(si.qty * si.unit_price), 2) AS revenue,
                      ROUND(SUM(si.qty * p.cost), 2)         AS cogs
               FROM sale_items si
               JOIN sales s    ON si.sale_id   = s.id
               JOIN products p ON si.product_id = p.id
               GROUP BY month""")
    }
    exp_by_month = {
        r["month"]: r2(r["total"]) for r in query(
            "SELECT month, SUM(amount) AS total FROM expenses GROUP BY month")
    }

    series = []
    for m in months:
        revenue = r2(fin.get(m, {}).get("revenue"))
        cogs = r2(fin.get(m, {}).get("cogs"))
        expenses = r2(exp_by_month.get(m))
        gross = r2(revenue - cogs)
        series.append({
            "month": m,
            "revenue": revenue,
            "cogs": cogs,
            "expenses": expenses,
            "gross_profit": gross,
            "net_profit": r2(gross - expenses),
        })

    cur = series[-1]
    prev = series[-2] if len(series) > 1 else cur

    # --- Management targets -------------------------------------------------
    targets = {"2026-05": 320000, "2026-06": 330000, "2026-07": 345000,
               "2026-08": 355000, "2026-09": 365000, "2026-10": 380000}

    target = targets.get(current, round(cur["revenue"]))
    attainment = (cur["revenue"] / target * 100) if target else 0
    margin = (cur["net_profit"] / cur["revenue"] * 100) if cur["revenue"] else 0
    optrend = ((cur["revenue"] - prev["revenue"]) / prev["revenue"] * 100) if prev["revenue"] else 0

    # --- Low-stock alerts ---------------------------------------------------
    products = query("SELECT stock, reorder_point, velocity FROM products")
    low_stock = sum(1 for p in products if p["stock"] <= p["reorder_point"])

    # --- Category revenue (current month) -----------------------------------
    cat_rows = query(
        """SELECT p.category AS category,
                  ROUND(SUM(si.qty * si.unit_price), 2) AS revenue
           FROM sale_items si
           JOIN sales s    ON si.sale_id   = s.id
           JOIN products p ON si.product_id = p.id
           WHERE substr(s.date,1,7) = ?
           GROUP BY p.category
           ORDER BY revenue DESC""", (current,))
    categories = [{"category": r["category"], "revenue": r2(r["revenue"])} for r in cat_rows]

    # --- Liquidity / collections -------------------------------------------
    pay_rows = query(
        """SELECT payment_method AS method, ROUND(SUM(total),2) AS amount
           FROM sales WHERE date >= date(?, '-90 day') GROUP BY method""",
        (date.today().isoformat(),))
    pay_total = sum(r["amount"] for r in pay_rows) or 1
    credit_share = next((r["amount"] / pay_total for r in pay_rows if r["method"] == "Credit"), 0.0)
    immediate_share = 1 - credit_share
    # 72% of credit sales considered collected within terms.
    collection_efficiency = (immediate_share + credit_share * 0.72) * 100
    receivables = r2(cur["revenue"] * credit_share * 0.9)
    daily_credit = (cur["revenue"] * credit_share) / 30 if cur["revenue"] else 0
    dso = (receivables / daily_credit) if daily_credit else 0

    # --- Simulation model inputs (kept consistent with the DB) --------------
    units = r2(query_one(
        """SELECT SUM(si.qty) AS v
           FROM sale_items si JOIN sales s ON si.sale_id = s.id
           WHERE substr(s.date,1,7) = ?""", (current,))["v"])
    marketing_m = r2(query_one(
        "SELECT amount AS v FROM expenses WHERE category='Marketing' AND month = ?",
        (current,))["v"])
    simulation = {
        "baselineRevenue": cur["revenue"],
        "baselineUnits": units,
        "avgListPrice": r2(cur["revenue"] / units) if units else 0,
        "unitVariableCost": r2(cur["cogs"] / units) if units else 0,
        "marketingBaseline": marketing_m,
        "fixedOpex": r2(cur["expenses"] - marketing_m),
    }

    return jsonify({
        "currentMonth": current,
        "kpis": {
            "revenue": cur["revenue"],
            "revenueTrend": r2(optrend),
            "netProfit": cur["net_profit"],
            "grossProfit": cur["gross_profit"],
            "expenses": cur["expenses"],
            "margin": r2(margin),
            "target": target,
            "attainment": r2(attainment),
            "lowStock": low_stock,
            "collectionEfficiency": r2(collection_efficiency),
            "dso": r2(dso),
            "receivables": receivables,
        },
        "series": series,
        "targets": targets,
        "categories": categories,
        "simulation": simulation,
    })


# ---------------------------------------------------------------------------
# 2. SALES MODULE
# ---------------------------------------------------------------------------

@app.get("/api/sales")
def sales():
    # Invoice list (most recent first, capped for payload size).
    invoices = query(
        """SELECT s.id, s.invoice, s.customer, s.date, ROUND(s.total,2) AS total,
                  s.payment_method, s.status, e.name AS employee
           FROM sales s
           LEFT JOIN employees e ON s.employee_id = e.id
           ORDER BY s.date DESC, s.id DESC
           LIMIT 80""")

    # Monthly trend (revenue + invoice count).
    trend = query(
        """SELECT substr(date,1,7) AS month,
                  ROUND(SUM(total),2) AS revenue,
                  COUNT(*)            AS invoices
           FROM sales GROUP BY month ORDER BY month""")

    # Top selling items by revenue.
    top_items = query(
        """SELECT p.name, p.name_ar, p.category,
                  SUM(si.qty)                           AS units,
                  ROUND(SUM(si.qty * si.unit_price), 2) AS revenue
           FROM sale_items si
           JOIN products p ON si.product_id = p.id
           GROUP BY p.id
           ORDER BY revenue DESC
           LIMIT 8""")

    # Payment method mix.
    payment_mix = query(
        """SELECT payment_method AS method,
                  ROUND(SUM(total),2) AS amount,
                  COUNT(*)            AS count
           FROM sales GROUP BY payment_method ORDER BY amount DESC""")

    stats = query_one(
        """SELECT COUNT(*) AS invoices,
                  ROUND(SUM(total),2) AS revenue,
                  ROUND(AVG(total),2) AS avg_order
           FROM sales""")

    credit_outstanding = query_one(
        "SELECT ROUND(SUM(total),2) AS v FROM sales WHERE payment_method='Credit'")

    return jsonify({
        "invoices": invoices,
        "trend": trend,
        "topItems": top_items,
        "paymentMix": payment_mix,
        "stats": {
            "invoices": stats["invoices"],
            "revenue": r2(stats["revenue"]),
            "avgOrder": r2(stats["avg_order"]),
            "creditOutstanding": r2(credit_outstanding["v"]),
        },
    })


# ---------------------------------------------------------------------------
# 3. INVENTORY & PRODUCTS
# ---------------------------------------------------------------------------

@app.get("/api/products")
def products():
    rows = query("SELECT * FROM products ORDER BY category, name")
    catalog = []
    summary = {"total": len(rows), "reorder": 0, "slow": 0, "optimal": 0,
               "stockValue": 0.0, "retailValue": 0.0}
    for p in rows:
        status = classify(p["stock"], p["reorder_point"], p["velocity"])
        summary[status["key"]] += 1
        summary["stockValue"] += p["stock"] * p["cost"]
        summary["retailValue"] += p["stock"] * p["price"]
        catalog.append({
            **p,
            "status": status,
            "stock_value": r2(p["stock"] * p["cost"]),
            "margin": r2(((p["price"] - p["cost"]) / p["price"] * 100) if p["price"] else 0),
        })
    summary["stockValue"] = r2(summary["stockValue"])
    summary["retailValue"] = r2(summary["retailValue"])
    return jsonify({"catalog": catalog, "summary": summary})


@app.post("/api/products/reorder")
def create_reorder():
    """Create an immediate purchase-order request for a product."""
    data = request.get_json(force=True, silent=True) or {}
    product_id = data.get("product_id")
    qty = int(data.get("qty") or 0)

    if not product_id or qty <= 0:
        return jsonify(error="product_id and a positive qty are required"), 400

    product = query_one("SELECT * FROM products WHERE id = ?", (product_id,))
    if not product:
        return jsonify(error="Product not found"), 404

    # Suggest a default order quantity covering ~2 months of demand if not given.
    if qty <= 0:
        qty = max(20, product["velocity"] * 2)

    # Pick a supplier from the matching category (fallback: first supplier).
    supplier = query_one(
        "SELECT id, name FROM suppliers WHERE category = ? ORDER BY rating DESC LIMIT 1",
        (product["category"],)) or query_one(
        "SELECT id, name FROM suppliers ORDER BY rating DESC LIMIT 1")

    next_seq = (query_one("SELECT COUNT(*) AS c FROM purchase_orders")["c"] or 0) + 5001
    po_number = f"PO-{next_seq}"
    today = date.today().isoformat()

    conn = get_connection()
    try:
        cur = conn.execute(
            """INSERT INTO purchase_orders (po_number, supplier_id, product_id, qty, unit_cost, date, status)
               VALUES (?, ?, ?, ?, ?, ?, 'Pending')""",
            (po_number, supplier["id"] if supplier else None, product_id, qty,
             product["cost"], today))
        conn.commit()
        po_id = cur.lastrowid
    finally:
        conn.close()

    return jsonify({
        "message": f"Reorder request {po_number} created",
        "purchaseOrder": {
            "id": po_id,
            "po_number": po_number,
            "product": product["name"],
            "supplier": supplier["name"] if supplier else "Unassigned",
            "qty": qty,
            "unit_cost": product["cost"],
            "total": r2(qty * product["cost"]),
            "date": today,
            "status": "Pending",
        }
    }), 201


# ---------------------------------------------------------------------------
# 4. EMPLOYEES & HR
# ---------------------------------------------------------------------------

@app.get("/api/employees")
def employees():
    current = query_one("SELECT MAX(substr(date,1,7)) AS m FROM sales")["m"]

    directory = query(
        """SELECT e.id, e.name, e.name_ar, e.role, e.department, e.salary,
                  e.performance_score, e.hire_date,
                  COALESCE(s.month_sales, 0) AS month_sales,
                  COALESCE(s.deals, 0)       AS month_deals
           FROM employees e
           LEFT JOIN (
               SELECT employee_id,
                      ROUND(SUM(total),2) AS month_sales,
                      COUNT(*)            AS deals
               FROM sales
               WHERE substr(date,1,7) = ?
               GROUP BY employee_id
           ) s ON s.employee_id = e.id
           ORDER BY e.performance_score DESC""", (current,))

    payroll = query_one("SELECT ROUND(SUM(salary),2) AS total, COUNT(*) AS headcount FROM employees")
    avg_perf = query_one("SELECT ROUND(AVG(performance_score),1) AS v FROM employees")

    by_dept = query(
        """SELECT department,
                  COUNT(*)                 AS headcount,
                  ROUND(SUM(salary),2)     AS payroll,
                  ROUND(AVG(performance_score),1) AS avg_performance
           FROM employees GROUP BY department ORDER BY payroll DESC""")

    return jsonify({
        "currentMonth": current,
        "directory": directory,
        "summary": {
            "headcount": payroll["headcount"],
            "payrollTotal": r2(payroll["total"]),
            "avgPerformance": avg_perf["v"],
        },
        "byDepartment": by_dept,
    })


# ---------------------------------------------------------------------------
# 5. SUPPLIERS & PURCHASES
# ---------------------------------------------------------------------------

@app.get("/api/suppliers")
def suppliers():
    rows = query(
        """SELECT s.*,
                  COALESCE(po.spend, 0)  AS total_spend,
                  COALESCE(po.orders, 0) AS order_count
           FROM suppliers s
           LEFT JOIN (
               SELECT supplier_id,
                      ROUND(SUM(qty * unit_cost),2) AS spend,
                      COUNT(*)                       AS orders
               FROM purchase_orders GROUP BY supplier_id
           ) po ON po.supplier_id = s.id
           ORDER BY total_spend DESC""")

    orders = query(
        """SELECT po.id, po.po_number, po.date, po.qty, po.unit_cost, po.status,
                  ROUND(po.qty * po.unit_cost, 2) AS total,
                  s.name AS supplier, p.name AS product
           FROM purchase_orders po
           LEFT JOIN suppliers s ON po.supplier_id = s.id
           LEFT JOIN products  p ON po.product_id  = p.id
           ORDER BY po.date DESC, po.id DESC
           LIMIT 60""")

    total_spend = query_one("SELECT ROUND(SUM(qty*unit_cost),2) AS v FROM purchase_orders")
    open_pos = query_one(
        "SELECT COUNT(*) AS v FROM purchase_orders WHERE status IN ('Pending','Approved')")
    spend_by_supplier = query(
        """SELECT s.name AS supplier, ROUND(SUM(po.qty*po.unit_cost),2) AS spend
           FROM purchase_orders po JOIN suppliers s ON po.supplier_id = s.id
           GROUP BY s.id ORDER BY spend DESC""")

    return jsonify({
        "suppliers": rows,
        "orders": orders,
        "summary": {
            "suppliers": len(rows),
            "totalSpend": r2(total_spend["v"]),
            "openOrders": open_pos["v"],
        },
        "spendBySupplier": spend_by_supplier,
    })


# ---------------------------------------------------------------------------
# 6. FINANCIAL REPORTS
# ---------------------------------------------------------------------------

@app.get("/api/finance")
def finance():
    months = [r["month"] for r in query(
        "SELECT DISTINCT month FROM expenses ORDER BY month")]

    expenses = query(
        """SELECT category, ROUND(SUM(amount),2) AS amount
           FROM expenses GROUP BY category ORDER BY amount DESC""")
    total_expenses = sum(e["amount"] for e in expenses)

    by_month = {
        r["month"]: r2(r["total"]) for r in query(
            "SELECT month, SUM(amount) AS total FROM expenses GROUP BY month")
    }

    # Revenue, COGS and gross profit per month.
    fin = {
        r["month"]: r for r in query(
            """SELECT substr(s.date,1,7) AS month,
                      ROUND(SUM(si.qty * si.unit_price),2) AS revenue,
                      ROUND(SUM(si.qty * p.cost),2)         AS cogs
               FROM sale_items si
               JOIN sales s    ON si.sale_id   = s.id
               JOIN products p ON si.product_id = p.id
               GROUP BY month""")
    }

    monthly = []
    for m in months:
        revenue = r2(fin.get(m, {}).get("revenue"))
        cogs = r2(fin.get(m, {}).get("cogs"))
        gross = r2(revenue - cogs)
        expenses_m = r2(by_month.get(m))
        monthly.append({
            "month": m,
            "revenue": revenue,
            "cogs": cogs,
            "gross_profit": gross,
            "expenses": expenses_m,
            "net_profit": r2(gross - expenses_m),
        })

    cur = monthly[-1] if monthly else {}
    detail = query("SELECT category, amount, month, notes FROM expenses ORDER BY month DESC, category")

    net_margin = (cur.get("net_profit", 0) / cur["revenue"] * 100) if cur.get("revenue") else 0
    gross_margin = (cur.get("gross_profit", 0) / cur["revenue"] * 100) if cur.get("revenue") else 0

    return jsonify({
        "expenseBreakdown": expenses,
        "totalExpenses": r2(total_expenses),
        "monthly": monthly,
        "detail": detail,
        "summary": {
            "revenue": cur.get("revenue", 0),
            "cogs": cur.get("cogs", 0),
            "grossProfit": cur.get("gross_profit", 0),
            "grossMargin": r2(gross_margin),
            "expenses": cur.get("expenses", 0),
            "netProfit": cur.get("net_profit", 0),
            "netMargin": r2(net_margin),
        },
    })


# ---------------------------------------------------------------------------
# 7. CREATE / ADD MODULES (permanent writes into SQLite)
# ---------------------------------------------------------------------------

@app.post("/api/products/add")
def add_product():
    """Create a new product catalogue entry."""
    data = request.get_json(force=True, silent=True) or {}
    sku = str(data.get("sku", "")).strip()
    name = str(data.get("name", "")).strip()
    name_ar = str(data.get("name_ar", "")).strip()
    category = str(data.get("category", "")).strip() or "General"
    cost = float(data.get("cost") or 0)
    price = float(data.get("price") or 0)
    stock = int(data.get("stock") or 0)
    reorder_point = int(data.get("reorder_point") or 0)
    velocity = int(data.get("velocity") or 0)

    if not sku or not name:
        return jsonify(error="sku and name are required"), 400
    if cost < 0 or price < 0 or stock < 0 or reorder_point < 0 or velocity < 0:
        return jsonify(error="numeric fields must be non-negative"), 400
    if query_one("SELECT id FROM products WHERE sku = ?", (sku,)):
        return jsonify(error=f"SKU '{sku}' already exists"), 409

    conn = get_connection()
    try:
        cur = conn.execute(
            """INSERT INTO products (sku, name, name_ar, category, cost, price, stock, reorder_point, velocity)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (sku, name, name_ar, category, cost, price, stock, reorder_point, velocity))
        conn.commit()
        pid = cur.lastrowid
    finally:
        conn.close()

    product = query_one("SELECT * FROM products WHERE id = ?", (pid,))
    status = classify(product["stock"], product["reorder_point"], product["velocity"])
    return jsonify(message=f"Product '{name}' added to catalogue",
                   product={**product, "status": status,
                            "stock_value": r2(product["stock"] * product["cost"])}), 201


@app.post("/api/sales/add")
def add_sale():
    """Record a sale transaction (header + line items) and decrement stock."""
    data = request.get_json(force=True, silent=True) or {}
    customer = str(data.get("customer", "")).strip() or "Cash Customer"
    date_str = str(data.get("date", "")).strip()
    method = str(data.get("payment_method", "")).strip() or "Cash"
    employee_id = data.get("employee_id")
    raw_items = data.get("items") or []

    if not raw_items:
        return jsonify(error="At least one item is required"), 400

    # Default to the latest recorded date so new sales surface at the top of
    # "Recent Invoices" and stay inside the dashboard's timeline.
    if not date_str:
        latest = query_one("SELECT MAX(date) FROM sales")
        date_str = (latest and latest[0]) or date.today().isoformat()

    # Normalise + validate items first (no DB writes until everything is clean).
    clean = []
    for it in raw_items:
        try:
            pid = int(it.get("product_id"))
            qty = int(it.get("qty") or 0)
        except (TypeError, ValueError):
            continue
        if qty > 0:
            clean.append((pid, qty))
    if not clean:
        return jsonify(error="At least one valid item with qty > 0 is required"), 400

    conn = get_connection()
    try:
        lines = []
        for pid, qty in clean:
            row = conn.execute("SELECT * FROM products WHERE id = ?", (pid,)).fetchone()
            if not row:
                conn.rollback()
                return jsonify(error=f"Product id {pid} not found"), 400
            p = dict(row)
            lines.append({**p, "qty": qty, "unit_price": p["price"],
                          "subtotal": round(p["price"] * qty, 2)})

        total = round(sum(l["subtotal"] for l in lines), 2)
        if total <= 0:
            return jsonify(error="Transaction total must be positive"), 400

        if employee_id is not None:
            emp = conn.execute("SELECT id FROM employees WHERE id = ?", (employee_id,)).fetchone()
            if not emp:
                return jsonify(error="Sales employee not found"), 400

        max_id = conn.execute("SELECT COALESCE(MAX(id), 0) FROM sales").fetchone()[0]
        invoice = f"INV-{1001 + max_id}"

        cur = conn.execute(
            """INSERT INTO sales (invoice, customer, date, total, payment_method, employee_id, status)
               VALUES (?, ?, ?, ?, ?, ?, 'Paid')""",
            (invoice, customer, date_str, total, method, employee_id))
        sale_id = cur.lastrowid

        for l in lines:
            conn.execute(
                "INSERT INTO sale_items (sale_id, product_id, qty, unit_price) VALUES (?, ?, ?, ?)",
                (sale_id, l["id"], l["qty"], l["unit_price"]))
            # Realistic: sold stock leaves the shelf (never below zero).
            conn.execute(
                "UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?", (l["qty"], l["id"]))
        conn.commit()
    finally:
        conn.close()

    return jsonify(message=f"Invoice {invoice} recorded", sale={
        "invoice": invoice, "customer": customer, "date": date_str,
        "total": total, "payment_method": method, "items": len(clean),
    }), 201


@app.post("/api/employees/add")
def add_employee():
    """Create a new staff record."""
    data = request.get_json(force=True, silent=True) or {}
    name = str(data.get("name", "")).strip()
    role = str(data.get("role", "")).strip()
    department = str(data.get("department", "")).strip() or "Operations"
    name_ar = str(data.get("name_ar", "")).strip()
    salary = float(data.get("salary") or 0)
    performance = float(data.get("performance_score") or 80)
    hire_date = str(data.get("hire_date", "")).strip() or date.today().isoformat()

    if not name or not role:
        return jsonify(error="name and role are required"), 400
    if salary < 0:
        return jsonify(error="salary must be non-negative"), 400
    performance = max(0.0, min(100.0, performance))

    conn = get_connection()
    try:
        cur = conn.execute(
            """INSERT INTO employees (name, name_ar, role, department, salary, performance_score, hire_date)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (name, name_ar, role, department, salary, performance, hire_date))
        conn.commit()
        eid = cur.lastrowid
    finally:
        conn.close()

    employee = query_one("SELECT * FROM employees WHERE id = ?", (eid,))
    return jsonify(message=f"Employee '{name}' added", employee=employee), 201


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

import os

if __name__ == "main":
    init_db()  # ensure schema + seed exist
    port = int(os.environ.get("PORT", 5000))
    print(f"[server] Al-Ikhwan DSS running on port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
