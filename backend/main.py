import os
import time
import sqlite3
from fastapi import FastAPI, HTTPException, Request, Header, UploadFile, File, Form, Depends
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import datetime
from dotenv import load_dotenv

import sys
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# Load environment variables from .env file
load_dotenv()

# Define and create directory for report uploads
if os.environ.get("VERCEL") or os.environ.get("VERCEL_ENV"):
    UPLOADS_DIR = "/tmp/uploads"
else:
    UPLOADS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
os.makedirs(UPLOADS_DIR, exist_ok=True)

from database import (
    get_connection, init_db, find_pricing_options,
    create_local_user, get_or_create_google_user,
    verify_local_user_password, get_user_by_email,
    get_user_by_patient_id, get_user_by_identifier, verify_user_credentials,
    add_patient_to_doctor, remove_patient_from_doctor, get_doctor_patients, search_patients_for_doctor,
    get_patient_full_history_by_identifier
)
from auth import (
    create_access_token, verify_google_id_token, get_current_user, AuthenticatedUser, GUEST_USER
)
from medsafe_agent import stream_agent_chat, check_safety_local, add_medication_local, log_symptom_local, analyze_clinical_report

app = FastAPI(title="MedSafe AI Backend", description="Privacy-First Medical Tracker and Safety Coordinator")

# Allow all origins (required for Vercel + local development)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/health")
def health_check():
    return {"status": "ok", "service": "MedSafe AI Backend"}

# In-memory Rate Limiting State
RATE_LIMIT_WINDOW = 60  # 1 minute window
RATE_LIMIT_MAX_REQUESTS = 60  # max 60 requests per minute
request_counts = {}

@app.middleware("http")
async def rate_limiting_middleware(request: Request, call_next):
    # Only rate limit API paths
    if request.url.path.startswith("/api/"):
        client_ip = request.client.host if request.client else "unknown"
        now = time.time()
        
        if client_ip in request_counts:
            request_counts[client_ip] = [t for t in request_counts[client_ip] if now - t < RATE_LIMIT_WINDOW]
        else:
            request_counts[client_ip] = []
            
        if len(request_counts[client_ip]) >= RATE_LIMIT_MAX_REQUESTS:
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests. Please try again later."}
            )
        request_counts[client_ip].append(now)
        
    response = await call_next(request)
    return response

@app.middleware("http")
async def add_no_cache_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    import traceback
    print(f"[MedSafe AI Server Error] Unhandled Exception at {request.method} {request.url.path}: {exc}\n{traceback.format_exc()}")
    return JSONResponse(
        status_code=500,
        content={"detail": "An internal server error occurred. Please try again or check server logs."}
    )

# Pydantic models for request bodies
class ChatRequest(BaseModel):
    message: str
    conversation_id: Optional[str] = None

class MedicationRequest(BaseModel):
    name: str
    dosage: str
    schedule_description: str
    frequency: str
    time_of_day: str # HH:MM
    override_confirmed: Optional[bool] = False

class AllergyRequest(BaseModel):
    name: str

class SymptomRequest(BaseModel):
    description: str
    severity: int
    correlated_medication: Optional[str] = None

class AdherenceUpdateRequest(BaseModel):
    status: str # 'taken', 'skipped', 'pending'

# Initialize database schema on startup
@app.on_event("startup")
def startup_event():
    init_db()

# ── Auth Endpoints ─────────────────────────────────────────────────────────────

class GoogleAuthRequest(BaseModel):
    id_token: str

class LocalRegisterRequest(BaseModel):
    email: str
    username: str
    password: str

class LocalLoginRequest(BaseModel):
    email: str
    password: str

class DoctorVerifyRequest(BaseModel):
    patient_id: str
    patient_password: str

@app.post("/api/auth/google")
async def google_auth_endpoint(req: GoogleAuthRequest):
    """Verifies a Google ID token and returns a signed JWT access token."""
    claims = await verify_google_id_token(req.id_token)
    email = claims.get("email", "")
    name = claims.get("name") or claims.get("given_name") or email.split("@")[0]
    if not email:
        raise HTTPException(status_code=400, detail="Google account has no email address.")
    user = get_or_create_google_user(email=email, name=name)
    access_token = create_access_token(email=user["email"], username=user["username"], provider="google", patient_id=user["patient_id"])
    return {"access_token": access_token, "token_type": "bearer", "email": email, "username": name, "patient_id": user["patient_id"]}

