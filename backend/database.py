import sqlite3
import os
import urllib.parse
from dotenv import load_dotenv
import bcrypt

# Load environment variables from .env file
load_dotenv()

if os.environ.get("VERCEL") or os.environ.get("VERCEL_ENV"):
    DB_PATH = "/tmp/medsafe.db"
else:
    DB_PATH = os.path.join(os.path.dirname(__file__), "medsafe.db")

def ensure_db_copied():
    if os.environ.get("VERCEL") or os.environ.get("VERCEL_ENV"):
        if not os.path.exists(DB_PATH):
            seed_db = os.path.join(os.path.dirname(__file__), "medsafe.db")
            if os.path.exists(seed_db):
                try:
                    import shutil
                    shutil.copy2(seed_db, DB_PATH)
                except Exception:
                    pass

DRUG_PRICING_DATABASE = {
    "ibuprofen": [
        {"name": "Brufen 400 (Brand)", "pharmacy": "Apollo Pharmacy", "price": 35.00, "quantity": "15 tablets (400mg)", "unit_price": 2.33, "link": "https://www.apollopharmacy.in/search?q=Brufen+400"},
        {"name": "Brufen 400 (Brand)", "pharmacy": "MedPlus", "price": 34.00, "quantity": "15 tablets (400mg)", "unit_price": 2.27, "link": "https://www.medplusmart.com/search/Brufen%20400"},
        {"name": "Generic Ibuprofen 400", "pharmacy": "Apollo Pharmacy", "price": 15.00, "quantity": "15 tablets (400mg)", "unit_price": 1.00, "link": "https://www.apollopharmacy.in/search?q=Ibuprofen+400"},
        {"name": "Generic Ibuprofen 400", "pharmacy": "MedPlus", "price": 14.00, "quantity": "15 tablets (400mg)", "unit_price": 0.93, "link": "https://www.medplusmart.com/search/Ibuprofen%20400"}
    ],
    "acetaminophen": [
        {"name": "Paracetamol (Generic)", "pharmacy": "Apollo Pharmacy", "price": 12.00, "quantity": "15 tablets (650mg)", "unit_price": 0.80, "link": "https://www.apollopharmacy.in/search?q=Paracetamol+650"},
        {"name": "Paracetamol (Generic)", "pharmacy": "MedPlus", "price": 11.00, "quantity": "15 tablets (650mg)", "unit_price": 0.73, "link": "https://www.medplusmart.com/search/Paracetamol%20650"},
        {"name": "Crocin 650 (Brand)", "pharmacy": "Apollo Pharmacy", "price": 30.00, "quantity": "15 tablets (650mg)", "unit_price": 2.00, "link": "https://www.apollopharmacy.in/search?q=Crocin+650"},
        {"name": "Calpol 650 (Brand)", "pharmacy": "MedPlus", "price": 31.00, "quantity": "15 tablets (650mg)", "unit_price": 2.07, "link": "https://www.medplusmart.com/search/Calpol%20650"}
    ],
    "cetirizine": [
        {"name": "Okacet (Brand)", "pharmacy": "Apollo Pharmacy", "price": 40.00, "quantity": "10 tablets (10mg)", "unit_price": 4.00, "link": "https://www.apollopharmacy.in/search?q=Okacet"},
        {"name": "Cetzine (Brand)", "pharmacy": "MedPlus", "price": 38.00, "quantity": "10 tablets (10mg)", "unit_price": 3.80, "link": "https://www.medplusmart.com/search/Cetzine"},
        {"name": "Generic Cetirizine 10", "pharmacy": "Apollo Pharmacy", "price": 18.00, "quantity": "10 tablets (10mg)", "unit_price": 1.80, "link": "https://www.apollopharmacy.in/search?q=Cetirizine+10"},
        {"name": "Generic Cetirizine 10", "pharmacy": "MedPlus", "price": 17.00, "quantity": "10 tablets (10mg)", "unit_price": 1.70, "link": "https://www.medplusmart.com/search/Cetirizine%2010"}
    ],
    "loratadine": [
        {"name": "Claridin (Brand)", "pharmacy": "Apollo Pharmacy", "price": 85.00, "quantity": "10 tablets (10mg)", "unit_price": 8.50, "link": "https://www.apollopharmacy.in/search?q=Claridin"},
        {"name": "Lorat (Brand)", "pharmacy": "MedPlus", "price": 82.00, "quantity": "10 tablets (10mg)", "unit_price": 8.20, "link": "https://www.medplusmart.com/search/Lorat"},
        {"name": "Generic Loratadine 10", "pharmacy": "Apollo Pharmacy", "price": 35.00, "quantity": "10 tablets (10mg)", "unit_price": 3.50, "link": "https://www.apollopharmacy.in/search?q=Loratadine+10"},
        {"name": "Generic Loratadine 10", "pharmacy": "MedPlus", "price": 33.00, "quantity": "10 tablets (10mg)", "unit_price": 3.30, "link": "https://www.medplusmart.com/search/Loratadine%2010"}
    ],
    "omeprazole": [
        {"name": "Omez 20 (Brand)", "pharmacy": "Apollo Pharmacy", "price": 120.00, "quantity": "15 capsules (20mg)", "unit_price": 8.00, "link": "https://www.apollopharmacy.in/search?q=Omez+20"},
        {"name": "Omee 20 (Brand)", "pharmacy": "MedPlus", "price": 115.00, "quantity": "15 capsules (20mg)", "unit_price": 7.67, "link": "https://www.medplusmart.com/search/Omee%2020"},
        {"name": "Generic Omeprazole 20", "pharmacy": "Apollo Pharmacy", "price": 45.00, "quantity": "15 capsules (20mg)", "unit_price": 3.00, "link": "https://www.apollopharmacy.in/search?q=Omeprazole+20"},
        {"name": "Generic Omeprazole 20", "pharmacy": "MedPlus", "price": 42.00, "quantity": "15 capsules (20mg)", "unit_price": 2.80, "link": "https://www.medplusmart.com/search/Omeprazole%2020"}
    ],
    "famotidine": [
        {"name": "Famocid 20 (Brand)", "pharmacy": "Apollo Pharmacy", "price": 15.00, "quantity": "14 tablets (20mg)", "unit_price": 1.07, "link": "https://www.apollopharmacy.in/search?q=Famocid+20"},
        {"name": "Famtac 20 (Brand)", "pharmacy": "MedPlus", "price": 14.50, "quantity": "14 tablets (20mg)", "unit_price": 1.04, "link": "https://www.medplusmart.com/search/Famtac%2020"},
        {"name": "Generic Famotidine 20", "pharmacy": "Apollo Pharmacy", "price": 7.00, "quantity": "14 tablets (20mg)", "unit_price": 0.50, "link": "https://www.apollopharmacy.in/search?q=Famotidine+20"},
        {"name": "Generic Famotidine 20", "pharmacy": "MedPlus", "price": 6.50, "quantity": "14 tablets (20mg)", "unit_price": 0.46, "link": "https://www.medplusmart.com/search/Famotidine%2020"}
    ],
    "dextromethorphan": [
        {"name": "TusQ-D Liquid (Brand)", "pharmacy": "Apollo Pharmacy", "price": 115.00, "quantity": "100 ml", "unit_price": 1.15, "link": "https://www.apollopharmacy.in/search?q=TusQ-D"},
        {"name": "Benadryl DR (Brand)", "pharmacy": "MedPlus", "price": 120.00, "quantity": "100 ml", "unit_price": 1.20, "link": "https://www.medplusmart.com/search/Benadryl%20DR"},
        {"name": "Generic Dextromethorphan Syrup", "pharmacy": "Apollo Pharmacy", "price": 55.00, "quantity": "100 ml", "unit_price": 0.55, "link": "https://www.apollopharmacy.in/search?q=Dextromethorphan+Syrup"},
        {"name": "Generic Dextromethorphan Syrup", "pharmacy": "MedPlus", "price": 52.00, "quantity": "100 ml", "unit_price": 0.52, "link": "https://www.medplusmart.com/search/Dextromethorphan%20Syrup"}
    ],
    "guaifenesin": [
        {"name": "Grilinctus-BM (Brand)", "pharmacy": "Apollo Pharmacy", "price": 95.00, "quantity": "100 ml", "unit_price": 0.95, "link": "https://www.apollopharmacy.in/search?q=Grilinctus-BM"},
        {"name": "Macbery XT (Brand)", "pharmacy": "MedPlus", "price": 92.00, "quantity": "100 ml", "unit_price": 0.92, "link": "https://www.medplusmart.com/search/Macbery%20XT"},
        {"name": "Generic Guaifenesin Liquid", "pharmacy": "Apollo Pharmacy", "price": 45.00, "quantity": "100 ml", "unit_price": 0.45, "link": "https://www.apollopharmacy.in/search?q=Guaifenesin+Liquid"},
        {"name": "Generic Guaifenesin Liquid", "pharmacy": "MedPlus", "price": 42.00, "quantity": "100 ml", "unit_price": 0.42, "link": "https://www.medplusmart.com/search/Guaifenesin%20Liquid"}
    ],
    "loperamide": [
        {"name": "Lopamide (Brand)", "pharmacy": "Apollo Pharmacy", "price": 25.00, "quantity": "10 tablets (2mg)", "unit_price": 2.50, "link": "https://www.apollopharmacy.in/search?q=Lopamide"},
        {"name": "Imodium (Brand)", "pharmacy": "MedPlus", "price": 45.00, "quantity": "10 tablets (2mg)", "unit_price": 4.50, "link": "https://www.medplusmart.com/search/Imodium"},
        {"name": "Generic Loperamide 2", "pharmacy": "Apollo Pharmacy", "price": 10.00, "quantity": "10 tablets (2mg)", "unit_price": 1.00, "link": "https://www.apollopharmacy.in/search?q=Loperamide+2"},
        {"name": "Generic Loperamide 2", "pharmacy": "MedPlus", "price": 9.50, "quantity": "10 tablets (2mg)", "unit_price": 0.95, "link": "https://www.medplusmart.com/search/Loperamide%202"}
    ],
    "bismuth subsalicylate": [
        {"name": "Pepto-Bismol (Brand Import)", "pharmacy": "Apollo Pharmacy", "price": 650.00, "quantity": "8 oz", "unit_price": 81.25, "link": "https://www.apollopharmacy.in/search?q=Pepto-Bismol"},
        {"name": "Pepto-Bismol (Brand Import)", "pharmacy": "MedPlus", "price": 630.00, "quantity": "8 oz", "unit_price": 78.75, "link": "https://www.medplusmart.com/search/Pepto-Bismol"},
        {"name": "Generic Stomach Relief Liquid", "pharmacy": "Apollo Pharmacy", "price": 180.00, "quantity": "8 oz", "unit_price": 22.50, "link": "https://www.apollopharmacy.in/search?q=Stomach+Relief"},
        {"name": "Generic Stomach Relief Liquid", "pharmacy": "MedPlus", "price": 170.00, "quantity": "8 oz", "unit_price": 21.25, "link": "https://www.medplusmart.com/search/Stomach%20Relief"}
    ],
    "ursodiol": [
        {"name": "Udiliv 300 (Brand)", "pharmacy": "Apollo Pharmacy", "price": 650.00, "quantity": "15 tablets (300mg)", "unit_price": 43.33, "link": "https://www.apollopharmacy.in/search?q=Udiliv+300"},
        {"name": "Ursocol 300 (Brand)", "pharmacy": "MedPlus", "price": 620.00, "quantity": "15 tablets (300mg)", "unit_price": 41.33, "link": "https://www.medplusmart.com/search/Ursocol%20300"},
        {"name": "Generic Ursodiol 300", "pharmacy": "Apollo Pharmacy", "price": 320.00, "quantity": "15 tablets (300mg)", "unit_price": 21.33, "link": "https://www.apollopharmacy.in/search?q=Ursodiol+300"},
        {"name": "Generic Ursodiol 300", "pharmacy": "MedPlus", "price": 310.00, "quantity": "15 tablets (300mg)", "unit_price": 20.67, "link": "https://www.medplusmart.com/search/Ursodiol%20300"}
    ],
    "dicyclomine": [
        {"name": "Cyclopam (Brand)", "pharmacy": "Apollo Pharmacy", "price": 60.00, "quantity": "10 tablets (20mg)", "unit_price": 6.00, "link": "https://www.apollopharmacy.in/search?q=Cyclopam"},
        {"name": "Colimex (Brand)", "pharmacy": "MedPlus", "price": 55.00, "quantity": "10 tablets (20mg)", "unit_price": 5.50, "link": "https://www.medplusmart.com/search/Colimex"},
        {"name": "Generic Dicyclomine 20", "pharmacy": "Apollo Pharmacy", "price": 25.00, "quantity": "10 tablets (20mg)", "unit_price": 2.50, "link": "https://www.apollopharmacy.in/search?q=Dicyclomine+20"},
        {"name": "Generic Dicyclomine 20", "pharmacy": "MedPlus", "price": 24.00, "quantity": "10 tablets (20mg)", "unit_price": 2.40, "link": "https://www.medplusmart.com/search/Dicyclomine%2020"}
    ],
    "aspirin": [
        {"name": "Ecosprin 75 (Brand)", "pharmacy": "Apollo Pharmacy", "price": 10.00, "quantity": "14 tablets", "unit_price": 0.71, "link": "https://www.apollopharmacy.in/search?q=Ecosprin+75"},
        {"name": "Loprin 75 (Brand)", "pharmacy": "MedPlus", "price": 9.50, "quantity": "14 tablets", "unit_price": 0.68, "link": "https://www.medplusmart.com/search/Loprin%2075"},
        {"name": "Generic Aspirin 75", "pharmacy": "Apollo Pharmacy", "price": 5.00, "quantity": "14 tablets", "unit_price": 0.36, "link": "https://www.apollopharmacy.in/search?q=Aspirin+75"},
        {"name": "Generic Aspirin 75", "pharmacy": "MedPlus", "price": 4.50, "quantity": "14 tablets", "unit_price": 0.32, "link": "https://www.medplusmart.com/search/Aspirin%2075"}
    ],
    "phenylephrine": [
        {"name": "Sudafed PE (Brand)", "pharmacy": "Apollo Pharmacy", "price": 120.00, "quantity": "10 tablets", "unit_price": 12.00, "link": "https://www.apollopharmacy.in/search?q=Sudafed+PE"},
        {"name": "Generic Phenylephrine", "pharmacy": "MedPlus", "price": 50.00, "quantity": "10 tablets", "unit_price": 5.00, "link": "https://www.medplusmart.com/search/Phenylephrine"}
    ]
}

