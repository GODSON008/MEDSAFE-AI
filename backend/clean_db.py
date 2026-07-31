import sqlite3
import os
import sys
import shutil

DB_PATH = os.path.join(os.path.dirname(__file__), "medsafe.db")

def clean_database(dry_run=False):
    if not os.path.exists(DB_PATH):
        print(f"Database not found at {DB_PATH}. Nothing to clean.")
        return

    if dry_run:
        print("Running in DRY RUN mode. No changes will be saved.")
    else:
        # Create a database backup before making any changes
        backup_path = DB_PATH + ".bak"
        try:
            shutil.copyfile(DB_PATH, backup_path)
            print(f"Database backup created successfully at: {backup_path}")
        except Exception as e:
            print(f"CRITICAL: Failed to create database backup: {e}. Aborting cleanup for safety.")
            return

    print(f"Connecting to database at {DB_PATH}...")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # Enable foreign keys
    cursor.execute("PRAGMA foreign_keys = ON;")

    # 1. Deduplicate medications
    print("\n[Step 1] Deduplicating medications...")
    cursor.execute("""
        SELECT name, dosage, frequency, time_of_day, user_email, COUNT(*), MIN(id) as keep_id
        FROM medications
        GROUP BY user_email, LOWER(name), dosage, frequency, time_of_day
        HAVING COUNT(*) > 1
    """)
    dup_meds = cursor.fetchall()
    deleted_meds_count = 0
    for dup in dup_meds:
        name = dup["name"]
        dosage = dup["dosage"]
        frequency = dup["frequency"]
        time_of_day = dup["time_of_day"]
        user_email = dup["user_email"]
        keep_id = dup["keep_id"]
        
        cursor.execute("""
            SELECT id FROM medications 
            WHERE user_email = ? AND LOWER(name) = LOWER(?) AND dosage = ? AND frequency = ? AND time_of_day = ? AND id != ?
        """, (user_email, name, dosage, frequency, time_of_day, keep_id))
        ids_to_delete = [row["id"] for row in cursor.fetchall()]
        
        for med_id in ids_to_delete:
            print(f"  -> Duplicate medication ID {med_id} for user {user_email} (keeping ID {keep_id}): {name} {dosage}")
            if not dry_run:
                cursor.execute("DELETE FROM adherence WHERE medication_id = ?", (med_id,))
                cursor.execute("DELETE FROM medications WHERE id = ?", (med_id,))
            deleted_meds_count += 1
            
    print(f"  Result: Found {deleted_meds_count} duplicate medication(s) to delete.")

    # 2. Clean duplicate allergies
    print("\n[Step 2] Deduplicating allergies...")
    cursor.execute("""
        SELECT name, user_email, COUNT(*), MIN(id) as keep_id
        FROM allergies
        GROUP BY user_email, LOWER(name)
        HAVING COUNT(*) > 1
    """)
    dup_allergies = cursor.fetchall()
    deleted_allergies_count = 0
    for dup in dup_allergies:
        name = dup["name"]
        user_email = dup["user_email"]
        keep_id = dup["keep_id"]
        
        cursor.execute("""
            SELECT id FROM allergies
            WHERE user_email = ? AND LOWER(name) = LOWER(?) AND id != ?
        """, (user_email, name, keep_id))
        ids_to_delete = [row["id"] for row in cursor.fetchall()]
        
        for allergy_id in ids_to_delete:
            print(f"  -> Duplicate allergy ID {allergy_id} ({name}) for user {user_email}")
            if not dry_run:
                cursor.execute("DELETE FROM allergies WHERE id = ?", (allergy_id,))
            deleted_allergies_count += 1
            
    print(f"  Result: Found {deleted_allergies_count} duplicate allergy/allergies to delete.")

    # 3. Clean duplicate symptoms
    print("\n[Step 3] Deduplicating symptoms...")
    cursor.execute("""
        SELECT description, severity, logged_at, user_email, COUNT(*), MIN(id) as keep_id
        FROM symptoms
        GROUP BY user_email, description, severity, logged_at
        HAVING COUNT(*) > 1
    """)
    dup_symptoms = cursor.fetchall()
    deleted_symptoms_count = 0
    for dup in dup_symptoms:
        description = dup["description"]
        severity = dup["severity"]
        logged_at = dup["logged_at"]
        user_email = dup["user_email"]
        keep_id = dup["keep_id"]
        
        cursor.execute("""
            SELECT id FROM symptoms
            WHERE user_email = ? AND description = ? AND severity = ? AND logged_at = ? AND id != ?
        """, (user_email, description, severity, logged_at, keep_id))
        ids_to_delete = [row["id"] for row in cursor.fetchall()]
        
        for symptom_id in ids_to_delete:
            print(f"  -> Duplicate symptom ID {symptom_id} ({description}) for user {user_email}")
            if not dry_run:
                cursor.execute("DELETE FROM symptoms WHERE id = ?", (symptom_id,))
            deleted_symptoms_count += 1
            
    print(f"  Result: Found {deleted_symptoms_count} duplicate symptom(s) to delete.")

    if not dry_run:
        conn.commit()
        print("\nAll database changes successfully committed.")
    else:
        print("\nDry run completed. No changes were committed.")
        
    conn.close()

if __name__ == "__main__":
    is_dry_run = "--dry-run" in sys.argv or "-d" in sys.argv
    clean_database(dry_run=is_dry_run)
