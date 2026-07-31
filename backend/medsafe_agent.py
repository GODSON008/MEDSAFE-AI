import os
import re
import json
import asyncio
import datetime
import urllib.request
import urllib.parse
import ssl
from typing import AsyncGenerator, Optional, List, Dict, Any
try:
    from google.antigravity import Agent, LocalAgentConfig, types
    from google.antigravity.policy import allow_all
    HAS_ANTIGRAVITY = True
except (ImportError, ModuleNotFoundError):
    HAS_ANTIGRAVITY = False
    Agent = None
    LocalAgentConfig = None
    types = None
    allow_all = None

from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

from database import get_connection

# Get absolute path to the mcp server file
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
MCP_SERVER_PATH = os.path.join(CURRENT_DIR, "mcp_server.py")
GUIDELINES_PATH = os.path.join(CURRENT_DIR, "clinical_guidelines.json")

SYSTEM_INSTRUCTIONS = """You are MedSafe AI, a privacy-first, local-first personal health and medication safety coordinator.
You help users schedule medications, log symptoms, track compliance (adherence), and perform proactive drug safety checks.

Core Rules & Instructions:
1. Tone: Empathetic, supportive, clear, and professional. You handle sensitive health data.
2. Privacy: All data is saved locally on the user's computer via an SQLite database accessed through your MCP tools. Remind the user of this privacy-first model if they express concern.
3. Smart Medication Entry:
   - When a user wants to add a medication (e.g., "I need to take Lisinopril 10mg every morning"), you MUST:
     a. Call the `check_safety` tool FIRST. Pass the name of the medication.
     b. If `check_safety` returns warnings (allergy conflicts or drug-drug interactions), you MUST present these warning flags immediately, indicating the severity (High/Medium/Low) and the clinical reason. Ask the user if they still want to proceed, or if they'd like to consult their doctor.
     c. If there are no safety flags, or if the user explicitly confirms they want to proceed despite a warning, call the `add_medication` tool with structured values. Infer dosage, schedule description, frequency, and time of day (e.g. '08:00' for morning, '20:00' for evening).
     d. Confirm to the user that the medication is added and scheduled.
4. Symptom Logging:
   - If the user reports a symptom, call the `log_symptom` tool. If they don't specify a severity, ask them to rate it from 1 (mild) to 10 (severe).
   - Also lookup basic medicine recommendations for this symptom using the `suggest_medication` tool and display them with the required clinician disclaimer.
   - If they report a symptom, query the active medications. Suggest if any of the medications might relate to the symptom based on the time it was taken or active drugs, and offer to correlate them.
5. Safety Checking:
   - Always run safety checks when new medications are mentioned. If the user has a listed allergy (like Penicillin) and tries to add a drug in that family (like Amoxicillin), warn them. If they take blood thinners (like Warfarin) and try to add Aspirin, warn them of bleeding risks.
6. Local Clinical Guidelines: You have access to a custom database checking logic through `check_safety`. Rely on it to scan active medications and allergies against guidelines.
7. Symptom to Medicine Suggestion: If the user asks what basic medications they can take for a symptom (e.g., 'what should I take for a headache?'), call the `suggest_medication` tool. List the suggested medications and always include the warning: *"Note: Only use recommended medications when explicitly prescribed by a doctor. MedSafe AI suggestions are for informational purposes only and do not replace professional medical advice."*
8. General Medicine/Drug Inquiry: If the user asks for details about any drug (such as brand names, generic names, active ingredients, usage, dosage, side effects, warnings, or interactions) that is not in their local list, or wants general information about a medication, you MUST call the `query_openfda_drug_info` tool to fetch accurate and detailed data from the openFDA database. Format the response professionally and clearly.

Always use your tools to query the active state before replying about what medications or allergies are in the user's profile.
"""

# Fallback session state for rule-based fallback agent
SESSION_STATE = {}

def get_user_session(user_email: str) -> dict:
    if user_email not in SESSION_STATE:
        SESSION_STATE[user_email] = {
            "pending_medication": None,
            "last_symptom": None
        }
    return SESSION_STATE[user_email]

def load_guidelines():
    try:
        with open(GUIDELINES_PATH, "r") as f:
            return json.load(f)
    except:
        return {"allergy_classes": {}, "drug_interactions": []}