@app.post("/api/auth/register")
def local_register_endpoint(req: LocalRegisterRequest):
    """Creates a new local user with bcrypt-hashed password. Returns a JWT."""
    existing = get_user_by_email(req.email)
    if existing:
        raise HTTPException(status_code=409, detail="An account with this email already exists.")
    if len(req.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    user = create_local_user(email=req.email, username=req.username, plain_password=req.password)
    access_token = create_access_token(email=user["email"], username=user["username"], provider="local", patient_id=user["patient_id"])
    return {"access_token": access_token, "token_type": "bearer", "email": req.email, "username": req.username, "patient_id": user["patient_id"]}

@app.post("/api/auth/login")
def local_login_endpoint(req: LocalLoginRequest):
    """Verifies local credentials and returns a JWT on success."""
    ok = verify_local_user_password(req.email, req.password)
    if not ok:
        # Generic error to prevent user enumeration
        raise HTTPException(status_code=401, detail="Invalid email or password.")
    user = get_user_by_email(req.email)
    access_token = create_access_token(email=user["email"], username=user["username"], provider="local", patient_id=user["patient_id"])
    return {"access_token": access_token, "token_type": "bearer", "email": user["email"], "username": user["username"], "patient_id": user["patient_id"]}

class DoctorLoginRequest(BaseModel):
    email: str
    password: str

class DoctorPatientActionRequest(BaseModel):
    patient_id: str

@app.post("/api/doctor/login")
def doctor_login_endpoint(req: DoctorLoginRequest):
    """Doctor logs in with their email. Creates a doctor profile if needed."""
    email = req.email.strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Doctor email is required.")
    
    # Check if user exists or create doctor profile
    user = get_user_by_email(email)
    if not user:
        user = create_local_user(email=email, username=f"Dr. {email.split('@')[0]}", plain_password=req.password)
    else:
        # Check password if existing local account with password
        if user["password_hash"] and not verify_local_user_password(email, req.password):
            raise HTTPException(status_code=401, detail="Invalid doctor password.")
            
    access_token = create_access_token(
        email=user["email"],
        username=user["username"],
        provider="doctor",
        patient_id=user["patient_id"],
        is_doctor=True
    )
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "email": user["email"],
        "username": user["username"],
        "patient_id": user["patient_id"],
        "is_doctor": True
    }

@app.get("/api/doctor/my-patients")
def doctor_my_patients_endpoint(current_user: AuthenticatedUser = Depends(get_current_user)):
    """Returns list of patients added by the current doctor."""
    return get_doctor_patients(current_user.email)

@app.get("/api/doctor/search-patients")
def doctor_search_patients_endpoint(q: str = "", current_user: AuthenticatedUser = Depends(get_current_user)):
    """Searches for patients by patient ID, name, or email."""
    if not q.strip():
        return []
    return search_patients_for_doctor(q, current_user.email)

@app.post("/api/doctor/add-patient")
def doctor_add_patient_endpoint(req: DoctorPatientActionRequest, current_user: AuthenticatedUser = Depends(get_current_user)):
    """Adds a patient to the doctor's saved list."""
    res = add_patient_to_doctor(current_user.email, req.patient_id)
    if not res["success"]:
        raise HTTPException(status_code=404, detail=res["message"])
    return res

@app.post("/api/doctor/remove-patient")
def doctor_remove_patient_endpoint(req: DoctorPatientActionRequest, current_user: AuthenticatedUser = Depends(get_current_user)):
    """Removes a patient from the doctor's saved list."""
    ok = remove_patient_from_doctor(current_user.email, req.patient_id)
    return {"success": ok}

@app.post("/api/doctor/verify-patient")
def doctor_verify_patient_endpoint(req: DoctorVerifyRequest):
    """
    Verifies patient ID (e.g. MED-1001 or email) and patient password.
    Returns a doctor session token granting full read/note access for that patient.
    """
    user_row = verify_user_credentials(req.patient_id, req.patient_password)
    if not user_row:
        raise HTTPException(status_code=401, detail="Invalid Patient ID or Password. Verification failed.")
    
    patient_email = user_row["email"]
    patient_name = user_row["username"]
    patient_id = user_row["patient_id"]
    
    access_token = create_access_token(
        email=patient_email,
        username=patient_name,
        provider=user_row["provider"],
        patient_id=patient_id,
        is_doctor=True
    )
    
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "email": patient_email,
        "username": patient_name,
        "patient_id": patient_id,
        "is_doctor": True
    }

@app.get("/api/auth/me")
def get_me_endpoint(current_user: AuthenticatedUser = Depends(get_current_user)):
    """Returns the currently authenticated user's profile from their JWT."""
    return {
        "email": current_user.email,
        "username": current_user.username,
        "provider": current_user.provider,
        "patient_id": current_user.patient_id,
        "is_doctor": current_user.is_doctor
    }

@app.get("/api/auth/google-client-id")
def get_google_client_id():
    """Returns the Google OAuth Client ID for the frontend to initialize Sign-In."""
    client_id = os.getenv("GOOGLE_CLIENT_ID", "")
    return {"client_id": client_id}

# REST Endpoints
@app.post("/api/chat")
async def chat_endpoint(request: ChatRequest, current_user: AuthenticatedUser = Depends(get_current_user)):
    """Streams responses from the Antigravity Agent (or Fallback Agent) to the client."""
    async def event_generator():
        try:
            async for chunk in stream_agent_chat(request.message, request.conversation_id, current_user.email):
                yield chunk
        except asyncio.CancelledError:
            print("[MedSafe AI] Chat streaming cancelled by client.")
        except Exception as e:
            print(f"[MedSafe AI] Chat streaming error: {e}")
            yield f"\n[System Error: {str(e)}]"
            
    return StreamingResponse(event_generator(), media_type="text/plain")
