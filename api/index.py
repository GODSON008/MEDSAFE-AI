import sys
import os

# Add backend directory to sys.path so Vercel can locate all modules
backend_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'backend'))
if backend_path not in sys.path:
    sys.path.insert(0, backend_path)

from main import app
from fastapi.responses import FileResponse, Response

frontend_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'frontend'))

# Catch-all route to serve static frontend files (styles.css, app_v3.js, index.html)
@app.get("/{full_path:path}")
async def serve_frontend(full_path: str):
    if not full_path or full_path == "/":
        index_file = os.path.join(frontend_path, "index.html")
        if os.path.exists(index_file):
            return FileResponse(index_file)

    target_file = os.path.normpath(os.path.join(frontend_path, full_path))
    # Prevent path traversal outside frontend directory
    if os.path.commonpath([target_file, frontend_path]) == frontend_path and os.path.isfile(target_file):
        return FileResponse(target_file)

    index_file = os.path.join(frontend_path, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)

    return Response(content="Not Found", status_code=404)