def check_safety_local(med_name: str, user_email: str = 'guest@medsafe.ai') -> dict:
    """Helper to check safety directly for the fallback agent."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT DISTINCT name FROM medications WHERE user_email = ?", (user_email,))
    active_meds = [row["name"].strip().lower() for row in cursor.fetchall()]
    cursor.execute("SELECT name FROM allergies WHERE user_email = ?", (user_email,))
    allergies = [row["name"].strip().lower() for row in cursor.fetchall()]
    conn.close()
    
    guidelines = load_guidelines()
    warnings = []
    med_name_clean = med_name.strip().lower()
    
    # Check allergies
    for allergy_class, drugs in guidelines.get("allergy_classes", {}).items():
        allergy_class_clean = allergy_class.strip().lower()
        if allergy_class_clean in allergies:
            drugs_clean = [d.strip().lower() for d in drugs]
            if med_name_clean in drugs_clean or allergy_class_clean in med_name_clean:
                warnings.append({
                    "type": "allergy",
                    "severity": "High",
                    "message": f"⚠️ Allergy Alert: You have a Penicillin allergy. '{med_name}' is in the Penicillin family." if "penicillin" in allergy_class_clean else f"⚠️ Allergy Alert: You are allergic to {allergy_class}."
                })
                
    # Check interactions
    for interaction in guidelines.get("drug_interactions", []):
        inter_drugs = [d.strip().lower() for d in interaction["drugs"]]
        if med_name_clean in inter_drugs:
            other_drug = [d for d in inter_drugs if d != med_name_clean][0]
            if other_drug in active_meds:
                warnings.append({
                    "type": "interaction",
                    "severity": interaction["severity"],
                    "message": f"⚠️ Drug Interaction ({interaction['severity']}): Taking '{med_name}' with '{other_drug}' is a clinical risk. {interaction['warning']}"
                })
                
    return {"safe": len(warnings) == 0, "warnings": warnings}

def format_medicine_pricing_markdown(medication_name: str) -> str:
    from database import find_pricing_options
    clean_name = medication_name.split("(")[0].strip()
    if not clean_name:
        clean_name = medication_name.strip()
        
    options = find_pricing_options(clean_name)
    
    parts = []
    parts.append(f"## 🛒 Where to Find & Buy **{clean_name.capitalize()}**")
    parts.append("Compare available brand vs. generic pricing options below to order online or find at local pharmacies:\n")
    
    if options:
        parts.append("| Product / Brand | Pharmacy | Price | Quantity | Unit Price | Direct Order Link |")
        parts.append("| :--- | :--- | :--- | :--- | :--- | :--- |")
        for opt in options:
            is_generic = "generic" in opt["name"].lower()
            name_display = f"**{opt['name']}**" if is_generic else opt["name"]
            parts.append(f"| {name_display} | {opt['pharmacy']} | ₹{opt['price']:.2f} | {opt['quantity']} | ₹{opt['unit_price']:.2f} / dose | [🛒 Order Now]({opt['link']}) |")
        
        cheapest = min(options, key=lambda x: x["price"])
        parts.append(f"\n🌟 **Best Value Option:** **{cheapest['name']}** at **₹{cheapest['price']:.2f}** from {cheapest['pharmacy']}.\n")
    
def format_cheapest_and_alternatives_card(prompt: str) -> str:
    """Detects if prompt asks about a medicine, and generates the Cheapest Buy Option & Alternatives card at the end of AI response."""
    from database import find_pricing_options, DRUG_PRICING_DATABASE
    prompt_clean = prompt.lower().strip()
    
    # Check if prompt contains any drug name
    detected_drug = None
    
    # 1. Match against DRUG_PRICING_DATABASE keys
    for drug_key in DRUG_PRICING_DATABASE.keys():
        if drug_key in prompt_clean:
            detected_drug = drug_key
            break
            
    # 2. Match common drug pattern words if not found in database keys
    if not detected_drug:
        common_meds = [
            "paracetamol", "amoxicillin", "lisinopril", "metformin", "atorvastatin", 
            "aspirin", "ibuprofen", "omeprazole", "amlodipine", "losartan", 
            "albuterol", "salbutamol", "cetirizine", "azithromycin", "pantoprazole",
            "famotidine", "ciprofloxacin", "doxycycline", "gabapentin", "prednisone"
        ]
        for med in common_meds:
            if med in prompt_clean:
                detected_drug = med
                break
                
    # 3. If query mentions words like "medicine", "tablet", "capsule", "drug", "syrup", "pill", "buy", "take"
    if not detected_drug:
        words = prompt_clean.replace("?", " ").replace(".", " ").replace(",", " ").split()
        ignore_words = {"what", "when", "how", "where", "take", "does", "have", "with", "this", "from", "your", "help", "about", "tell", "give", "info", "details", "side", "effects"}
        for w in words:
            if len(w) >= 4 and w not in ignore_words:
                options = find_pricing_options(w)
                if options and any(w in opt["name"].lower() for opt in options):
                    detected_drug = w
                    break
                    
    if not detected_drug:
        return ""
        
    options = find_pricing_options(detected_drug)
    if not options:
        return ""
        
    # Sort options by price ascending
    sorted_options = sorted(options, key=lambda x: x["price"])
    cheapest = sorted_options[0]
    alternatives = sorted_options[1:]
    
    card_parts = []
    card_parts.append("\n\n---\n")
    card_parts.append(f"### 🛒 Cheapest Buy Option & Alternative Brands for **{detected_drug.capitalize()}**\n")
    
    # 1. Cheapest Buy Option
    card_parts.append(f"🌟 **Cheapest Buy Option:**")
    card_parts.append(f"- **{cheapest['name']}** — **₹{cheapest['price']:.2f}** ({cheapest['pharmacy']}, {cheapest['quantity']})")
    card_parts.append(f"  👉 [🛒 Buy Cheapest Option Now]({cheapest['link']})\n")
    
    # 2. Alternative Brands
    if alternatives:
        card_parts.append(f"🔄 **Alternative Brand Options:**")
        for alt in alternatives:
            card_parts.append(f"- **{alt['name']}** — **₹{alt['price']:.2f}** ({alt['pharmacy']}, {alt['quantity']}) | [🛒 Order Alternative]({alt['link']})")
        card_parts.append("")
        
    return "\n".join(card_parts)

def suggest_medication_local(symptom: str) -> str:
    """Helper to suggest medications directly for the fallback agent, comparing brands and adding buy links."""
    from database import find_pricing_options
    
    guidelines = load_guidelines()
    symptom_medications = guidelines.get("symptom_medications", {})
    symptom_clean = symptom.strip().lower()
    
    matched_meds = []
    for sym_key, meds in symptom_medications.items():
        if sym_key in symptom_clean or symptom_clean in sym_key:
            matched_meds.extend(meds)
            
    unique_meds = list(dict.fromkeys(matched_meds))
    disclaimer = "⚠️ **Note:** Only use recommended medications when explicitly prescribed by a doctor. MedSafe AI suggestions are for informational purposes only and do not replace professional medical advice."
    
    if not unique_meds:
        return f"I couldn't find any specific medicine suggestions in my local guidelines database for *\"{symptom}\"*. Please consult your physician.\n\n{disclaimer}"
        
    response_parts = []
    meds_str = ", ".join([f"**{m}**" for m in unique_meds])
    response_parts.append(f"Based on local clinical guidelines, standard medications associated with *\"{symptom}\"* are: {meds_str}.\n")
    response_parts.append("### 💰 Price Comparison & Purchasing Links\n")
    
    for med in unique_meds:
        clean_name = med.split("(")[0].strip()
        options = find_pricing_options(clean_name)
        
        response_parts.append(f"#### {med}")
        if options:
            response_parts.append("| Product / Brand | Pharmacy | Price | Quantity | Unit Price | Buy Link |")
            response_parts.append("| :--- | :--- | :--- | :--- | :--- | :--- |")
            for opt in options:
                is_generic = "generic" in opt["name"].lower()
                name_display = f"**{opt['name']}**" if is_generic else opt["name"]
                response_parts.append(f"| {name_display} | {opt['pharmacy']} | ₹{opt['price']:.2f} | {opt['quantity']} | ₹{opt['unit_price']:.2f} / dose | [🛒 Buy now]({opt['link']}) |")
            
            cheapest = min(options, key=lambda x: x["price"])
            response_parts.append(f"\n🌟 **Cheapest Option:** **{cheapest['name']}** at **₹{cheapest['price']:.2f}** from {cheapest['pharmacy']}.\n")
        else:
            response_parts.append("No price comparison data available for this medication.\n")
            
    response_parts.append(disclaimer)
    return "\n".join(response_parts)


def add_medication_local(name: str, dosage: str, schedule: str, frequency: str, time_of_day: str, user_email: str = 'guest@medsafe.ai') -> dict:
    conn = get_connection()
    cursor = conn.cursor()
    
    # Check if exact same medication details are already scheduled for this user
    cursor.execute("""
    SELECT id, is_active FROM medications 
    WHERE user_email = ? AND LOWER(name) = LOWER(?) AND dosage = ? AND frequency = ? AND time_of_day = ?
    """, (user_email, name, dosage, frequency, time_of_day))
    row = cursor.fetchone()
    if row:
        med_id = row["id"]
        is_act = row["is_active"]
        if is_act == 0:
            cursor.execute("UPDATE medications SET is_active = 1, end_date = NULL WHERE id = ?", (med_id,))
            conn.commit()
        conn.close()
        return {"id": med_id, "name": name, "dosage": dosage, "schedule": schedule, "time_of_day": time_of_day, "already_exists": True}

    today = datetime.date.today().isoformat()
    cursor.execute("""
    INSERT INTO medications (name, dosage, schedule_description, frequency, time_of_day, start_date, user_email, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    """, (name, dosage, schedule, frequency, time_of_day, today, user_email))
    med_id = cursor.lastrowid
    
    # Add adherence slots for next 7 days
    for i in range(7):
        day = (datetime.date.today() + datetime.timedelta(days=i)).isoformat()
        cursor.execute("""
        INSERT INTO adherence (medication_id, taken_at, status, scheduled_time)
        VALUES (?, NULL, 'pending', ?)
        """, (med_id, f"{day} {time_of_day}"))
        
    conn.commit()
    conn.close()
    return {"id": med_id, "name": name, "dosage": dosage, "schedule": schedule, "time_of_day": time_of_day}

def log_symptom_local(description: str, severity: int, correlated_med: str = None, user_email: str = 'guest@medsafe.ai') -> dict:
    conn = get_connection()
    cursor = conn.cursor()
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute("""
    INSERT INTO symptoms (description, severity, logged_at, correlated_medication, user_email)
    VALUES (?, ?, ?, ?, ?)
    """, (description, severity, now, correlated_med, user_email))
    s_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return {"id": s_id, "description": description, "severity": severity, "logged_at": now, "correlated_medication": correlated_med}

def parse_medication_request(prompt_clean: str):
    # Check if there is an intent to add/take/schedule
    if not any(k in prompt_clean for k in ["add", "take", "schedule", "prescribe", "need to", "log"]):
        # Skip if it looks like a query or symptom
        return None
    if any(k in prompt_clean for k in ["symptom", "dizzy", "headache", "pain", "nausea", "feeling", "allergic", "allergy"]):
        return None
        
    # Extract dosage (e.g., 10mg, 500 mcg, 5 ml, 2 tablets)
    dosage_match = re.search(r"(\d+\s*(?:mg|mcg|g|ml|tablets|tablet|pills|pill|capsules|capsule|units|unit))", prompt_clean)
    if not dosage_match:
        return None
    dosage = dosage_match.group(1)
    
    # Extract drug name before dosage
    parts = prompt_clean.split(dosage)
    words_before = parts[0].strip().split()
    stopwords = {"add", "take", "schedule", "medication", "drug", "pill", "pills", "dose", "daily", "every", "need", "to", "a", "an", "the", "of", "log", "start"}
    drug_name = None
    for word in reversed(words_before):
        word_clean = re.sub(r"[^a-zA-Z\-]", "", word)
        if word_clean and word_clean not in stopwords:
            drug_name = word_clean.capitalize()
            break
            
    if not drug_name:
        return None
        
    # Extract schedule
    schedule = "daily"
    schedule_phrases = ["every morning", "every evening", "every night", "daily", "twice a day", "twice daily", "three times a day", "every 8 hours", "every 12 hours", "every afternoon", "at night", "in the morning", "in the evening", "at lunch"]
    for phrase in schedule_phrases:
        if phrase in prompt_clean:
            schedule = phrase
            break
            
    return {
        "name": drug_name,
        "dosage": dosage,
        "schedule": schedule
    }

def fallback_chat_processor(prompt: str, user_email: str = 'guest@medsafe.ai') -> str:
    """A rule-based natural language processing engine that acts as the Fallback Agent."""
    prompt_clean = prompt.strip().lower()
    session = get_user_session(user_email)

    disease_kb = {
        "diabetes": {
            "name": "Diabetes Mellitus",
            "overview": "A chronic metabolic condition characterized by elevated blood glucose levels resulting from defects in insulin secretion, insulin action, or both.",
            "symptoms": ["Polyuria (increased urination)", "Polydipsia (increased thirst)", "Unexplained weight loss", "Fatigue", "Blurred vision"],
            "treatments": "Metformin, Insulin therapy, SGLT2 inhibitors, GLP-1 receptor agonists, low-glycemic nutrition, and regular exercise.",
            "precautions": "Monitor blood glucose and HbA1c regularly. Avoid refined sugars and monitor for signs of hypoglycemia (dizziness, shakiness)."
        },
        "hypertension": {
            "name": "Hypertension (High Blood Pressure)",
            "overview": "A common cardiovascular condition where long-term force of blood against arterial walls is persistently elevated (≥130/80 mmHg).",
            "symptoms": ["Often asymptomatic ('silent killer')", "Morning headaches", "Shortness of breath", "Dizziness", "Chest tightness"],
            "treatments": "ACE inhibitors (e.g. Lisinopril), ARBs (Losartan), Calcium channel blockers (Amlodipine), and low-sodium DASH diet.",
            "precautions": "Restrict sodium intake to <2,000mg/day, limit alcohol, avoid smoking, and monitor blood pressure weekly."
        },
        "asthma": {
            "name": "Bronchial Asthma",
            "overview": "A chronic respiratory disorder causing airway inflammation, narrowing, and hyperresponsiveness to environmental triggers.",
            "symptoms": ["Wheezing", "Shortness of breath", "Chest tightness", "Coughing (especially at night or early morning)"],
            "treatments": "Inhaled corticosteroids (Fluticasone, Budesonide), Short-acting beta-agonists (Albuterol/Salbutamol rescue inhalers).",
            "precautions": "Avoid known allergens (dust mites, pollen, smoke, cold air). Keep rescue inhaler accessible at all times."
        },
        "fever": {
            "name": "Pyrexia (Fever)",
            "overview": "A temporary elevation in core body temperature (≥38°C / 100.4°F), typically part of an immune response to viral or bacterial infection.",
            "symptoms": ["Chills and shivering", "Sweating", "General muscle aches", "Dehydration and lethargy"],
            "treatments": "Paracetamol (Acetaminophen 500mg), Ibuprofen (400mg), fluid replacement, and physical cooling.",
            "precautions": "Consult a physician if fever exceeds 39.5°C (103°F), persists beyond 3 days, or is accompanied by stiff neck or shortness of breath."
        },
        "acid reflux": {
            "name": "Gastroesophageal Reflux Disease (GERD)",
            "overview": "Stomach acid repeatedly flows back into the esophagus, irritating the esophageal lining.",
            "symptoms": ["Heartburn (burning chest pain)", "Regurgitation of food/acid", "Difficulty swallowing", "Chronic dry cough"],
            "treatments": "Antacids, H2 blockers (Famotidine), Proton pump inhibitors (Omeprazole, Pantoprazole).",
            "precautions": "Avoid lying down for 3 hours after meals. Limit caffeine, chocolate, spicy foods, and alcohol."
        }
    }
    
    # 1. Handle confirmation of pending medication safety warnings
    if session.get("pending_medication") and any(w in prompt_clean for w in ["yes", "confirm", "add it", "proceed", "add"]):
        med = session["pending_medication"]
        session["pending_medication"] = None
        res = add_medication_local(med["name"], med["dosage"], med["schedule"], med["frequency"], med["time_of_day"], user_email)
        return f"Understood. I have added **{res['name']} {res['dosage']}** ({res['schedule']}) to your active schedule despite the safety warnings. Please take it with caution."
        
    if session.get("pending_medication") and any(w in prompt_clean for w in ["no", "cancel", "stop", "don't"]):
        session["pending_medication"] = None
        return "Medication addition cancelled. Let me know if you need to schedule something else or manage your allergies."

    # 1a. Handle confirmation of pending file data addition
    if session.get("pending_file_data") and any(w in prompt_clean for w in ["yes", "confirm", "add it", "proceed", "add"]):
        data = session["pending_file_data"]
        session["pending_file_data"] = None
        
        added_meds = []
        for med in data.get("medications", []):
            res = add_medication_local(med["name"], med["dosage"], med["schedule"], med["frequency"], med["time_of_day"], user_email)
            added_meds.append(f"**{res['name']} {res['dosage']}**")
            
        added_allergies = []
        conn = get_connection()
        cursor = conn.cursor()
        for allergy in data.get("allergies", []):
            try:
                cursor.execute("INSERT OR IGNORE INTO allergies (name, user_email) VALUES (?, ?)", (allergy, user_email))
                added_allergies.append(allergy)
            except sqlite3.IntegrityError:
                pass
        conn.commit()
        conn.close()
        
        resp = "Understood. I have updated your profile with the details from your report:\n"
        if added_meds:
            resp += f"- Added Medications: {', '.join(added_meds)}\n"
        if added_allergies:
            resp += f"- Added Allergies: {', '.join(added_allergies)}\n"
        resp += "\nAll scheduling trackers have been generated."
        return resp

    if session.get("pending_file_data") and any(w in prompt_clean for w in ["no", "cancel", "stop", "don't"]):
        session["pending_file_data"] = None
        return "Understood. I have ignored the extraction results from the report. Let me know if you need any other assistance."

    # 1b. Parse file content if present in prompt
    if "=== FILE CONTENT ===" in prompt:
        filename_match = re.search(r"medical statement file: '([^']+)'", prompt)
        filename = filename_match.group(1) if filename_match else "Attached Report"
        
        content_match = re.search(r"=== FILE CONTENT ===\n(.*?)\n====================", prompt, re.DOTALL)
        file_content = content_match.group(1) if content_match else ""
        
        common_drugs = ["lisinopril", "warfarin", "amoxicillin", "aspirin", "ibuprofen", "acetaminophen", "paracetamol", "cetirizine", "loratadine", "omeprazole", "famotidine", "dextromethorphan", "guaifenesin", "loperamide", "metformin", "atorvastatin", "albuterol"]
        common_allergies = ["penicillin", "sulfa", "peanuts", "latex"]
        
        found_meds = []
        found_allergies = []
        
        for drug in common_drugs:
            drug_match = re.search(r"\b" + re.escape(drug) + r"\b", file_content, re.IGNORECASE)
            if drug_match:
                dosage_match = re.search(r"\b" + re.escape(drug) + r"\b\s*(\d+\s*(?:mg|mcg|g|ml))", file_content, re.IGNORECASE)
                dosage = dosage_match.group(1) if dosage_match else "500mg"
                
                schedule = "daily"
                time_of_day = "08:00"
                if re.search(r"\b" + re.escape(drug) + r"\b.*?morning", file_content, re.IGNORECASE):
                    schedule = "every morning"
                elif re.search(r"\b" + re.escape(drug) + r"\b.*?evening", file_content, re.IGNORECASE):
                    schedule = "every evening"
                    time_of_day = "20:00"
                elif re.search(r"\b" + re.escape(drug) + r"\b.*?night", file_content, re.IGNORECASE):
                    schedule = "at night"
                    time_of_day = "20:00"
                    
                found_meds.append({
                    "name": drug.capitalize(),
                    "dosage": dosage,
                    "schedule": schedule,
                    "frequency": "daily",
                    "time_of_day": time_of_day
                })
                
        for allergy in common_allergies:
            allergy_match = re.search(r"\b" + re.escape(allergy) + r"\b", file_content, re.IGNORECASE)
            if allergy_match:
                found_allergies.append(allergy.capitalize())
                
        if found_meds or found_allergies:
            session["pending_file_data"] = {
                "medications": found_meds,
                "allergies": found_allergies
            }
            
            resp = f"📎 **Medical Statement '{filename}' Parsed successfully**\n\nI scanned the statement and extracted the following potential updates for your profile:\n\n"
            if found_meds:
                resp += "**Medications Found:**\n"
                for med in found_meds:
                    resp += f"- {med['name']} {med['dosage']} ({med['schedule']})\n"
                resp += "\n"
            if found_allergies:
                resp += "**Allergies Found:**\n"
                for allergy in found_allergies:
                    resp += f"- {allergy}\n"
                resp += "\n"
                
            resp += "Would you like me to add these details to your active safety and medication profile? (Reply with **Yes** or **No**)"
            return resp
        else:
            return f"📎 **Medical Statement '{filename}' Parsed**\n\nI reviewed the attached statement but did not find any matching medication schedules or drug allergies in my local rules index. Let me know if you want me to help you schedule one manually!"
        
    # 2. Add Medication pattern (Smart Entry)
    med_info = parse_medication_request(prompt_clean)
    if med_info:
        name = med_info["name"]
        dosage = med_info["dosage"]
        schedule = med_info["schedule"]
        
        # Determine frequency and time_of_day
        frequency = "daily"
        time_of_day = "08:00"
        if "evening" in schedule or "night" in schedule:
            time_of_day = "20:00"
        elif "afternoon" in schedule or "lunch" in schedule:
            time_of_day = "13:00"
        elif "twice" in schedule:
            frequency = "twice a day"
            time_of_day = "08:00" # default morning
            
        # Check safety first
        safety = check_safety_local(name, user_email)
        if not safety["safe"]:
            session["pending_medication"] = {
                "name": name,
                "dosage": dosage,
                "schedule": schedule,
                "frequency": frequency,
                "time_of_day": time_of_day
            }
            warning_messages = "\n".join([w["message"] for w in safety["warnings"]])
            return f"🚨 **Safety Conflict Warning** 🚨\n\nI detected potential issues with adding **{name}**:\n{warning_messages}\n\nDo you still wish to add this medication? Please respond with **Yes** or **No**."
            
        # If safe, add it
        res = add_medication_local(name, dosage, schedule, frequency, time_of_day, user_email)
        if res.get("already_exists"):
            return f"ℹ️ **Medication Already Scheduled**\n\n**{res['name']} {res['dosage']}** ({res['schedule']}) is already active in your medication schedule list."
        return f"✅ **Medication Added successfully!**\n\nI have scheduled **{res['name']} {res['dosage']}** to be taken **{res['schedule']}** (scheduled time of day: {res['time_of_day']}). I also added its checklist tracker for the next 7 days."

    # 3. Medicine-Symptom Suggestion
    suggest_trigger = any(k in prompt_clean for k in ["what can i take for", "what should i take for", "what to take for", "what helps with", "medicine for", "treatment for", "remedy for", "cure for", "how to treat"])
    if suggest_trigger:
        symptom_queried = None
        for k in ["what can i take for", "what should i take for", "what to take for", "what helps with", "medicine for", "treatment for", "remedy for", "cure for", "how to treat"]:
            if k in prompt_clean:
                symptom_queried = prompt_clean.split(k)[1].strip()
                symptom_queried = re.sub(r"[?.]", "", symptom_queried).strip()
                break
        if symptom_queried:
            return suggest_medication_local(symptom_queried)

    # 4. Medicine/Drug API Query & Buying Options (openFDA + Price Comparison)
    buying_triggers = [
        "where to buy", "where can i buy", "where to get", "where can i get", 
        "find medicine", "search medicine", "where do i find", "price of", 
        "order ", "pharmacy for"
    ]
    buy_target = None
    for trigger in buying_triggers:
        if trigger in prompt_clean:
            buy_target = prompt_clean.split(trigger)[1].strip()
            buy_target = re.sub(r"[?.]", "", buy_target).strip()
            break

    if buy_target:
        pricing_tables = format_medicine_pricing_markdown(buy_target)
        fda_details = query_openfda_local(buy_target)
        return f"{pricing_tables}\n\n{fda_details}"

    drug_query_triggers = [
        "what is ", "what's ", "tell me about ", "details on ", "details for ", 
        "info on ", "information on ", "side effects of ", "warnings for ", 
        "warnings of ", "about "
    ]
    drug_queried = None
    for trigger in drug_query_triggers:
        if prompt_clean.startswith(trigger):
            drug_queried = prompt_clean.split(trigger)[1].strip()
            drug_queried = re.sub(r"[?.]", "", drug_queried).strip()
            break
            
    if drug_queried:
        dq_lower = drug_queried.lower()
        if dq_lower in disease_kb:
            data = disease_kb[dq_lower]
            sym_list = "\n".join([f"- {s}" for s in data["symptoms"]])
            return f"""# 🏥 Medical Overview: {data['name']}

**Overview:**
{data['overview']}

### 🔍 Common Symptoms:
{sym_list}

### 💊 Standard Clinical Treatments:
{data['treatments']}

### ⚠️ Precautions & Guidance:
{data['precautions']}

---
*Disclaimer: Generated for educational purposes by MedSafe AI. Always consult your doctor for diagnosis and treatment.*"""
        fda_res = query_openfda_local(drug_queried)
        pricing_res = format_medicine_pricing_markdown(drug_queried)
        return f"{fda_res}\n\n{pricing_res}"

    # Check for single word drug search fallback
    if len(prompt_clean.split()) == 1 and prompt_clean.isalpha() and not any(k in prompt_clean for k in ["hello", "hi", "hey", "help", "start", "report", "allergy", "allergies", "meds", "medication", "calendar"]):
        res = query_openfda_local(prompt_clean)
        if "No results found" not in res and "Could not retrieve" not in res:
            return res

    # 5. Log Symptom pattern
    # E.g. "dizzy after lunch, severity 3/10" or "I have a headache, severity 4"
    is_symptom = any(k in prompt_clean for k in ["symptom", "dizzy", "headache", "pain", "nausea", "feeling", "ache", "cough", "rash", "vomit", "fatigue", "tired"])
    if is_symptom and not any(k in prompt_clean for k in ["what", "list", "show"]):
        # Find severity
        sev_match = re.search(r"\b([1-9]|10)\b", prompt_clean)
        severity = int(sev_match.group(1)) if sev_match else 5
        
        # Clean up text to find symptom description
        desc = prompt
        # Remove severity mentions
        desc = re.sub(r",?\s*severity\s*(\d+)(?:\s*/\s*10)?", "", desc, flags=re.I)
        desc = re.sub(r",?\s*\b(\d+)\s*/\s*10\b", "", desc, flags=re.I)
        desc = re.sub(r"\b(?:log|i feel|feeling|have|had|symptom)\b", "", desc, flags=re.I).strip()
        if not desc:
            desc = "Unspecified symptom"
            
        # Correlate with active medications
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT DISTINCT name FROM medications WHERE user_email = ?", (user_email,))
        active_meds = [row["name"] for row in cursor.fetchall()]
        conn.close()
        
        correlated = None
        for med in active_meds:
            if med.lower() in desc.lower() or med.lower() in prompt_clean:
                correlated = med
                
        # Look up clinical suggestions for this logged symptom
        guidelines = load_guidelines()
        symptom_medications = guidelines.get("symptom_medications", {})
        matched_meds = []
        for sym_key, meds in symptom_medications.items():
            if sym_key in desc.lower() or desc.lower() in sym_key:
                matched_meds.extend(meds)
        unique_meds = list(dict.fromkeys(matched_meds))
        
        suggestion_msg = ""
        if unique_meds:
            meds_str = ", ".join([f"**{m}**" for m in unique_meds])
            suggestion_msg = f"\n\n💡 **Clinical Guideline Suggestion:** Standard medications associated with *\"{desc}\"* include {meds_str}. *Note: Only use suggested medications when explicitly prescribed by a doctor.*"
            
        res = log_symptom_local(desc, severity, correlated, user_email)
        
        correlation_msg = ""
        if correlated:
            correlation_msg = f" Note: I correlated this symptom with your medication **{correlated}**."
        elif len(active_meds) > 0:
            # Empathetic side effect advice: check if any of these are active
            correlation_msg = f" Note: Would you like to check if this symptom correlates with any of your active medications: {', '.join(active_meds)}?"
            
        return f"❤️ **Symptom Logged**\n\nI have recorded your symptom: *\"{res['description']}\"* with a severity of **{res['severity']}/10**.{correlation_msg}{suggestion_msg}\n\nI will monitor this for doctor report synthesis. Please rest and stay hydrated, or seek immediate medical help if it gets worse."

    # 6. View Medications
    if any(k in prompt_clean for k in ["medication", "meds", "schedule", "calendar"]):
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM medications WHERE user_email = ?", (user_email,))
        meds = cursor.fetchall()
        conn.close()
        if not meds:
            return "You are currently not taking any medications. You can add one by typing, for example: *\"I need to take Lisinopril 10mg every morning\"*."
        med_list = "\n".join([f"- **{row['name']} {row['dosage']}** ({row['schedule_description']}) at {row['time_of_day']}" for row in meds])
        return f"Here are your active medications:\n\n{med_list}"

    # 7. View Allergies
    if any(k in prompt_clean for k in ["allergy", "allergies", "allergic"]):
        # Check if they are trying to ADD an allergy
        allergy_add_match = re.search(r"(?:add|allergic to)\s+allergy\s+(?:to\s+)?([A-Za-z\s]+)", prompt_clean)
        if not allergy_add_match:
            allergy_add_match = re.search(r"add\s+([A-Za-z\s]+)\s+to\s+(?:my\s+)?allergies", prompt_clean)
        
        if allergy_add_match:
            allergy_name = allergy_add_match.group(1).strip().replace("allergy", "").replace("to", "").strip().capitalize()
            conn = get_connection()
            cursor = conn.cursor()
            try:
                cursor.execute("INSERT INTO allergies (name, user_email) VALUES (?, ?)", (allergy_name, user_email))
                conn.commit()
                msg = f"Added **{allergy_name}** to your allergy profile. I will cross-reference this for all future medication entries."
            except sqlite3.IntegrityError:
                msg = f"**{allergy_name}** is already in your allergy profile."
            conn.close()
            return msg

        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM allergies WHERE user_email = ?", (user_email,))
        allergies = cursor.fetchall()
        conn.close()
        if not allergies:
            return "You have no active allergies registered in your profile. You can add one by typing *\"Add allergy to Penicillin\"*."
        allergy_list = "\n".join([f"- **{row['name']}**" for row in allergies])
        return f"Here are your listed allergies:\n\n{allergy_list}"

    # 8. Help & Greetings
    if any(k in prompt_clean for k in ["hello", "hi", "hey", "help", "start"]):
        return ("Welcome to **MedSafe AI**! I am your local-first, privacy-focused health assistant.\n\n"
                "Here is what you can ask me to do:\n"
                "1. **Add Medication**: *\"I need to take Amoxicillin 500mg every morning\"* (I will run safety and interaction checks first!)\n"
                "2. **Log Symptoms**: *\"I feel dizzy after lunch, severity 3/10\"*\n"
                "3. **Add Allergy**: *\"Add allergy to Penicillin\"*\n"
                "4. **View Status**: *\"Show my medications\"* or *\"What are my allergies?\"*\n\n"
                "All your health records are stored securely and locally on your machine in your SQLite database.")

    # 9. Report query
    if "report" in prompt_clean:
        return "I can generate clean, printable summary reports for your doctor. Please click the **Doctor Reports** tab on the dashboard to view and print your structured report directly!"

    # 10. Disease & Medical QA Knowledge Engine
    disease_kb = {
        "diabetes": {
            "name": "Diabetes Mellitus",
            "overview": "A chronic metabolic condition characterized by elevated blood glucose levels resulting from defects in insulin secretion, insulin action, or both.",
            "symptoms": ["Polyuria (increased urination)", "Polydipsia (increased thirst)", "Unexplained weight loss", "Fatigue", "Blurred vision"],
            "treatments": "Metformin, Insulin therapy, SGLT2 inhibitors, GLP-1 receptor agonists, low-glycemic nutrition, and regular exercise.",
            "precautions": "Monitor blood glucose and HbA1c regularly. Avoid refined sugars and monitor for signs of hypoglycemia (dizziness, shakiness)."
        },
        "hypertension": {
            "name": "Hypertension (High Blood Pressure)",
            "overview": "A common cardiovascular condition where long-term force of blood against arterial walls is persistently elevated (≥130/80 mmHg).",
            "symptoms": ["Often asymptomatic ('silent killer')", "Morning headaches", "Shortness of breath", "Dizziness", "Chest tightness"],
            "treatments": "ACE inhibitors (e.g. Lisinopril), ARBs (Losartan), Calcium channel blockers (Amlodipine), and low-sodium DASH diet.",
            "precautions": "Restrict sodium intake to <2,000mg/day, limit alcohol, avoid smoking, and monitor blood pressure weekly."
        },
        "asthma": {
            "name": "Bronchial Asthma",
            "overview": "A chronic respiratory disorder causing airway inflammation, narrowing, and hyperresponsiveness to environmental triggers.",
            "symptoms": ["Wheezing", "Shortness of breath", "Chest tightness", "Coughing (especially at night or early morning)"],
            "treatments": "Inhaled corticosteroids (Fluticasone, Budesonide), Short-acting beta-agonists (Albuterol/Salbutamol rescue inhalers).",
            "precautions": "Avoid known allergens (dust mites, pollen, smoke, cold air). Keep rescue inhaler accessible at all times."
        },
        "fever": {
            "name": "Pyrexia (Fever)",
            "overview": "A temporary elevation in core body temperature (≥38°C / 100.4°F), typically part of an immune response to viral or bacterial infection.",
            "symptoms": ["Chills and shivering", "Sweating", "General muscle aches", "Dehydration and lethargy"],
            "treatments": "Paracetamol (Acetaminophen 500mg), Ibuprofen (400mg), fluid replacement, and physical cooling.",
            "precautions": "Consult a physician if fever exceeds 39.5°C (103°F), persists beyond 3 days, or is accompanied by stiff neck or shortness of breath."
        },
        "acid reflux": {
            "name": "Gastroesophageal Reflux Disease (GERD)",
            "overview": "Stomach acid repeatedly flows back into the esophagus, irritating the esophageal lining.",
            "symptoms": ["Heartburn (burning chest pain)", "Regurgitation of food/acid", "Difficulty swallowing", "Chronic dry cough"],
            "treatments": "Antacids, H2 blockers (Famotidine), Proton pump inhibitors (Omeprazole, Pantoprazole).",
            "precautions": "Avoid lying down for 3 hours after meals. Limit caffeine, chocolate, spicy foods, and alcohol."
        }
    }

    # Match disease query
    for key, data in disease_kb.items():
        if key in prompt_clean:
            sym_list = "\n".join([f"- {s}" for s in data["symptoms"]])
            return f"""# 🏥 Medical Overview: {data['name']}

**Overview:**
{data['overview']}

### 🔍 Common Symptoms:
{sym_list}

### 💊 Standard Clinical Treatments:
{data['treatments']}

### ⚠️ Precautions & Guidance:
{data['precautions']}

---
*Disclaimer: Generated for educational purposes by MedSafe AI. Always consult your doctor for diagnosis and treatment.*"""

    # Check if query is about a specific drug via openFDA
    words = prompt_clean.split()
    for w in words:
        if len(w) >= 4 and w not in ["what", "when", "how", "take", "does", "have", "with", "this", "from", "your", "help"]:
            fda_res = query_openfda_local(w)
            if "Drug Information:" in fda_res:
                return fda_res

    # General Medical & Disease Assistant Guidance
    topic = prompt.strip()
    return f"""# 🩺 MedSafe Clinical AI Guidance

**Topic / Query:** *"{topic}"*

Medical conditions, symptoms, and drug interactions require careful clinical evaluation. Here is general medical guidance for your query:

### 📋 Key Clinical Information:
- **Condition / Disease Evaluation**: Disease management focuses on accurate diagnosis, symptom tracking, lifestyle modification, and evidence-based pharmacotherapy.
- **Medication Safety**: Always verify drug dosages, timing (before/after meals), and potential contraindications with your existing profile.
- **Symptom Monitoring**: Record severe or recurring symptoms in the **Daily Checklist** or **Symptoms** tab for doctor review.

### 💡 Suggested Next Steps:
1. To schedule a medication, type: *\"Take Amoxicillin 500mg every morning\"*
2. To check drug interactions, type: *\"Can I take Ibuprofen with Paracetamol?\"*
3. To add an allergy, type: *\"Add allergy to Penicillin\"*

---
*Disclaimer: MedSafe AI provides educational medical information. Consult your physician or healthcare provider for specific medical advice, diagnosis, or treatment.*"""

def query_openfda_local(drug_name: str) -> str:
    """Helper to query openFDA directly for the fallback agent."""
    try:
        import certifi
        ctx = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        ctx = ssl.create_default_context()
    query = f'openfda.brand_name:"{drug_name}" OR openfda.generic_name:"{drug_name}"'
    encoded_query = urllib.parse.quote(query)
    url = f"https://api.fda.gov/drug/label.json?search={encoded_query}&limit=1"
    
    api_key = os.environ.get("FDA_API_KEY")
    if api_key:
        url += f"&api_key={api_key}"
        
    try:
        req = urllib.request.Request(
            url, 
            headers={'User-Agent': 'MedSafe-AI/1.0'}
        )
        with urllib.request.urlopen(req, context=ctx, timeout=5) as response:
            data = json.loads(response.read().decode('utf-8'))
            if "results" in data and len(data["results"]) > 0:
                result = data["results"][0]
                
                def get_field_text(field_name):
                    val = result.get(field_name, "")
                    if isinstance(val, list):
                        return "\n".join(val)
                    return str(val)
                
                openfda = result.get("openfda", {})
                brand_names = openfda.get("brand_name", [])
                generic_names = openfda.get("generic_name", [])
                active_ingredients = openfda.get("substance_name", [])
                manufacturer = openfda.get("manufacturer_name", [])
                
                summary = []
                summary.append(f"# Drug Information: {brand_names[0] if brand_names else drug_name.capitalize()}")
                if generic_names:
                    summary.append(f"**Generic Name:** {generic_names[0]}")
                if active_ingredients:
                    summary.append(f"**Active Ingredients:** {', '.join(active_ingredients)}")
                if manufacturer:
                    summary.append(f"**Manufacturer:** {manufacturer[0]}")
                
                sections = {
                    "indications_and_usage": "Indications & Usage",
                    "dosage_and_administration": "Dosage & Administration",
                    "warnings": "Warnings & Precautions",
                    "adverse_reactions": "Side Effects (Adverse Reactions)",
                    "drug_interactions": "Drug Interactions",
                    "description": "Description"
                }
                
                for key, title in sections.items():
                    text = get_field_text(key)
                    if text:
                        if len(text) > 800:
                            text = text[:800] + "... [truncated]"
                        summary.append(f"\n## {title}\n{text}")
                
                summary.append("\n*Data sourced from openFDA API. This information is for educational purposes only and not a substitute for professional medical advice.*")
                return "\n".join(summary)
    except Exception as e:
        return f"Could not retrieve information for '{drug_name}' from the openFDA database. Error: {str(e)}"
        
    return f"No results found for '{drug_name}' in the openFDA database."

def create_agent_config(conversation_id: str = None, user_email: str = None):
    env = os.environ.copy()
    if user_email:
        env["USER_EMAIL"] = user_email
    mcp_servers = [
        types.McpStdioServer(
            name="medsafe_mcp",
            command="python3",
            args=[MCP_SERVER_PATH],
            env=env
        )
    ]
    return LocalAgentConfig(
        mcp_servers=mcp_servers,
        system_instructions=SYSTEM_INSTRUCTIONS,
    )

async def run_agent_chat(prompt: str, conversation_id: str = None, user_email: str = 'guest@medsafe.ai') -> str:
    """Attempts to use the Google Antigravity Agent, falling back to rule-based engine if key is missing or call hangs."""
    try:
        if not HAS_ANTIGRAVITY:
            raise ValueError("Google Antigravity SDK is not installed in this environment.")
        # Check if API key is set in environment or config
        if not os.environ.get("GEMINI_API_KEY"):
            raise ValueError("GEMINI_API_KEY environment variable is not set.")
            
        config = create_agent_config(conversation_id, user_email)
        async with Agent(config) as agent:
            response = await asyncio.wait_for(agent.chat(prompt), timeout=6.0)
            return await asyncio.wait_for(response.text(), timeout=6.0)
    except Exception as e:
        print(f"[MedSafe AI] Running Fallback Agent due to: {e}")
        # Allow simulated latency for natural look
        await asyncio.sleep(0.5)
        return fallback_chat_processor(prompt, user_email)

async def stream_agent_chat(prompt: str, conversation_id: str = None, user_email: str = 'guest@medsafe.ai', file_path: str = None) -> AsyncGenerator[str, None]:
    """Streams responses powered by Gemini AI, covering medical conditions, diseases, medications, and health queries."""
    from dotenv import load_dotenv
    load_dotenv(override=True)
    api_key = os.environ.get("GEMINI_API_KEY")
    
    if api_key:
        try:
            from google import genai
            from google.genai import types
            
            client = genai.Client(api_key=api_key)
            system_instruction = """
            You are MedSafe AI, an expert empathetic clinical AI assistant and medical knowledge agent.
            You answer all user questions related to medicines, diseases, medical conditions, symptoms, treatments, side effects, drug interactions, dosage guidance, and health queries.
            Provide detailed, medically accurate, clear, and empathetic explanations formatted in clean GitHub Markdown with headings, bullet points, and bold text.
            If the user asks to schedule a medication, log a symptom, or add an allergy, execute or acknowledge their request while answering their medical questions.
            Always include a short medical disclaimer at the end when discussing medical conditions, prescription drugs, or treatment guidance.
            """
            
            models_to_try = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-flash-latest", "gemini-2.0-flash"]
            stream_success = False
            
            for model_name in models_to_try:
                try:
                    response = client.models.generate_content_stream(
                        model=model_name,
                        contents=prompt,
                        config=types.GenerateContentConfig(
                            system_instruction=system_instruction,
                            temperature=0.3
                        )
                    )
                    for chunk in response:
                        if chunk.text:
                            yield chunk.text
                    stream_success = True
                    break
                except Exception as model_err:
                    print(f"[MedSafe AI] Gemini model {model_name} streaming error: {model_err}")
                    continue
                    
            if stream_success:
                buy_card = format_cheapest_and_alternatives_card(prompt)
                if buy_card:
                    yield buy_card
                return
        except Exception as genai_err:
            print(f"[MedSafe AI] Gemini Direct API error: {genai_err}")

    # Fallback to local Medical Knowledge Engine if API key is not present or call hangs
    reply = fallback_chat_processor(prompt, user_email)
    words = reply.split(" ")
    for i in range(0, len(words), 2):
        chunk = " ".join(words[i:i+2]) + " "
        yield chunk
        await asyncio.sleep(0.04)

async def analyze_clinical_report(text: str, file_path: str = None) -> str:
    """Analyzes a medical report text (like blood tests) using Gemini or a fallback rules engine."""
    prompt = f"""
    You are a clinical blood test and laboratory report analysis AI.
    Please review the following extracted medical report text or image/document content and structure a clear summary.
    
    EXTRACTED TEXT (IF ANY):
    {text}
    
    Structure your response using Markdown:
    1. **Overview Summary**: A 2-3 sentence overview of the report findings and clinical tone.
    2. **Key Biomarkers / Parameters Detected**: List out values found (like Glucose, HbA1c, Cholesterol, TSH, WBC, Hemoglobin, etc.), their values, whether they are Normal, High, or Low, and a brief description.
    3. **Clinical Safety Flags & Warnings**: Highlight any critical/danger markers (like extremely high blood sugar, dangerous cholesterol levels, thyroid dysfunction) and suggest questions they should ask their practitioner.
    4. **Medication & Allergy Considerations**: Relate the findings to potential medications or warnings.
    
    Always include a prominent disclaimer:
    "Disclaimer: This clinical analysis is generated by MedSafe AI for patient education purposes. It is NOT a diagnostic tool. You MUST consult a qualified doctor or healthcare professional for official diagnosis, treatment, or interpretation of your medical results."
    """
    
    if os.environ.get("GEMINI_API_KEY"):
        try:
            # Build multimodal input if a valid file path is provided
            multimodal_input = []
            if file_path and os.path.exists(file_path):
                ext = file_path.lower()
                if ext.endswith(('.png', '.jpg', '.jpeg', '.webp')):
                    try:
                        img = types.Image.from_file(file_path)
                        multimodal_input.append(img)
                    except Exception as img_err:
                        print(f"[MedSafe AI] Failed to load image: {img_err}")
                elif ext.endswith('.pdf'):
                    try:
                        doc = types.Document.from_file(file_path)
                        multimodal_input.append(doc)
                    except Exception as doc_err:
                        print(f"[MedSafe AI] Failed to load document: {doc_err}")
            
            config = LocalAgentConfig(
                system_instructions="You are a clinical blood test and laboratory report analysis assistant."
            )
            inputs = [prompt] + multimodal_input
            async with Agent(config) as agent:
                response = await asyncio.wait_for(agent.chat(inputs), timeout=10.0)
                return await asyncio.wait_for(response.text(), timeout=10.0)
        except Exception as e:
            print(f"[MedSafe AI] LLM report analysis failed, falling back to rules engine: {e}")
            
    # Rules-based Fallback Parser
    fallback_result = rules_based_report_analysis(text)
    if file_path and file_path.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')) and not os.environ.get("GEMINI_API_KEY"):
        fallback_result = (
            "⚠️ **Gemini API Key Required for Image Analysis**\n\n"
            "You uploaded an image/screenshot file, but the proper trained AI model (Gemini) is not configured because the "
            "`GEMINI_API_KEY` is missing. Please add a valid Gemini API key to your `.env` file in the project root "
            "to enable accurate report analysis. In the meantime, here is the text-based parser output:\n\n"
            + fallback_result
        )
    return fallback_result

def rules_based_report_analysis(text: str) -> str:
    text_lower = text.lower()
    
    biomarkers = []
    safety_flags = []
    
    # 1. HbA1c
    hba1c_match = re.search(r"\bhba1c\b.*?(\d+(?:\.\d+)?)", text_lower)
    if hba1c_match:
        val = float(hba1c_match.group(1))
        status = "Normal"
        note = "Under 5.7% is healthy."
        badge = "🟢"
        if val >= 6.5:
            status = "High (Diabetic)"
            note = "Indicates persistent hyperglycemia. Consult a physician."
            badge = "🔴"
            safety_flags.append(f"Your HbA1c of **{val}%** is in the diabetic range (>= 6.5%).")
        elif val >= 5.7:
            status = "Borderline (Prediabetic)"
            note = "Slightly elevated. Review diet and lifestyle."
            badge = "🟡"
            safety_flags.append(f"Your HbA1c of **{val}%** is in the pre-diabetic range (5.7% - 6.4%).")
        biomarkers.append(("HbA1c", f"{val}%", badge + " " + status, note))

    # 2. Glucose
    glucose_match = re.search(r"\b(?:glucose|blood sugar)\b.*?(\d+(?:\.\d+)?)", text_lower)
    if glucose_match:
        val = float(glucose_match.group(1))
        status = "Normal"
        note = "Healthy fasting range is 70-99 mg/dL."
        badge = "🟢"
        if val >= 126:
            status = "High (Diabetic)"
            note = "Fasting glucose over 125 mg/dL indicates hyperglycemia."
            badge = "🔴"
            safety_flags.append(f"Fasting Glucose of **{val} mg/dL** is significantly high.")
        elif val >= 100:
            status = "Borderline High"
            note = "Impaired fasting glucose."
            badge = "🟡"
        elif val < 70:
            status = "Low"
            note = "Below 70 mg/dL indicates hypoglycemia."
            badge = "🔴"
            safety_flags.append(f"Fasting Glucose of **{val} mg/dL** is hypoglycemic. Eat quick carbs.")
        biomarkers.append(("Fasting Glucose", f"{val} mg/dL", badge + " " + status, note))

    # 3. Cholesterol (Total)
    chol_match = re.search(r"\b(?:total\s+)?cholesterol\b.*?(\d+(?:\.\d+)?)", text_lower)
    if chol_match:
        val = float(chol_match.group(1))
        status = "Normal"
        note = "Healthy level is under 200 mg/dL."
        badge = "🟢"
        if val >= 240:
            status = "High"
            note = "High cholesterol. Cardiac risk consideration."
            badge = "🔴"
            safety_flags.append(f"Total Cholesterol of **{val} mg/dL** is elevated.")
        elif val >= 200:
            status = "Borderline High"
            note = "Slightly elevated."
            badge = "🟡"
        biomarkers.append(("Total Cholesterol", f"{val} mg/dL", badge + " " + status, note))

    # 4. LDL Cholesterol
    ldl_match = re.search(r"\bldl\b.*?(\d+(?:\.\d+)?)", text_lower)
    if ldl_match:
        val = float(ldl_match.group(1))
        status = "Normal"
        note = "Optimal LDL is under 100 mg/dL."
        badge = "🟢"
        if val >= 130:
            status = "High"
            note = "Elevated LDL ('bad') cholesterol."
            badge = "🔴"
            safety_flags.append(f"LDL Cholesterol of **{val} mg/dL** is high.")
        elif val >= 100:
            status = "Borderline High"
            note = "Slightly elevated."
            badge = "🟡"
        biomarkers.append(("LDL Cholesterol", f"{val} mg/dL", badge + " " + status, note))

    # 5. HDL Cholesterol
    hdl_match = re.search(r"\bhdl\b.*?(\d+(?:\.\d+)?)", text_lower)
    if hdl_match:
        val = float(hdl_match.group(1))
        status = "Normal"
        note = "Optimal levels are above 40 mg/dL (men) or 50 mg/dL (women)."
        badge = "🟢"
        if val < 40:
            status = "Low"
            note = "Low HDL ('good') cholesterol. Exercise and diet can raise it."
            badge = "🔴"
            safety_flags.append(f"HDL Cholesterol of **{val} mg/dL** is low.")
        elif val >= 60:
            status = "Optimal"
            note = "Provides high cardiovascular protection."
            badge = "🟢"
        biomarkers.append(("HDL Cholesterol", f"{val} mg/dL", badge + " " + status, note))

    # 6. Triglycerides
    trig_match = re.search(r"\b(?:triglycerides|trig)\b.*?(\d+(?:\.\d+)?)", text_lower)
    if trig_match:
        val = float(trig_match.group(1))
        status = "Normal"
        note = "Healthy levels are under 150 mg/dL."
        badge = "🟢"
        if val >= 200:
            status = "High"
            note = "Elevated blood fats. Consult doctor on cardiac health."
            badge = "🔴"
            safety_flags.append(f"Triglycerides of **{val} mg/dL** are high.")
        elif val >= 150:
            status = "Borderline High"
            note = "Slightly elevated."
            badge = "🟡"
        biomarkers.append(("Triglycerides", f"{val} mg/dL", badge + " " + status, note))

    # 7. TSH (Thyroid)
    tsh_match = re.search(r"\btsh\b.*?(\d+(?:\.\d+)?)", text_lower)
    if tsh_match:
        val = float(tsh_match.group(1))
        status = "Normal"
        note = "Healthy range is 0.4 - 4.5 uIU/mL."
        badge = "🟢"
        if val > 4.5:
            status = "High"
            note = "Indicates hypothyroid activity."
            badge = "🔴"
            safety_flags.append(f"TSH of **{val} uIU/mL** is elevated (potential Hypothyroidism).")
        elif val < 0.4:
            status = "Low"
            note = "Indicates hyperthyroid activity."
            badge = "🔴"
            safety_flags.append(f"TSH of **{val} uIU/mL** is low (potential Hyperthyroidism).")
        biomarkers.append(("TSH (Thyroid)", f"{val} uIU/mL", badge + " " + status, note))

    # 8. Hemoglobin
    hemo_match = re.search(r"\b(?:hemoglobin|hemo|hb)\b.*?(\d+(?:\.\d+)?)", text_lower)
    if hemo_match:
        val = float(hemo_match.group(1))
        status = "Normal"
        note = "Normal range is 12.0 - 17.5 g/dL."
        badge = "🟢"
        if val < 12.0:
            status = "Low"
            note = "Low hemoglobin indicates potential anemia."
            badge = "🔴"
            safety_flags.append(f"Hemoglobin of **{val} g/dL** is low. Review iron and diet.")
        biomarkers.append(("Hemoglobin", f"{val} g/dL", badge + " " + status, note))

    # 9. WBC
    wbc_match = re.search(r"\b(?:wbc|leukocytes?|tlc|white blood)\b.*?(\d+(?:\.\d+)?)", text_lower)
    if wbc_match:
        val = float(wbc_match.group(1))
        status = "Normal"
        note = "Normal range is 4.0 - 11.0 k/uL."
        badge = "🟢"
        if val > 11.0:
            status = "High"
            note = "Elevated white cells may indicate active infection or inflammation."
            badge = "🔴"
            safety_flags.append(f"WBC count of **{val} k/uL** is high (possible infection).")
        elif val < 4.0:
            status = "Low"
            note = "Low white cells can impact immune defenses."
            badge = "🔴"
            safety_flags.append(f"WBC count of **{val} k/uL** is low.")
        biomarkers.append(("WBC (White Blood Cells)", f"{val} k/uL", badge + " " + status, note))

    # 9a. RBC Count
    rbc_match = re.search(r"\b(?:rbc|red blood|erythrocytes?)\b.*?(\d+(?:\.\d+)?)", text_lower)
    if rbc_match:
        val = float(rbc_match.group(1))
        status = "Normal"
        note = "Normal range is 4.5 - 5.5 mill/mm3."
        badge = "🟢"
        if val < 4.5:
            status = "Low"
            badge = "🔴"
            safety_flags.append(f"RBC count of **{val}** is low.")
        elif val > 5.5:
            status = "High"
            badge = "🔴"
            safety_flags.append(f"RBC count of **{val}** is high.")
        biomarkers.append(("RBC (Red Blood Cells)", f"{val} mill/mm3", badge + " " + status, note))

    # 9b. Hematocrit / PCV
    pcv_match = re.search(r"\b(?:pcv|packed cell|hematocrit|hct)\b.*?(\d+(?:\.\d+)?)", text_lower)
    if pcv_match:
        val = float(pcv_match.group(1))
        status = "Normal"
        note = "Normal range is 40.0% - 50.0%."
        badge = "🟢"
        if val < 40.0:
            status = "Low"
            badge = "🔴"
            safety_flags.append(f"PCV (Hematocrit) of **{val}%** is low.")
        elif val > 50.0:
            status = "High"
            badge = "🔴"
            safety_flags.append(f"PCV (Hematocrit) of **{val}%** is high.")
        biomarkers.append(("Hematocrit / PCV", f"{val}%", badge + " " + status, note))

    # 10. Platelets
    plt_match = re.search(r"\bplatelets?\b.*?(\d+(?:\.\d+)?)", text_lower)
    if plt_match:
        val = float(plt_match.group(1))
        status = "Normal"
        note = "Normal range is 150 - 450 k/uL."
        badge = "🟢"
        if val > 450:
            status = "High"
            note = "Elevated platelet levels."
            badge = "🔴"
        elif val < 150:
            status = "Low"
            note = "Low platelet count increases bruising and bleeding risk."
            badge = "🔴"
            safety_flags.append(f"Platelet count of **{val} k/uL** is low. Alert provider if bleeding.")
        biomarkers.append(("Platelets", f"{val} k/uL", badge + " " + status, note))

    # 11. Potassium
    pot_match = re.search(r"\bpotassium\b.*?(\d+(?:\.\d+)?)", text_lower)
    if pot_match:
        val = float(pot_match.group(1))
        status = "Normal"
        note = "Normal range is 3.5 - 5.0 mEq/L."
        badge = "🟢"
        if val > 5.0:
            status = "High"
            note = "Elevated potassium (Hyperkalemia). Cardiac hazard."
            badge = "🔴"
            safety_flags.append(f"Potassium of **{val} mEq/L** is high. Avoid potassium-conserving meds.")
        elif val < 3.5:
            status = "Low"
            note = "Low potassium (Hypokalemia)."
            badge = "🔴"
            safety_flags.append(f"Potassium of **{val} mEq/L** is low. Can cause muscle cramps.")
        biomarkers.append(("Potassium", f"{val} mEq/L", badge + " " + status, note))

    # 12. Sodium
    sod_match = re.search(r"\bsodium\b.*?(\d+(?:\.\d+)?)", text_lower)
    if sod_match:
        val = float(sod_match.group(1))
        status = "Normal"
        note = "Normal range is 135 - 145 mEq/L."
        badge = "🟢"
        if val > 145:
            status = "High"
            note = "Elevated sodium level (Hypernatremia)."
            badge = "🔴"
        elif val < 135:
            status = "Low"
            note = "Low sodium level (Hyponatremia)."
            badge = "🔴"
            safety_flags.append(f"Sodium of **{val} mEq/L** is low.")
        biomarkers.append(("Sodium", f"{val} mEq/L", badge + " " + status, note))

    # 13. Creatinine
    creat_match = re.search(r"\bcreat(?:inine)?\b.*?(\d+(?:\.\d+)?)", text_lower)
    if creat_match:
        val = float(creat_match.group(1))
        status = "Normal"
        note = "Normal range is 0.6 - 1.2 mg/dL."
        badge = "🟢"
        if val > 1.2:
            status = "High"
            note = "Elevated creatinine can indicate reduced kidney filtration rate."
            badge = "🔴"
            safety_flags.append(f"Creatinine of **{val} mg/dL** is elevated (check renal function).")
        biomarkers.append(("Creatinine (Kidney)", f"{val} mg/dL", badge + " " + status, note))

    # 14. BUN
    bun_match = re.search(r"\b(?:bun|blood\s+urea\s+nitrogen)\b.*?(\d+(?:\.\d+)?)", text_lower)
    if bun_match:
        val = float(bun_match.group(1))
        status = "Normal"
        note = "Normal range is 7 - 20 mg/dL."
        badge = "🟢"
        if val > 20:
            status = "High"
            note = "Elevated blood urea nitrogen. May indicate dehydration."
            badge = "🔴"
        biomarkers.append(("BUN (Urea Nitrogen)", f"{val} mg/dL", badge + " " + status, note))

    # Construct the report
    md = "### 📋 Lab Test Clinical Report Summary\n\n"
    md += "A clinical text scan was performed on your uploaded report. Here are the findings:\n\n"
    
    if biomarkers:
        md += "| Biomarker / Parameter | Observed Value | Status | Reference Note |\n"
        md += "| :--- | :--- | :--- | :--- |\n"
        for name, val, status, note in biomarkers:
            md += f"| **{name}** | {val} | {status} | {note} |\n"
        md += "\n"
    else:
        md += "⚠️ *No matching major biomarkers (Glucose, HbA1c, Lipids, CBC, Electrolytes, Thyroid, Hemoglobin) were automatically parsed. The full text remains stored for practitioner review.*\n\n"
        
    if safety_flags:
        md += "### ⚠️ Clinical Warnings & Safety Flags\n"
        for flag in safety_flags:
            md += f"- **Attention Required:** {flag}\n"
        md += "\n**Questions to ask your Doctor:**\n"
        md += "- What lifestyle modifications do you recommend to regulate these specific values?\n"
        md += "- Do these results affect my current active medication schedules?\n\n"
    else:
        md += "### ✅ Clinical Safety Review\n"
        md += "All parsed biomarkers are within normal reference ranges. Continue maintaining your scheduled health plan!\n\n"
        
    md += "---\n"
    md += "**Disclaimer: This clinical analysis is generated by MedSafe AI for patient education purposes. It is NOT a diagnostic tool. You MUST consult a qualified doctor or healthcare professional for official diagnosis, treatment, or interpretation of your medical results.**"
    return md

# Self-test block
if __name__ == "__main__":
    async def test():
        print("Testing MedSafe AI Agent Fallback...")
        res = await run_agent_chat("What active medications do I have currently?")
        print("Agent Response:\n", res)
        
        # Test medication entry safety warning check
        print("\nTesting safety warning for Amoxicillin when Penicillin allergy is active...")
        res_warn = await run_agent_chat("Add medication Amoxicillin 500mg every morning")
        print("Agent Response:\n", res_warn)
        
    asyncio.run(test())