def extract_text_from_file(file_bytes: bytes, filename: str) -> str:
    filename_lower = filename.lower()
    if filename_lower.endswith(".pdf"):
        try:
            import pypdf
            import io
            pdf_file = io.BytesIO(file_bytes)
            reader = pypdf.PdfReader(pdf_file)
            text = ""
            for page in reader.pages:
                page_text = page.extract_text()
                if page_text:
                    text += page_text + "\n"
            return text.strip()
        except ImportError:
            return "[Error: pypdf library is not installed on the server. Please install it to parse PDF files.]"
        except Exception as e:
            return f"[Error parsing PDF: {str(e)}]"
    elif filename_lower.endswith(('.png', '.jpg', '.jpeg', '.webp')):
        # For image files, try to run native local macOS OCR to parse structured report text.
        try:
            import tempfile
            import subprocess
            import os
            
            # Save file_bytes to a temporary file
            suffix = os.path.splitext(filename)[1]
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
                temp_file.write(file_bytes)
                temp_path = temp_file.name
            
            try:
                swift_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ocr.swift")
                result = subprocess.run(
                    ["swift", swift_script, temp_path],
                    capture_output=True,
                    text=True,
                    timeout=15
                )
                
                # Cleanup temp file
                if os.path.exists(temp_path):
                    os.unlink(temp_path)
                
                if result.returncode == 0:
                    ocr_text = result.stdout.strip()
                    if ocr_text:
                        print(f"[OCR] Reconstructed text successfully from {filename}")
                        return ocr_text
                else:
                    print(f"[OCR] Swift OCR failed with return code {result.returncode}: {result.stderr}")
            except Exception as ocr_err:
                print(f"[OCR] Swift OCR execution exception: {ocr_err}")
                if os.path.exists(temp_path):
                    os.unlink(temp_path)
        except Exception as tmp_err:
            print(f"[OCR] Temporary file operation failed: {tmp_err}")
            
        return f"[Image File: {filename}]"
    else:
        # Assume plain text / md / csv / json
        try:
            return file_bytes.decode("utf-8")
        except UnicodeDecodeError:
            try:
                return file_bytes.decode("latin-1")
            except Exception as e:
                return f"[Error decoding file content: {str(e)}]"

@app.post("/api/chat/upload")
async def chat_upload_endpoint(
    message: str = Form(""),
    file: UploadFile = File(...),
    conversation_id: Optional[str] = Form(None),
    current_user: AuthenticatedUser = Depends(get_current_user)
):
    file_bytes = await file.read()
    safe_filename = os.path.basename(file.filename)
    extracted_text = extract_text_from_file(file_bytes, safe_filename)
    
    # Save the file to UPLOADS_DIR
    file_path = os.path.join(UPLOADS_DIR, safe_filename)
    try:
        with open(file_path, "wb") as f:
            f.write(file_bytes)
    except Exception as e:
        print(f"[MedSafe AI] Failed to save uploaded chat file: {e}")
        file_path = None
        
    # Construct combined prompt
    combined_prompt = f"User uploaded a medical statement file: '{safe_filename}'.\n\n=== FILE CONTENT ===\n{extracted_text}\n====================\n\nUser Message: {message}"
    
    async def event_generator():
        try:
            async for chunk in stream_agent_chat(combined_prompt, conversation_id, current_user.email, file_path=file_path):
                yield chunk
        except Exception as e:
            yield f"\n[System Error: {str(e)}]"
            
    return StreamingResponse(event_generator(), media_type="text/plain")


@app.get("/api/medications")
def get_medications_endpoint(current_user: AuthenticatedUser = Depends(get_current_user)):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM medications WHERE user_email = ? AND (is_active = 1 OR is_active IS NULL) ORDER BY name ASC", (current_user.email,))
    meds = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return meds
@app.post("/api/medications")
def add_medication_endpoint(med: MedicationRequest, current_user: AuthenticatedUser = Depends(get_current_user)):
    """Adds medication after checking clinical guidelines. If unsafe, returns safety warnings."""
    # Check safety first
    safety = check_safety_local(med.name, current_user.email)
    if not safety["safe"]:
        return {
            "success": False,
            "safety_warnings": [w["message"] for w in safety["warnings"]],
            "severity": "High",
            "message": f"Safety warnings triggered for {med.name}."
        }
        
    # If safe, add
    res = add_medication_local(
        med.name, 
        med.dosage, 
        med.schedule_description, 
        med.frequency, 
        med.time_of_day,
        current_user.email
    )
    if res.get("already_exists"):
        return {
            "success": True,
            "medication": res,
            "message": f"Medication {med.name} {med.dosage} is already scheduled in your list."
        }
    return {
        "success": True,
        "medication": res,
        "message": f"Medication {med.name} scheduled successfully."
    }

@app.post("/api/medications/force")
def force_add_medication_endpoint(med: MedicationRequest, current_user: AuthenticatedUser = Depends(get_current_user)):
    """Directly adds medication, bypassing safety warning confirmations if explicitly overridden by user."""
    if not med.override_confirmed:
        raise HTTPException(status_code=400, detail="Safety check override confirmation is required.")
        
    res = add_medication_local(
        med.name, 
        med.dosage, 
        med.schedule_description, 
        med.frequency, 
        med.time_of_day,
        current_user.email
    )
    return {
        "success": True,
        "medication": res,
        "message": f"Medication {med.name} scheduled successfully (forced safety override)."
    }