import base64
import copy

def get_apollo_link(query: str) -> str:
    # Format: https://www.apollopharmacy.in/search-medicines/query
    return f"https://www.apollopharmacy.in/search-medicines/{urllib.parse.quote(query)}"

def get_medplus_link(query: str) -> str:
    # Format: https://www.medplusmart.com/searchAll/base64(A::query)
    encoded = base64.b64encode(f"A::{query}".encode("utf-8")).decode("utf-8")
    return f"https://www.medplusmart.com/searchAll/{encoded}"

def find_pricing_options(medication_name: str) -> list:
    """Helper to match a medication name to options in the pricing database."""
    name_clean = medication_name.lower().strip()
    matched_options = None
    
    # Try exact or substring matching in keys
    for key, options in DRUG_PRICING_DATABASE.items():
        if key in name_clean or name_clean in key:
            matched_options = options
            break
            
    # As a fallback, try to extract words and match (e.g. "Acetaminophen (Tylenol)" -> "acetaminophen")
    if not matched_options:
        for key, options in DRUG_PRICING_DATABASE.items():
            words = name_clean.replace("(", " ").replace(")", " ").split()
            if any(word == key for word in words):
                matched_options = options
                break
                
    # Default fallback: generate mock generic and brand Apollo/MedPlus options if not present
    if not matched_options:
        clean_base = medication_name.split("(")[0].strip()
        matched_options = [
            {"name": f"{clean_base} (Generic)", "pharmacy": "Apollo Pharmacy", "price": 45.00, "quantity": "10 doses", "unit_price": 4.50},
            {"name": f"{clean_base} (Generic)", "pharmacy": "MedPlus", "price": 42.00, "quantity": "10 doses", "unit_price": 4.20}
        ]
        
    # Deep copy options to avoid mutating original DRUG_PRICING_DATABASE structure in memory
    results = copy.deepcopy(matched_options)
    
    # Overwrite the links dynamically with correct formats
    for opt in results:
        search_query = opt["name"].split("(")[0].strip()
        if opt["pharmacy"].lower() == "apollo pharmacy":
            opt["link"] = get_apollo_link(search_query)
        else:
            opt["link"] = get_medplus_link(search_query)
            
    return results

