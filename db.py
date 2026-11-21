"""MongoDB Atlas connection. Run `python db.py` to test it."""

import os

from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI")
if not MONGODB_URI:
    raise RuntimeError("MONGODB_URI is missing. Add it to your .env file.")

# 5 s timeout: the 30 s default looks like a frozen app when Atlas is unreachable.
# tz_aware: read-back times are labelled UTC, so they can't be mistaken for local.
client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000, tz_aware=True)

database = client["temp_audit"]
audits_collection = database["audits"]


def ping():
    """Raise an error if the database server can't be reached."""
    client.admin.command("ping")


if __name__ == "__main__":
    try:
        ping()
        print("Connected to MongoDB!")
    except Exception as error:
        print("Could not connect to MongoDB:", error)
