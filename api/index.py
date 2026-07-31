import sys
import os

# Add backend directory to sys.path so Vercel can locate all modules
backend_path = os.path.join(os.path.dirname(__file__), '..', 'backend')
if backend_path not in sys.path:
    sys.path.insert(0, backend_path)

from main import app