@app.delete("/api/medications/{med_id}")
def delete_medication_endpoint(med_id: int, current_user: AuthenticatedUser = Depends(get_current_user)):
    conn = get_connection()
    cursor = conn.cursor()
    today_str = datetime.date.today().isoformat()
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    
    # Soft delete / discontinue medication (set is_active = 0, end_date = today)
    cursor.execute("""
    UPDATE medications 
    SET is_active = 0, end_date = ? 
    WHERE id = ? AND user_email = ?
    """, (today_str, med_id, current_user.email))
    
    # Remove ONLY future/today pending adherence entries that haven't been taken/skipped yet
    # All past adherence records & taken/skipped records are preserved for history!
    cursor.execute("""
    DELETE FROM adherence
    WHERE medication_id = ?
      AND status = 'pending'
      AND scheduled_time >= ?
    """, (med_id, now_str))
    
    conn.commit()
    conn.close()
    return {"success": True, "message": "Medication discontinued. Past compliance history preserved."}

@app.get("/api/allergies")
def get_allergies_endpoint(current_user: AuthenticatedUser = Depends(get_current_user)):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM allergies WHERE user_email = ? ORDER BY name ASC", (current_user.email,))
    allergies = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return allergies

@app.post("/api/allergies")
def add_allergy_endpoint(allergy: AllergyRequest, current_user: AuthenticatedUser = Depends(get_current_user)):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO allergies (name, user_email) VALUES (?, ?)", (allergy.name.strip(), current_user.email))
        conn.commit()
        res = {"success": True, "message": f"Allergy {allergy.name} added."}
    except sqlite3.IntegrityError:
        res = {"success": False, "message": f"Allergy {allergy.name} already exists."}
    conn.close()
    return res

@app.delete("/api/allergies/{name}")
def delete_allergy_endpoint(name: str, current_user: AuthenticatedUser = Depends(get_current_user)):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM allergies WHERE LOWER(name) = LOWER(?) AND user_email = ?", (name.strip(), current_user.email))
    conn.commit()
    conn.close()
    return {"success": True, "message": f"Allergy {name} deleted."}

@app.get("/api/symptoms")
def get_symptoms_endpoint(current_user: AuthenticatedUser = Depends(get_current_user)):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM symptoms WHERE user_email = ? ORDER BY logged_at DESC", (current_user.email,))
    symptoms = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return symptoms

@app.post("/api/symptoms")
def add_symptom_endpoint(symptom: SymptomRequest, current_user: AuthenticatedUser = Depends(get_current_user)):
    res = log_symptom_local(
        symptom.description,
        symptom.severity,
        symptom.correlated_medication,
        current_user.email
    )
    return {
        "success": True,
        "symptom": res,
        "message": "Symptom logged successfully."
    }

@app.delete("/api/symptoms/{symptom_id}")
def delete_symptom_endpoint(symptom_id: int, current_user: AuthenticatedUser = Depends(get_current_user)):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM symptoms WHERE id = ? AND user_email = ?", (symptom_id, current_user.email))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()

    if not deleted:
        raise HTTPException(status_code=404, detail="Symptom entry not found or unauthorized.")
    
    return {"success": True, "message": "Symptom entry deleted successfully."}

@app.get("/api/pharmacies/search")
def search_pharmacies_endpoint(query: str, lat: Optional[float] = None, lng: Optional[float] = None):
    """
    Official Real-Time Indian Pharmacy & Local Medical Store Finder API.
    Delegates location geocoding, Google Places API search, and OSM physical chemist lookup
    to the backend/pharmacy_finder.py service module.
    """
    try:
        from pharmacy_finder import search_pharmacies
    except ImportError:
        from backend.pharmacy_finder import search_pharmacies

    return search_pharmacies(query=query, lat=lat, lng=lng)

@app.get("/api/adherence")
def get_adherence_endpoint(current_user: AuthenticatedUser = Depends(get_current_user)):
    conn = get_connection()
    cursor = conn.cursor()

    # Ensure adherence slots exist for active medications over the last 180 days (6 months) up to +60 days in future
    cursor.execute("SELECT id, start_date, time_of_day FROM medications WHERE user_email = ? AND (is_active = 1 OR is_active IS NULL)", (current_user.email,))
    meds = cursor.fetchall()

    today_date = datetime.date.today()
    start_window = today_date - datetime.timedelta(days=180)
    end_window = today_date + datetime.timedelta(days=60)

    for med in meds:
        med_id = med["id"]
        med_time = med["time_of_day"] if med["time_of_day"] else "08:00"
        med_start = med["start_date"] if med["start_date"] else start_window.isoformat()
        try:
            m_start_dt = datetime.date.fromisoformat(med_start[:10])
        except Exception:
            m_start_dt = start_window

        # Start slots from earliest window or med start date
        gen_start = min(start_window, m_start_dt)
        curr = gen_start
        while curr <= end_window:
            sch_time = f"{curr.isoformat()} {med_time}"
            cursor.execute("""
                INSERT INTO adherence (medication_id, taken_at, status, scheduled_time)
                SELECT ?, NULL, 'pending', ?
                WHERE NOT EXISTS (
                    SELECT 1 FROM adherence WHERE medication_id = ? AND scheduled_time = ?
                )
            """, (med_id, sch_time, med_id, sch_time))
            curr += datetime.timedelta(days=1)

    conn.commit()

    cursor.execute("""
    SELECT a.*, m.name as medication_name, m.dosage as medication_dosage, m.time_of_day as medication_time_of_day, m.is_active as medication_is_active
    FROM adherence a
    JOIN medications m ON a.medication_id = m.id
    WHERE m.user_email = ?
    ORDER BY a.scheduled_time ASC
    """, (current_user.email,))
    adherence = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return adherence


