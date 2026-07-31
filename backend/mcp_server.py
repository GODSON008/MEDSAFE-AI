import json
import os
import sqlite3
import datetime
import urllib.request
import urllib.parse
import ssl
from mcp.server.fastmcp import FastMCP
from database import get_connection, find_pricing_options

mcp = FastMCP("MedSafeDB")

GUIDELINES_PATH = os.path.join(os.path.dirname(__file__), "clinical_guidelines.json")

def load_guidelines():
    """Loads local clinical guidelines."""
    try:
        with open(GUIDELINES_PATH, "r") as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading clinical guidelines: {e}")
        return {"allergy_classes": {}, "drug_interactions": []}

def get_current_user_email() -> str:
    """Helper to retrieve user_email from the subprocess environment."""
    return os.environ.get("USER_EMAIL", "guest@medsafe.ai")

@mcp.tool()
def get_medications() -> str:
    """Gets the list of active medications from the database.
    
    Returns:
        A JSON string representing the list of active medications.
    """
    email = get_current_user_email()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM medications WHERE user_email = ?", (email,))
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return json.dumps(rows)

@mcp.tool()
def add_medication(name: str, dosage: str, schedule_description: str, frequency: str, time_of_day: str, start_date: str = None) -> str:
    """Adds a new medication and schedules its daily adherence checklist items for the next 7 days.
    
    Args:
        name: Name of the medication (e.g., Lisinopril)
        dosage: Dosage of the medication (e.g., 10mg)
        schedule_description: Descriptive schedule (e.g., 'every morning')
        frequency: Frequency of dosage (e.g., 'daily')
        time_of_day: Time of day in 24h format (e.g., '08:00')
        start_date: Start date in YYYY-MM-DD format. Defaults to today.
        
    Returns:
        A JSON string representing the added medication.
    """
    if not start_date:
        start_date = datetime.date.today().isoformat()
        
    email = get_current_user_email()
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
    INSERT INTO medications (name, dosage, schedule_description, frequency, time_of_day, start_date, user_email)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (name, dosage, schedule_description, frequency, time_of_day, start_date, email))
    
    med_id = cursor.lastrowid
    
    # Generate adherence slots for the next 7 days
    start_dt = datetime.datetime.strptime(start_date, "%Y-%m-%d")
    for i in range(7):
        scheduled_day = (start_dt + datetime.timedelta(days=i)).date().isoformat()
        scheduled_time = f"{scheduled_day} {time_of_day}"
        cursor.execute("""
        INSERT INTO adherence (medication_id, taken_at, status, scheduled_time)
        VALUES (?, NULL, 'pending', ?)
        """, (med_id, scheduled_time))
        
    conn.commit()
    cursor.execute("SELECT * FROM medications WHERE id = ?", (med_id,))
    row = dict(cursor.fetchone())
    conn.close()
    
    return json.dumps(row)

@mcp.tool()
def delete_medication(medication_id: int) -> str:
    """Deletes a medication and its associated adherence logs.
    
    Args:
        medication_id: ID of the medication to delete.
    """
    email = get_current_user_email()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM medications WHERE id = ? AND user_email = ?", (medication_id, email))
    cursor.execute("DELETE FROM adherence WHERE medication_id = ? AND medication_id NOT IN (SELECT id FROM medications)", (medication_id,))
    conn.commit()
    conn.close()
    return json.dumps({"success": True, "message": f"Medication ID {medication_id} deleted."})

@mcp.tool()
def get_allergies() -> str:
    """Gets the list of active allergies from the database.
    
    Returns:
        A JSON string representing the list of allergies.
    """
    email = get_current_user_email()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM allergies WHERE user_email = ?", (email,))
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return json.dumps(rows)

@mcp.tool()
def add_allergy(name: str) -> str:
    """Adds a new allergy to the user's profile.
    
    Args:
        name: Name of the allergen or drug class (e.g., 'Penicillin')
    """
    email = get_current_user_email()
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO allergies (name, user_email) VALUES (?, ?)", (name, email))
        conn.commit()
        result = {"success": True, "message": f"Allergy to {name} added."}
    except sqlite3.IntegrityError:
        result = {"success": True, "message": f"Allergy to {name} already exists."}
    conn.close()
    return json.dumps(result)

@mcp.tool()
def remove_allergy(name: str) -> str:
    """Removes an allergy from the user's profile.
    
    Args:
        name: Name of the allergy to remove.
    """
    email = get_current_user_email()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM allergies WHERE name = ? AND user_email = ?", (name, email))
    conn.commit()
    conn.close()
    return json.dumps({"success": True, "message": f"Allergy {name} removed."})

@mcp.tool()
def get_symptoms() -> str:
    """Gets all logged symptoms.
    
    Returns:
        A JSON string representing symptom logs.
    """
    email = get_current_user_email()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM symptoms WHERE user_email = ? ORDER BY logged_at DESC", (email,))
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return json.dumps(rows)