def get_connection():
    """Returns a connection to the SQLite database with timeout and safety pragmas configured."""
    ensure_db_copied()
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        if not (os.environ.get("VERCEL") or os.environ.get("VERCEL_ENV")):
            conn.execute("PRAGMA journal_mode=WAL;")
        else:
            conn.execute("PRAGMA journal_mode=MEMORY;")
        conn.execute("PRAGMA busy_timeout=30000;")
        conn.execute("PRAGMA synchronous=NORMAL;")
    except Exception:
        pass
    return conn

def init_db():
    """Initializes the database schema if it doesn't already exist."""
    print(f"Initializing database at {DB_PATH}...")
    conn = get_connection()
    cursor = conn.cursor()
    
    # Check if allergies needs migration
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='allergies'")
    if cursor.fetchone():
        cursor.execute("PRAGMA table_info(allergies)")
        columns = [row["name"] for row in cursor.fetchall()]
        if "user_email" not in columns:
            print("Migrating allergies table to support multi-user uniqueness...")
            cursor.execute("SELECT id, name FROM allergies")
            old_allergies = cursor.fetchall()
            cursor.execute("DROP TABLE allergies")
            cursor.execute("""
            CREATE TABLE allergies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_email TEXT NOT NULL DEFAULT 'guest@medsafe.ai',
                name TEXT NOT NULL,
                UNIQUE(user_email, name)
            )
            """)
            for row in old_allergies:
                cursor.execute("INSERT OR IGNORE INTO allergies (id, name, user_email) VALUES (?, ?, 'guest@medsafe.ai')", (row[0], row[1]))
    
    # Check if medications needs migration
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='medications'")
    if cursor.fetchone():
        cursor.execute("PRAGMA table_info(medications)")
        columns = [row["name"] for row in cursor.fetchall()]
        if "user_email" not in columns:
            print("Migrating medications table...")
            cursor.execute("ALTER TABLE medications ADD COLUMN user_email TEXT NOT NULL DEFAULT 'guest@medsafe.ai'")

    # Check if symptoms needs migration
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='symptoms'")
    if cursor.fetchone():
        cursor.execute("PRAGMA table_info(symptoms)")
        columns = [row["name"] for row in cursor.fetchall()]
        if "user_email" not in columns:
            print("Migrating symptoms table...")
            cursor.execute("ALTER TABLE symptoms ADD COLUMN user_email TEXT NOT NULL DEFAULT 'guest@medsafe.ai'")

    # 1. Allergies table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS allergies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL DEFAULT 'guest@medsafe.ai',
        name TEXT NOT NULL,
        UNIQUE(user_email, name)
    )
    """)
    
    # 2. Medications table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS medications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL DEFAULT 'guest@medsafe.ai',
        name TEXT NOT NULL,
        dosage TEXT NOT NULL,
        schedule_description TEXT NOT NULL,
        frequency TEXT NOT NULL,
        time_of_day TEXT NOT NULL, -- Format 'HH:MM'
        start_date TEXT NOT NULL,  -- Format 'YYYY-MM-DD'
        end_date TEXT,             -- Format 'YYYY-MM-DD'
        is_active INTEGER NOT NULL DEFAULT 1
    )
    """)
    
    # Auto-migrate columns if missing
    cursor.execute("PRAGMA table_info(medications)")
    med_cols = [row[1] for row in cursor.fetchall()]
    if "end_date" not in med_cols:
        cursor.execute("ALTER TABLE medications ADD COLUMN end_date TEXT")
    if "is_active" not in med_cols:
        cursor.execute("ALTER TABLE medications ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1")

    
    # 3. Symptoms table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS symptoms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL DEFAULT 'guest@medsafe.ai',
        description TEXT NOT NULL,
        severity INTEGER NOT NULL CHECK(severity >= 1 AND severity <= 10),
        logged_at TEXT NOT NULL, -- Format 'YYYY-MM-DD HH:MM:SS'
        correlated_medication TEXT -- Name of the medication suspected to cause it
    )
    """)
    
    # 4. Adherence table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS adherence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        medication_id INTEGER NOT NULL,
        taken_at TEXT, -- Format 'YYYY-MM-DD HH:MM:SS' (null if pending or skipped)
        status TEXT NOT NULL CHECK(status IN ('taken', 'skipped', 'pending')),
        scheduled_time TEXT NOT NULL, -- Format 'YYYY-MM-DD HH:MM'
        FOREIGN KEY (medication_id) REFERENCES medications(id) ON DELETE CASCADE
    )
    """)
    
    # Insert some seed data if empty
    cursor.execute("SELECT COUNT(*) FROM allergies")
    if cursor.fetchone()[0] == 0:
        cursor.execute("INSERT OR IGNORE INTO allergies (name, user_email) VALUES ('Penicillin', 'guest@medsafe.ai')")
        cursor.execute("INSERT OR IGNORE INTO allergies (name, user_email) VALUES ('Sulfa Drugs', 'guest@medsafe.ai')")
        print("Seed allergies added.")
        
    cursor.execute("SELECT COUNT(*) FROM medications")
    if cursor.fetchone()[0] == 0:
        # Seed medication: Lisinopril 10mg every morning (08:00) starting today
        from datetime import date
        today = date.today().isoformat()
        cursor.execute("""
        INSERT INTO medications (name, dosage, schedule_description, frequency, time_of_day, start_date, user_email)
        VALUES ('Lisinopril', '10mg', 'every morning', 'daily', '08:00', ?, 'guest@medsafe.ai')
        """, (today,))
        
        # Seed adherence logs for the last few days
        med_id = cursor.lastrowid
        import datetime
        for i in range(5):
            day = (datetime.datetime.now() - datetime.timedelta(days=i)).date().isoformat()
            status = 'taken' if i > 0 else 'pending'
            taken_at = f"{day} 08:05:00" if i > 0 else None
            cursor.execute("""
            INSERT INTO adherence (medication_id, taken_at, status, scheduled_time)
            VALUES (?, ?, ?, ?)
            """, (med_id, taken_at, status, f"{day} 08:00"))
            
        # Seed Warfarin 5mg every evening (20:00)
        cursor.execute("""
        INSERT INTO medications (name, dosage, schedule_description, frequency, time_of_day, start_date, user_email)
        VALUES ('Warfarin', '5mg', 'every evening', 'daily', '20:00', ?, 'guest@medsafe.ai')
        """, (today,))
        med_id_2 = cursor.lastrowid
        for i in range(5):
            day = (datetime.datetime.now() - datetime.timedelta(days=i)).date().isoformat()
            status = 'taken' if i > 1 else ('skipped' if i == 1 else 'pending')
            taken_at = f"{day} 20:10:00" if i > 1 else None
            cursor.execute("""
            INSERT INTO adherence (medication_id, taken_at, status, scheduled_time)
            VALUES (?, ?, ?, ?)
            """, (med_id_2, taken_at, status, f"{day} 20:00"))
            
        print("Seed medications and adherence added.")

    # 5. Lab Reports table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS lab_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL DEFAULT 'guest@medsafe.ai',
        filename TEXT NOT NULL,
        report_label TEXT NOT NULL,
        file_content_text TEXT NOT NULL,
        ai_analysis TEXT NOT NULL,
        uploaded_at TEXT NOT NULL
    )
    """)

    # 6. Doctor Notes table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS doctor_notes (
        user_email TEXT PRIMARY KEY,
        notes TEXT NOT NULL
    )
    """)

    # 7. Users table (for secure local auth)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        username TEXT NOT NULL,
        password_hash TEXT,
        provider TEXT NOT NULL DEFAULT 'local',
        created_at TEXT NOT NULL,
        patient_id TEXT UNIQUE
    )
    """)

    # Migration for patient_id column if table already exists without it
    cursor.execute("PRAGMA table_info(users)")
    columns = [row["name"] for row in cursor.fetchall()]
    if "patient_id" not in columns:
        print("Migrating users table to add patient_id column...")
        cursor.execute("ALTER TABLE users ADD COLUMN patient_id TEXT")
        cursor.execute("SELECT id FROM users WHERE patient_id IS NULL OR patient_id = ''")
        rows = cursor.fetchall()
        for row in rows:
            pid = f"MED-{1000 + row['id']}"
            cursor.execute("UPDATE users SET patient_id = ? WHERE id = ?", (pid, row['id']))

    # 8. Doctor Patients relationship table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS doctor_patients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doctor_email TEXT NOT NULL,
        patient_email TEXT NOT NULL,
        added_at TEXT NOT NULL,
        UNIQUE(doctor_email, patient_email)
    )
    """)

    conn.commit()
    conn.close()
    print("Database initialization complete.")