@app.post("/api/adherence/{adherence_id}")
def update_adherence_endpoint(adherence_id: int, req: AdherenceUpdateRequest, current_user: AuthenticatedUser = Depends(get_current_user)):
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S") if req.status == 'taken' else None
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    UPDATE adherence
    SET taken_at = ?, status = ?
    WHERE id = ? AND medication_id IN (SELECT id FROM medications WHERE user_email = ?)
    """, (now_str, req.status, adherence_id, current_user.email))
    conn.commit()
    
    # Get updated item
    cursor.execute("""
    SELECT a.*, m.name as medication_name, m.dosage as medication_dosage
    FROM adherence a
    JOIN medications m ON a.medication_id = m.id
    WHERE a.id = ? AND m.user_email = ?
    """, (adherence_id, current_user.email))
    row = cursor.fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Adherence record not found or not owned by user.")
    return {"success": True, "adherence_item": dict(row)}

@app.get("/api/patient/{patient_id}/full-history")
def get_patient_full_history_endpoint(patient_id: str, current_user: AuthenticatedUser = Depends(get_current_user)):
    """
    Unified Patient History Endpoint.
    Returns the complete linked medical history (Profile, Medications, Adherence, Symptoms, Allergies, Lab Reports, Doctor Notes)
    for a patient specified by patient_id or email.
    """
    history = get_patient_full_history_by_identifier(patient_id)
    if not history:
        raise HTTPException(status_code=404, detail="Patient history not found.")
    return history

@app.get("/api/symptom-suggest")
def suggest_medication_endpoint(symptom: str):
    """Suggests basic medications for a symptom based on local clinical guidelines, including brand price comparisons."""
    from medsafe_agent import load_guidelines
    
    guidelines = load_guidelines()
    symptom_medications = guidelines.get("symptom_medications", {})
    symptom_clean = symptom.strip().lower()
    
    matched_meds = []
    for sym_key, meds in symptom_medications.items():
        if sym_key in symptom_clean or symptom_clean in sym_key:
            matched_meds.extend(meds)
            
    unique_meds = list(dict.fromkeys(matched_meds))
    disclaimer = "Note: Only use recommended medications when explicitly prescribed by a doctor. MedSafe AI suggestions are for informational purposes only and do not replace professional medical advice."
    
    meds_details = []
    for med in unique_meds:
        clean_name = med.split("(")[0].strip()
        options = find_pricing_options(clean_name)
        cheapest = min(options, key=lambda x: x["price"]) if options else None
        cheapest_str = f"{cheapest['name']} at ₹{cheapest['price']:.2f} ({cheapest['pharmacy']})" if cheapest else ""
        
        meds_details.append({
            "name": med,
            "cheapest": cheapest_str,
            "options": options
        })
        
    return {
        "symptom": symptom,
        "medications": meds_details,
        "raw_names": unique_meds,
        "disclaimer": disclaimer,
        "found": len(unique_meds) > 0
    }

@app.get("/api/report")
def get_report_endpoint(current_user: AuthenticatedUser = Depends(get_current_user)):
    """Generates the data structure for a printable doctor report."""
    conn = get_connection()
    cursor = conn.cursor()
    
    # 1. Active medications
    cursor.execute("SELECT * FROM medications WHERE user_email = ?", (current_user.email,))
    meds = [dict(row) for row in cursor.fetchall()]
    
    # 2. Allergies
    cursor.execute("SELECT * FROM allergies WHERE user_email = ?", (current_user.email,))
    allergies = [row["name"] for row in cursor.fetchall()]
    
    # 3. Adherence summary (last 7 days)
    cursor.execute("""
    SELECT status, COUNT(*) as count 
    FROM adherence a
    JOIN medications m ON a.medication_id = m.id
    WHERE m.user_email = ?
      AND date(a.scheduled_time) >= date('now', '-7 days', 'localtime')
      AND date(a.scheduled_time) <= date('now', 'localtime')
    GROUP BY status
    """, (current_user.email,))
    status_counts = {row["status"]: row["count"] for row in cursor.fetchall()}
    
    # 4. Detailed adherence logs (strictly last 7 days)
    cursor.execute("""
    SELECT a.scheduled_time, a.status, a.taken_at,
           m.name AS medication_name, m.dosage AS medication_dosage
    FROM adherence a
    JOIN medications m ON a.medication_id = m.id
    WHERE m.user_email = ?
      AND date(a.scheduled_time) >= date('now', '-7 days', 'localtime')
      AND date(a.scheduled_time) <= date('now', 'localtime')
    ORDER BY a.scheduled_time DESC
    """, (current_user.email,))
    adherence_logs = [dict(row) for row in cursor.fetchall()]

    
    # 5. Symptom logs (last 7 days)
    cursor.execute("SELECT * FROM symptoms WHERE user_email = ? AND date(logged_at) >= date('now', '-7 days', 'localtime') AND date(logged_at) <= date('now', 'localtime') ORDER BY logged_at DESC", (current_user.email,))
    symptom_logs = [dict(row) for row in cursor.fetchall()]
    
    conn.close()
    
    # Compute adherence statistics
    taken = status_counts.get("taken", 0)
    skipped = status_counts.get("skipped", 0)
    pending = status_counts.get("pending", 0)
    total_doses = taken + skipped
    adherence_rate = (taken / total_doses * 100) if total_doses > 0 else 100.0
    
    return {
        "generated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "adherence_rate": round(adherence_rate, 1),
        "doses_taken": taken,
        "doses_skipped": skipped,
        "doses_pending": pending,
        "medications": meds,
        "allergies": allergies,
        "adherence_logs": adherence_logs,
        "symptoms": symptom_logs,
        "pdf_token": generate_download_token(99999, current_user.email)
    }

@app.get("/api/report/pdf")
def get_report_pdf_endpoint(
    email: str,
    token: str,
    doctor_notes: Optional[str] = ""
):
    """Generates and downloads a clean, styled PDF version of the doctor report."""
    if not verify_download_token(99999, email, token):
        raise HTTPException(status_code=403, detail="Access denied. Invalid or expired PDF download token.")
        
    # Fetch report data
    report = get_report_endpoint(current_user=AuthenticatedUser(email=email, username="", provider="local"))
    
    # Generate PDF using ReportLab
    from reportlab.lib.pagesizes import letter
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib import colors
    from io import BytesIO
    from fastapi import Response
    
    pdf_buffer = BytesIO()
    doc = SimpleDocTemplate(
        pdf_buffer,
        pagesize=letter,
        rightMargin=36,
        leftMargin=36,
        topMargin=36,
        bottomMargin=36
    )
    
    styles = getSampleStyleSheet()
    
    # Custom styles
    title_style = ParagraphStyle(
        name='DocTitle',
        fontName='Helvetica-Bold',
        fontSize=20,
        leading=24,
        textColor=colors.HexColor('#1e3a8a'),
        alignment=1, # Center
        spaceAfter=15
    )
    
    h2_style = ParagraphStyle(
        name='DocH2',
        fontName='Helvetica-Bold',
        fontSize=13,
        leading=16,
        textColor=colors.HexColor('#0f172a'),
        spaceBefore=15,
        spaceAfter=8,
        keepWithNext=True
    )
    
    normal_style = ParagraphStyle(
        name='DocNormal',
        fontName='Helvetica',
        fontSize=9,
        leading=13,
        textColor=colors.HexColor('#334155')
    )
    
    meta_style = ParagraphStyle(
        name='DocMeta',
        fontName='Helvetica',
        fontSize=9,
        leading=13,
        textColor=colors.HexColor('#475569')
    )

    story = []
    
    # Title
    story.append(Paragraph("MedSafe AI — Clinical Summary Report", title_style))
    
    # Meta Info Table
    meta_data = [
        [Paragraph(f"<b>Patient Email:</b> {email}", meta_style), Paragraph(f"<b>Generated At:</b> {report['generated_at']}", meta_style)],
        [Paragraph("<b>Status:</b> Local Self-Managed Active Profile", meta_style), Paragraph("<b>Storage System:</b> SQLite Local Sandbox", meta_style)]
    ]
    t_meta = Table(meta_data, colWidths=[270, 270])
    t_meta.setStyle(TableStyle([
        ('LINEBELOW', (0,1), (-1,-1), 1, colors.HexColor('#cbd5e1')),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
        ('TOPPADDING', (0,0), (-1,-1), 4),
    ]))
    story.append(t_meta)
    story.append(Spacer(1, 15))
    
    # Summary Stats Table
    stats_data = [
        ["Adherence Rate", "Doses Taken", "Doses Skipped", "Symptom Incidents"],
        [f"{report['adherence_rate']}%", str(report['doses_taken']), str(report['doses_skipped']), str(len(report['symptoms']))]
    ]
    t_stats = Table(stats_data, colWidths=[135, 135, 135, 135])
    t_stats.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#f1f5f9')),
        ('TEXTCOLOR', (0,0), (-1,0), colors.HexColor('#1e293b')),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE', (0,0), (-1,-1), 10),
        ('ALIGN', (0,0), (-1,-1), 'CENTER'),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#cbd5e1')),
        ('BACKGROUND', (0,1), (-1,1), colors.white),
        ('TEXTCOLOR', (0,1), (-1,1), colors.HexColor('#1e3a8a')),
        ('BOTTOMPADDING', (0,0), (-1,-1), 8),
        ('TOPPADDING', (0,0), (-1,-1), 8),
    ]))
    story.append(t_stats)
    story.append(Spacer(1, 15))
    
    # 1. Active Medications
    story.append(Paragraph("1. Active Medications & Schedules", h2_style))
    meds_headers = ["Medication", "Dosage", "Schedule", "Time of Day", "Started Date"]
    meds_rows = [meds_headers]
    for m in report["medications"]:
        meds_rows.append([
            Paragraph(f"<b>{m['name']}</b>", normal_style),
            m["dosage"],
            m["schedule_description"],
            m["time_of_day"],
            m["start_date"]
        ])
    if len(meds_rows) == 1:
        meds_rows.append(["No scheduled medications found.", "", "", "", ""])
    t_meds = Table(meds_rows, colWidths=[120, 90, 150, 90, 90])
    t_meds.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#f8fafc')),
        ('LINEBELOW', (0,0), (-1,0), 1.5, colors.HexColor('#94a3b8')),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#e2e8f0')),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('BOTTOMPADDING', (0,0), (-1,-1), 6),
        ('TOPPADDING', (0,0), (-1,-1), 6),
    ]))
    story.append(t_meds)
    story.append(Spacer(1, 12))
    
    # 2. Allergies
    story.append(Paragraph("2. Allergy Profile", h2_style))
    allergy_text = ", ".join(report["allergies"]) if report["allergies"] else "No registered clinical drug allergies."
    story.append(Paragraph(allergy_text, normal_style))
    story.append(Spacer(1, 12))
    
    # 3. Recent Symptom Logs
    story.append(Paragraph("3. Recent Symptom Logs (Past 30 Days)", h2_style))
    sym_headers = ["Logged Date", "Symptom", "Severity", "Correlated Med"]
    sym_rows = [sym_headers]
    for s in report["symptoms"]:
        sym_rows.append([
            s["logged_at"],
            s["description"],
            f"{s['severity']}/10",
            s["correlated_medication"] or "None"
        ])
    if len(sym_rows) == 1:
        sym_rows.append(["No symptoms logged in the past 30 days.", "", "", ""])
    t_sym = Table(sym_rows, colWidths=[150, 160, 90, 140])
    t_sym.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#f8fafc')),
        ('LINEBELOW', (0,0), (-1,0), 1.5, colors.HexColor('#94a3b8')),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#e2e8f0')),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('BOTTOMPADDING', (0,0), (-1,-1), 6),
        ('TOPPADDING', (0,0), (-1,-1), 6),
    ]))
    story.append(t_sym)
    story.append(Spacer(1, 15))
    
    # 4. Doctor's Notes & Recommendations
    if doctor_notes:
        story.append(Paragraph("4. Doctor's Notes & Recommendations", h2_style))
        story.append(Paragraph(doctor_notes.replace('\n', '<br/>'), normal_style))
        story.append(Spacer(1, 15))
        
    # Footer disclaimer
    story.append(Spacer(1, 20))
    story.append(Paragraph("<i>Disclaimer: Prepared by MedSafe AI. This local report summarizes self-recorded user data. Ensure to verify all details with your clinician before altering dosage.</i>", normal_style))
    
    doc.build(story)
    pdf_buffer.seek(0)
    
    return Response(
        content=pdf_buffer.getvalue(),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"attachment; filename=medsafe_clinical_report_{email.replace('@','_')}.pdf"
        }
    )

class DoctorNotesRequest(BaseModel):
    notes: List[str]

@app.get("/api/doctor-notes")
def get_doctor_notes_endpoint(current_user: AuthenticatedUser = Depends(get_current_user)):
    """Retrieves saved doctor notes for the current user as a list of strings."""
    import json
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT notes FROM doctor_notes WHERE user_email = ?", (current_user.email,))
    row = cursor.fetchone()
    conn.close()
    if row:
        val = row["notes"]
        try:
            parsed = json.loads(val)
            if isinstance(parsed, list):
                return {"notes": parsed}
        except:
            # Fallback to legacy single note converted to a list of non-empty lines
            lines = [l.strip() for l in val.split('\n') if l.strip()]
            return {"notes": lines}
    return {"notes": []}

@app.post("/api/doctor-notes")
def save_doctor_notes_endpoint(req: DoctorNotesRequest, current_user: AuthenticatedUser = Depends(get_current_user)):
    """Saves or updates doctor notes for the current user."""
    import json
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    INSERT OR REPLACE INTO doctor_notes (user_email, notes)
    VALUES (?, ?)
    """, (current_user.email, json.dumps(req.notes)))
    conn.commit()
    conn.close()
    return {"success": True, "message": "Doctor notes saved successfully."}