@mcp.tool()
def log_symptom(description: str, severity: int, logged_at: str = None, correlated_medication: str = None) -> str:
    """Logs a symptom to the database, optionally correlating it with a medication.
    
    Args:
        description: Description of the symptom (e.g., 'dizzy after lunch')
        severity: Severity score from 1 (mild) to 10 (severe)
        logged_at: Timestamp in 'YYYY-MM-DD HH:MM:SS' format. Defaults to current time.
        correlated_medication: Name of a medication suspected of causing the symptom.
    """
    if not logged_at:
        logged_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
    email = get_current_user_email()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    INSERT INTO symptoms (description, severity, logged_at, correlated_medication, user_email)
    VALUES (?, ?, ?, ?, ?)
    """, (description, severity, logged_at, correlated_medication, email))
    symptom_id = cursor.lastrowid
    conn.commit()
    cursor.execute("SELECT * FROM symptoms WHERE id = ?", (symptom_id,))
    row = dict(cursor.fetchone())
    conn.close()
    
    return json.dumps(row)

@mcp.tool()
def get_adherence() -> str:
    """Gets the medication adherence checklist logs.
    
    Returns:
        A JSON string representing adherence logs.
    """
    email = get_current_user_email()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT a.*, m.name as medication_name, m.dosage as medication_dosage, m.time_of_day as medication_time_of_day
    FROM adherence a
    JOIN medications m ON a.medication_id = m.id
    WHERE m.user_email = ?
    ORDER BY a.scheduled_time DESC
    """, (email,))
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return json.dumps(rows)

