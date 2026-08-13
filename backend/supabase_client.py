import os
import logging
from dotenv import load_dotenv

# Load environment variables from .env
load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY") or os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")

supabase = None
_supabase_disabled = False

if SUPABASE_URL and SUPABASE_KEY:
    try:
        from supabase import create_client
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    except Exception as e:
        logging.warning(f"[MedSafe AI] Could not initialize Supabase client: {e}. Operating in local mode.")
        supabase = None
        _supabase_disabled = True
else:
    logging.info("[MedSafe AI] Supabase credentials not found. Operating in local mode.")
    _supabase_disabled = True


def _handle_supabase_error(e: Exception, action: str):
    global _supabase_disabled
    err_str = str(e)
    if "nodename nor servname provided" in err_str or "ConnectError" in err_str or "503" in err_str or "paused" in err_str.lower():
        if not _supabase_disabled:
            logging.info(f"[MedSafe AI] Supabase project appears to be paused or unreachable ({action}). Operating seamlessly in local SQLite mode.")
            _supabase_disabled = True
    elif "PGRST205" in err_str or "Could not find the table" in err_str:
        logging.info(f"[MedSafe AI] Supabase table not created yet ({action}). Operating in local SQLite mode until table schema is applied.")
    else:
        logging.warning(f"[MedSafe AI] Could not {action} on Supabase: {e}")


def sync_user_to_supabase(email: str, username: str, patient_id: str, provider: str = "local", password_hash: str = None) -> bool:
    """Upsert user/patient profile into Supabase 'users' table if available."""
    if not supabase or _supabase_disabled:
        return False
    try:
        data = {
            "email": email,
            "username": username,
            "patient_id": patient_id,
            "provider": provider,
        }
        if password_hash:
            data["password_hash"] = password_hash

        supabase.table("users").upsert(data, on_conflict="email").execute()
        logging.info(f"Successfully synced patient user {patient_id} ({email}) to Supabase.")
        return True
    except Exception as e:
        _handle_supabase_error(e, f"sync user {email}")
        return False


def sync_doctor_patient_to_supabase(doctor_email: str, patient_email: str) -> bool:
    """Upsert doctor-patient relationship into Supabase 'doctor_patients' table if available."""
    if not supabase or _supabase_disabled:
        return False
    try:
        data = {
            "doctor_email": doctor_email,
            "patient_email": patient_email,
        }
        supabase.table("doctor_patients").upsert(data, on_conflict="doctor_email,patient_email").execute()
        return True
    except Exception as e:
        _handle_supabase_error(e, f"sync doctor-patient ({doctor_email} -> {patient_email})")
        return False


def sync_lab_report_to_supabase(user_email: str, filename: str, report_label: str, file_content_text: str = "", ai_analysis: str = "", uploaded_at: str = "") -> bool:
    """Sync an uploaded lab report metadata to Supabase 'lab_reports' table if available."""
    if not supabase or _supabase_disabled:
        return False
    try:
        data = {
            "user_email": user_email,
            "filename": filename,
            "report_label": report_label,
            "file_content_text": file_content_text or "",
            "ai_analysis": ai_analysis or "",
            "uploaded_at": uploaded_at or ""
        }
        supabase.table("lab_reports").insert(data).execute()
        logging.info(f"Successfully synced report {filename} for {user_email} to Supabase.")
        return True
    except Exception as e:
        _handle_supabase_error(e, f"sync lab report {filename}")
        return False


def delete_lab_report_from_supabase(user_email: str, filename: str) -> bool:
    """Delete a lab report entry from Supabase 'lab_reports' table if available."""
    if not supabase or _supabase_disabled:
        return False
    try:
        supabase.table("lab_reports").delete().eq("user_email", user_email).eq("filename", filename).execute()
        return True
    except Exception as e:
        _handle_supabase_error(e, f"delete lab report {filename}")
        return False