@app.post("/api/lab-reports")
async def upload_lab_report_endpoint(
    report_label: str = Form(...),
    file: UploadFile = File(...),
    current_user: AuthenticatedUser = Depends(get_current_user)
):
    """Processes an uploaded lab report, stores the raw file locally, and saves metadata to the database."""
    file_bytes = await file.read()
    safe_filename = os.path.basename(file.filename)
    
    # Save the file to UPLOADS_DIR
    file_path = os.path.join(UPLOADS_DIR, safe_filename)
    try:
        with open(file_path, "wb") as f:
            f.write(file_bytes)
    except Exception as e:
        print(f"[MedSafe AI] Failed to save uploaded lab report file: {e}")
        file_path = None
        
    # Save metadata to database without performing analysis
    conn = get_connection()
    cursor = conn.cursor()
    uploaded_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute("""
    INSERT INTO lab_reports (user_email, filename, report_label, file_content_text, ai_analysis, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?)
    """, (current_user.email, safe_filename, report_label, "", "", uploaded_at))
    conn.commit()
    report_id = cursor.lastrowid
    conn.close()

    try:
        try:
            from supabase_client import sync_lab_report_to_supabase
        except ImportError:
            from backend.supabase_client import sync_lab_report_to_supabase
        sync_lab_report_to_supabase(
            user_email=current_user.email,
            filename=safe_filename,
            report_label=report_label,
            file_content_text="",
            ai_analysis="",
            uploaded_at=uploaded_at
        )
    except Exception as exc:
        print(f"[MedSafe AI] Could not sync report to Supabase: {exc}")
    
    return {
        "id": report_id,
        "user_email": current_user.email,
        "filename": safe_filename,
        "report_label": report_label,
        "ai_analysis": "",
        "uploaded_at": uploaded_at
    }