@mcp.tool()
def log_adherence(adherence_id: int, taken_at: str = None, status: str = 'taken') -> str:
    """Logs/updates a medication checklist item intake.
    
    Args:
        adherence_id: ID of the adherence slot.
        taken_at: ISO timestamp in 'YYYY-MM-DD HH:MM:SS' format. Defaults to current time if status is 'taken'.
        status: Intake status: 'taken', 'skipped', or 'pending'.
    """
    if status == 'taken' and not taken_at:
        taken_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    elif status != 'taken':
        taken_at = None
        
    email = get_current_user_email()
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    UPDATE adherence
    SET taken_at = ?, status = ?
    WHERE id = ? AND medication_id IN (SELECT id FROM medications WHERE user_email = ?)
    """, (taken_at, status, adherence_id, email))
    conn.commit()
    
    cursor.execute("""
    SELECT a.* FROM adherence a 
    JOIN medications m ON a.medication_id = m.id
    WHERE a.id = ? AND m.user_email = ?
    """, (adherence_id, email))
    row = dict(cursor.fetchone())
    conn.close()
    
    return json.dumps(row)

@mcp.tool()
def check_safety(med_name: str) -> str:
    """Checks a medication against the user's active medications and allergies for safety concerns.
    
    Args:
        med_name: Name of the medication to check.
        
    Returns:
        A JSON string representing the safety report with safety flags, warnings, and severity.
    """
    email = get_current_user_email()
    conn = get_connection()
    cursor = conn.cursor()
    
    # 1. Fetch active medications
    cursor.execute("SELECT DISTINCT name FROM medications WHERE user_email = ?", (email,))
    active_meds = [row["name"].strip().lower() for row in cursor.fetchall()]
    
    # 2. Fetch active allergies
    cursor.execute("SELECT name FROM allergies WHERE user_email = ?", (email,))
    allergies = [row["name"].strip().lower() for row in cursor.fetchall()]
    conn.close()
    
    guidelines = load_guidelines()
    warnings = []
    med_name_clean = med_name.strip().lower()
    
    # Check Allergy Conflicts
    for allergy_class, drugs in guidelines.get("allergy_classes", {}).items():
        allergy_class_clean = allergy_class.strip().lower()
        if allergy_class_clean in allergies:
            # Check if target med is in this allergy family
            drugs_clean = [d.strip().lower() for d in drugs]
            if med_name_clean in drugs_clean or any(allergy_class_clean in med_name_clean for allergy_class_clean in [allergy_class_clean]):
                warnings.append({
                    "type": "allergy",
                    "severity": "High",
                    "message": f"Allergy Conflict: You have a listed allergy to '{allergy_class}'. '{med_name}' is in this drug class."
                })
    
    # Check Drug-Drug Interactions
    for interaction in guidelines.get("drug_interactions", []):
        inter_drugs = [d.strip().lower() for d in interaction["drugs"]]
        if med_name_clean in inter_drugs:
            # Check if the other interacting drug is active
            other_drug = [d for d in inter_drugs if d != med_name_clean][0]
            if other_drug in active_meds:
                warnings.append({
                    "type": "interaction",
                    "severity": interaction["severity"],
                    "message": f"Drug Interaction ({interaction['severity']}): Taking '{med_name}' with '{other_drug}' can be dangerous. {interaction['warning']}"
                })
                
    safe = len(warnings) == 0
    return json.dumps({
        "safe": safe,
        "warnings": warnings,
        "checked_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    })

@mcp.tool()
def suggest_medication(symptom: str) -> str:
    """Suggests basic medications for a given symptom, compares brand/generic prices, and returns purchase links.
    
    Args:
        symptom: The symptom description (e.g., 'headache', 'acid reflux')
        
    Returns:
        A JSON string containing matching medications, pricing options, cheapest highlight, buy links, and formatted markdown.
    """
    from database import find_pricing_options
    
    guidelines = load_guidelines()
    symptom_medications = guidelines.get("symptom_medications", {})
    symptom_clean = symptom.strip().lower()
    
    matched_meds = []
    # Search for matching keys (allowing substring matches)
    for sym_key, meds in symptom_medications.items():
        if sym_key in symptom_clean or symptom_clean in sym_key:
            matched_meds.extend(meds)
            
    # Deduplicate while preserving order
    unique_meds = list(dict.fromkeys(matched_meds))
    disclaimer = "Note: Only use recommended medications when explicitly prescribed by a doctor. MedSafe AI suggestions are for informational purposes only and do not replace professional medical advice."
    
    meds_details = []
    markdown_parts = []
    
    if unique_meds:
        meds_str = ", ".join([f"**{m}**" for m in unique_meds])
        markdown_parts.append(f"Based on local clinical guidelines, standard medications associated with *\"{symptom}\"* are: {meds_str}.\n")
        markdown_parts.append("### 💰 Price Comparison & Purchasing Links\n")
        
        for med in unique_meds:
            clean_name = med.split("(")[0].strip()
            options = find_pricing_options(clean_name)
            cheapest = min(options, key=lambda x: x["price"]) if options else None
            cheapest_str = f"{cheapest['name']} at ₹{cheapest['price']:.2f} from {cheapest['pharmacy']}" if cheapest else ""
            
            meds_details.append({
                "name": med,
                "cheapest": cheapest_str,
                "options": options
            })
            
            markdown_parts.append(f"#### {med}")
            if options:
                markdown_parts.append("| Product / Brand | Pharmacy | Price | Quantity | Unit Price | Buy Link |")
                markdown_parts.append("| :--- | :--- | :--- | :--- | :--- | :--- |")
                for opt in options:
                    is_generic = "generic" in opt["name"].lower()
                    name_display = f"**{opt['name']}**" if is_generic else opt["name"]
                    markdown_parts.append(f"| {name_display} | {opt['pharmacy']} | ₹{opt['price']:.2f} | {opt['quantity']} | ₹{opt['unit_price']:.2f} / dose | [🛒 Buy now]({opt['link']}) |")
                markdown_parts.append(f"\n🌟 **Cheapest Option:** **{cheapest['name']}** at **₹{cheapest['price']:.2f}** from {cheapest['pharmacy']}.\n")
            else:
                markdown_parts.append("No price comparison data available.\n")
    else:
        markdown_parts.append(f"I couldn't find any specific medicine suggestions in my local guidelines database for *\"{symptom}\"*.")
        
    markdown_parts.append(f"\n{disclaimer}")
    
    return json.dumps({
        "symptom": symptom,
        "medications": meds_details,
        "raw_names": unique_meds,
        "disclaimer": disclaimer,
        "found": len(unique_meds) > 0,
        "markdown": "\n".join(markdown_parts)
    })

@mcp.tool()
def query_openfda_drug_info(drug_name: str) -> str:
    """Queries the openFDA API for labeling information about a specific drug.
    This includes brand/generic names, active ingredients, indications/usage, dosage, warnings, and adverse reactions.
    
    Args:
        drug_name: Name of the drug (brand or generic) to query (e.g., 'Ibuprofen' or 'Lipitor').
    """
    try:
        import certifi
        ctx = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        ctx = ssl.create_default_context()
    query = f'openfda.brand_name:"{drug_name}" OR openfda.generic_name:"{drug_name}"'
    encoded_query = urllib.parse.quote(query)
    url = f"https://api.fda.gov/drug/label.json?search={encoded_query}&limit=1"
    
    # Read api key if configured in env
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
                
                # Helper to extract fields safely
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
                
                # Format a rich markdown summary
                summary = []
                summary.append(f"# Drug Information: {brand_names[0] if brand_names else drug_name.capitalize()}")
                if generic_names:
                    summary.append(f"**Generic Name:** {generic_names[0]}")
                if active_ingredients:
                    summary.append(f"**Active Ingredients:** {', '.join(active_ingredients)}")
                if manufacturer:
                    summary.append(f"**Manufacturer:** {manufacturer[0]}")
                
                # Add important section details if present
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
                        # Clean up text length if it's too long
                        if len(text) > 800:
                            text = text[:800] + "... [truncated]"
                        summary.append(f"\n## {title}\n{text}")
                
                summary.append("\n*Data sourced from openFDA API. This information is for educational purposes only and not a substitute for professional medical advice.*")
                return "\n".join(summary)
    except Exception as e:
        return f"Could not retrieve information for '{drug_name}' from the openFDA database. Error: {str(e)}"
        
    return f"No results found for '{drug_name}' in the openFDA database."

if __name__ == "__main__":
    mcp.run()
