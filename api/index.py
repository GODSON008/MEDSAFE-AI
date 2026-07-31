import sys
import os

# Add backend directory to sys.path so Vercel can locate all modules
backend_path = os.path.join(os.path.dirname(__file__), '..', 'backend')
if backend_path not in sys.path:
    sys.path.insert(0, backend_path)

from main import app
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

frontend_path = os.path.join(os.path.dirname(__file__), '..', 'frontend')

# Mount static frontend files
try:
    app.mount("/static", StaticFiles(directory=frontend_path), name="frontend_static")
except Exception:
    pass

@app.get("/")
def serve_index():
    index_path = os.path.join(frontend_path, "index.html")
    return FileResponse(index_path)