@app.get("/api/lab-reports")
def get_lab_reports_endpoint(current_user: AuthenticatedUser = Depends(get_current_user)):
    """Retrieves all lab reports/blood tests uploaded by the active user."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT id, filename, report_label, uploaded_at 
    FROM lab_reports 
    WHERE user_email = ? 
    ORDER BY uploaded_at DESC
    """, (current_user.email,))
    reports = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return reports

import hmac
import hashlib
import time

SECRET_KEY = os.environ.get("SESSION_SECRET_KEY", "medsafe-local-development-secret-key-12345")

def generate_download_token(report_id: int, email: str) -> str:
    # Token valid for 5 minutes (300 seconds)
    expires = int(time.time()) + 300
    message = f"{report_id}:{email}:{expires}"
    signature = hmac.new(SECRET_KEY.encode(), message.encode(), hashlib.sha256).hexdigest()
    return f"{expires}:{signature}"

def verify_download_token(report_id: int, email: str, token_str: str) -> bool:
    try:
        expires_str, signature = token_str.split(":")
        expires = int(expires_str)
        if time.time() > expires:
            return False # Token expired
        message = f"{report_id}:{email}:{expires}"
        expected_signature = hmac.new(SECRET_KEY.encode(), message.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected_signature, signature)
    except Exception:
        return False