def generate_patient_id(cursor) -> str:
    import random
    while True:
        pid = f"MED-{random.randint(1000, 9999)}"
        cursor.execute("SELECT id FROM users WHERE patient_id = ?", (pid,))
        if not cursor.fetchone():
            return pid


# ── User helper functions ──────────────────────────────────────────────────────

def get_user_by_email(email: str):
    """Fetch a user row by email, or return None."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE email = ?", (email,))
    row = cursor.fetchone()
    conn.close()
    return row


def get_user_by_patient_id(patient_id: str):
    """Fetch a user row by patient_id, or return None."""
    clean_id = patient_id.strip().upper()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE UPPER(patient_id) = ?", (clean_id,))
    row = cursor.fetchone()
    conn.close()
    return row


def get_user_by_identifier(identifier: str):
    """Fetch user by email or patient_id."""
    clean_id = identifier.strip()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE email = ? OR UPPER(patient_id) = ?", (clean_id, clean_id.upper()))
    row = cursor.fetchone()
    conn.close()
    return row


def _get_supabase_sync():
    try:
        import supabase_client
        return supabase_client
    except ImportError:
        try:
            from backend import supabase_client
            return supabase_client
        except ImportError:
            return None

def create_local_user(email: str, username: str, plain_password: str) -> dict:
    """Hash password with bcrypt and insert a local user. Returns the user dict."""
    import datetime
    password_hash = bcrypt.hashpw(plain_password.encode(), bcrypt.gensalt()).decode()
    conn = get_connection()
    cursor = conn.cursor()
    try:
        patient_id = generate_patient_id(cursor)
        cursor.execute("""
        INSERT INTO users (email, username, password_hash, provider, created_at, patient_id)
        VALUES (?, ?, ?, 'local', ?, ?)
        """, (email, username, password_hash, datetime.datetime.utcnow().isoformat(), patient_id))
        conn.commit()
    finally:
        conn.close()

    sc = _get_supabase_sync()
    if sc:
        try:
            sc.sync_user_to_supabase(email=email, username=username, patient_id=patient_id, provider="local", password_hash=password_hash)
        except Exception:
            pass

    return {"email": email, "username": username, "provider": "local", "patient_id": patient_id}


def get_or_create_google_user(email: str, name: str) -> dict:
    """Fetch or create a Google-authenticated user. Returns the user dict."""
    import datetime
    existing = get_user_by_email(email)
    if existing:
        pid = existing["patient_id"]
        if not pid:
            conn = get_connection()
            cursor = conn.cursor()
            try:
                pid = generate_patient_id(cursor)
                cursor.execute("UPDATE users SET patient_id = ? WHERE email = ?", (pid, email))
                conn.commit()
            finally:
                conn.close()
        try:
            from backend.supabase_client import sync_user_to_supabase
            sync_user_to_supabase(email=existing["email"], username=existing["username"], patient_id=pid, provider=existing["provider"])
        except Exception:
            pass
        return {"email": existing["email"], "username": existing["username"], "provider": existing["provider"], "patient_id": pid}
        
    conn = get_connection()
    cursor = conn.cursor()
    try:
        pid = generate_patient_id(cursor)
        cursor.execute("""
        INSERT OR IGNORE INTO users (email, username, password_hash, provider, created_at, patient_id)
        VALUES (?, ?, NULL, 'google', ?, ?)
        """, (email, name, datetime.datetime.utcnow().isoformat(), pid))
        conn.commit()
    finally:
        conn.close()

    try:
        from backend.supabase_client import sync_user_to_supabase
        sync_user_to_supabase(email=email, username=name, patient_id=pid, provider="google")
    except Exception:
        pass

    return {"email": email, "username": name, "provider": "google", "patient_id": pid}


def verify_local_user_password(email: str, plain_password: str) -> bool:
    """Returns True if the email/password pair is valid."""
    row = get_user_by_email(email)
    if not row or row["provider"] != "local" or not row["password_hash"]:
        return False
    return bcrypt.checkpw(plain_password.encode(), row["password_hash"].encode())


def verify_user_credentials(identifier: str, plain_password: str):
    """Verifies credentials by email or patient_id. Returns user row if valid, else None."""
    row = get_user_by_identifier(identifier)
    if not row or not row["password_hash"]:
        return None
    if bcrypt.checkpw(plain_password.encode(), row["password_hash"].encode()):
        return row
    return None


# ── Doctor-Patient Relationship Helpers ────────────────────────────────────────

def add_patient_to_doctor(doctor_email: str, patient_id_or_email: str) -> dict:
    patient_row = get_user_by_identifier(patient_id_or_email)
    if not patient_row:
        return {"success": False, "message": "Patient not found."}
    
    patient_email = patient_row["email"]
    import datetime
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
        INSERT OR IGNORE INTO doctor_patients (doctor_email, patient_email, added_at)
        VALUES (?, ?, ?)
        """, (doctor_email, patient_email, datetime.datetime.utcnow().isoformat()))
        conn.commit()
    finally:
        conn.close()

    try:
        from backend.supabase_client import sync_doctor_patient_to_supabase
        sync_doctor_patient_to_supabase(doctor_email, patient_email)
    except Exception:
        pass

    return {
        "success": True,
        "patient": {
            "email": patient_email,
            "username": patient_row["username"],
            "patient_id": patient_row["patient_id"]
        }
    }