@app.get("/api/lab-reports/{report_id}")
def get_lab_report_details_endpoint(report_id: int, current_user: AuthenticatedUser = Depends(get_current_user)):
    """Gets details and clinical analysis for a specific lab report."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT * FROM lab_reports 
    WHERE id = ? AND user_email = ?
    """, (report_id, current_user.email))
    row = cursor.fetchone()
    conn.close()
    
    if not row:
        raise HTTPException(status_code=404, detail="Lab report not found or access denied.")
        
    report_dict = dict(row)
    report_dict["download_token"] = generate_download_token(report_id, current_user.email)
    return report_dict

@app.get("/api/lab-reports/download/{report_id}")
def download_lab_report_endpoint(
    report_id: int,
    email: str,
    token: str
):
    """Securely downloads the uploaded lab report file for the user using a cryptographic token validation."""
    if not verify_download_token(report_id, email, token):
        raise HTTPException(status_code=403, detail="Access denied. Invalid or expired download token.")

    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT filename, user_email FROM lab_reports WHERE id = ?", (report_id,))
    row = cursor.fetchone()
    conn.close()
    
    if not row:
        raise HTTPException(status_code=404, detail="Report not found.")
        
    if row["user_email"] != email:
        raise HTTPException(status_code=403, detail="Access denied.")
        
    filename = row["filename"]
    file_path = os.path.join(UPLOADS_DIR, filename)
    
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Physical file not found on server.")
        
    return FileResponse(
        path=file_path,
        filename=filename,
        media_type="application/octet-stream"
    )

@app.put("/api/lab-reports/{report_id}")
def update_lab_report_label_endpoint(
    report_id: int,
    payload: dict,
    current_user: AuthenticatedUser = Depends(get_current_user)
):
    """Updates the report label of an uploaded lab report."""
    report_label = payload.get("report_label")
    if not report_label:
        raise HTTPException(status_code=400, detail="Missing report_label in payload.")
        
    conn = get_connection()
    cursor = conn.cursor()
    
    # Ownership verification
    cursor.execute("SELECT id FROM lab_reports WHERE id = ? AND user_email = ?", (report_id, current_user.email))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Report not found or access denied.")
        
    cursor.execute("""
    UPDATE lab_reports 
    SET report_label = ? 
    WHERE id = ? AND user_email = ?
    """, (report_label, report_id, current_user.email))
    conn.commit()
    conn.close()
    return {"success": True, "message": "Report label updated successfully."}

@app.delete("/api/lab-reports/{report_id}")
def delete_lab_report_endpoint(report_id: int, current_user: AuthenticatedUser = Depends(get_current_user)):
    """Deletes an uploaded lab report."""
    conn = get_connection()
    cursor = conn.cursor()
    
    # Ownership verification
    cursor.execute("SELECT filename FROM lab_reports WHERE id = ? AND user_email = ?", (report_id, current_user.email))
    row = cursor.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Report not found or access denied.")
    
    filename_to_del = row["filename"]
    cursor.execute("DELETE FROM lab_reports WHERE id = ? AND user_email = ?", (report_id, current_user.email))
    conn.commit()
    conn.close()

    try:
        try:
            from supabase_client import delete_lab_report_from_supabase
        except ImportError:
            from backend.supabase_client import delete_lab_report_from_supabase
        delete_lab_report_from_supabase(user_email=current_user.email, filename=filename_to_del)
    except Exception:
        pass
    return {"message": "Lab report deleted successfully."}

# Mount frontend directory static files at root for local development
FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../frontend"))

if os.path.exists(FRONTEND_DIR):
    @app.get("/")
    def read_root():
        index_path = os.path.join(FRONTEND_DIR, "index.html")
        if os.path.exists(index_path):
            return FileResponse(index_path)
        return {"status": "ok", "service": "MedSafe AI Backend"}

    try:
        app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
    except Exception:
        pass

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