def remove_patient_from_doctor(doctor_email: str, patient_id_or_email: str) -> bool:
    patient_row = get_user_by_identifier(patient_id_or_email)
    if not patient_row:
        return False
    patient_email = patient_row["email"]
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM doctor_patients WHERE doctor_email = ? AND patient_email = ?", (doctor_email, patient_email))
        conn.commit()
    finally:
        conn.close()
    return True


def get_doctor_patients(doctor_email: str) -> list:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT u.email, u.username, u.patient_id, dp.added_at
    FROM doctor_patients dp
    JOIN users u ON dp.patient_email = u.email
    WHERE dp.doctor_email = ?
    ORDER BY dp.added_at DESC
    """, (doctor_email,))
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return rows


def search_patients_for_doctor(query_str: str, doctor_email: str) -> list:
    q = f"%{query_str.strip().upper()}%"
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT u.email, u.username, u.patient_id,
           CASE WHEN dp.id IS NOT NULL THEN 1 ELSE 0 END as is_added
    FROM users u
    LEFT JOIN doctor_patients dp ON u.email = dp.patient_email AND dp.doctor_email = ?
    WHERE (UPPER(u.patient_id) LIKE ? OR UPPER(u.email) LIKE ? OR UPPER(u.username) LIKE ?)
    LIMIT 20
    """, (doctor_email, q, q, q))
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return rows


def get_patient_full_history_by_identifier(identifier: str) -> dict:
    """
    Retrieves the complete unified medical history for a patient (by patient_id or email).
    Returns patient profile, medications, adherence history, symptoms, allergies, lab reports, and doctor notes.
    """
    user_row = get_user_by_identifier(identifier)
    if not user_row:
        return None
        
    patient_email = user_row["email"]
    patient_id = user_row["patient_id"]
    
    conn = get_connection()
    cursor = conn.cursor()
    
    # 1. Medications
    cursor.execute("SELECT * FROM medications WHERE user_email = ? ORDER BY is_active DESC, name ASC", (patient_email,))
    medications = [dict(r) for r in cursor.fetchall()]
    
    # 2. Adherence Logs
    cursor.execute("""
        SELECT a.*, m.name as medication_name, m.dosage as medication_dosage, m.time_of_day as medication_time_of_day 
        FROM adherence a
        JOIN medications m ON a.medication_id = m.id
        WHERE m.user_email = ?
        ORDER BY a.scheduled_time ASC
    """, (patient_email,))
    adherence = [dict(r) for r in cursor.fetchall()]
    
    # 3. Symptoms
    cursor.execute("SELECT * FROM symptoms WHERE user_email = ? ORDER BY logged_at DESC", (patient_email,))
    symptoms = [dict(r) for r in cursor.fetchall()]
    
    # 4. Allergies
    cursor.execute("SELECT * FROM allergies WHERE user_email = ? ORDER BY name ASC", (patient_email,))
    allergies = [dict(r) for r in cursor.fetchall()]
    
    # 5. Lab Reports
    cursor.execute("SELECT id, filename, report_label, ai_analysis, uploaded_at FROM lab_reports WHERE user_email = ? ORDER BY uploaded_at DESC", (patient_email,))
    lab_reports = [dict(r) for r in cursor.fetchall()]
    
    # 6. Doctor Notes
    cursor.execute("SELECT notes FROM doctor_notes WHERE user_email = ?", (patient_email,))
    doc_note_row = cursor.fetchone()
    notes = doc_note_row["notes"] if doc_note_row else ""
    
    conn.close()
    
    return {
        "patient": {
            "patient_id": patient_id,
            "username": user_row["username"],
            "email": patient_email,
            "created_at": user_row["created_at"]
        },
        "medications": medications,
        "adherence": adherence,
        "symptoms": symptoms,
        "allergies": allergies,
        "lab_reports": lab_reports,
        "doctor_notes": notes
    }


if __name__ == "__main__":
    init_db()
