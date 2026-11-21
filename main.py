"""Temperature audit API. Run with: uvicorn main:app --reload"""

from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator
from pymongo import DESCENDING

from db import readings_collection
from locations import LOCATIONS, LocationName, get_departments, get_location

app = FastAPI(title="Temperature Audit API")


class ReadingIn(BaseModel):
    """Request body for POST /readings."""

    # Pyright can't see Enum members built at runtime; Pydantic can, so it's safe.
    location: LocationName  # pyright: ignore[reportInvalidTypeForm]
    temperature: float
    checked_by: str = Field(min_length=1)
    notes: str | None = None

    @field_validator("checked_by")
    @classmethod
    def checked_by_not_blank(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("checked_by can't be blank")
        return value


class ReadingOut(BaseModel):
    """A saved reading, as returned by the API."""

    id: str
    location: str
    department: str
    temperature: float
    min_temp: float
    max_temp: float
    status: str
    checked_by: str
    notes: str | None
    timestamp: datetime


def to_reading_out(doc):
    """Convert a MongoDB document into a ReadingOut."""
    # ObjectId can't be sent as JSON, so expose it as a plain string.
    doc["id"] = str(doc.pop("_id"))
    return ReadingOut(**doc)


@app.get("/locations")
def list_locations():
    """Return all locations with their department and safe range."""
    return LOCATIONS


@app.post("/readings", response_model=ReadingOut, status_code=201)
def create_reading(reading: ReadingIn):
    """Save a reading; the server sets status and timestamp so clients can't."""
    name = reading.location.value
    location = get_location(name)

    # The limits themselves count as safe.
    in_range = location["min_temp"] <= reading.temperature <= location["max_temp"]

    doc = {
        "location": name,
        "department": location["department"],
        "temperature": reading.temperature,
        # Copy the range in, so old records stay correct if limits change later.
        "min_temp": location["min_temp"],
        "max_temp": location["max_temp"],
        "status": "in_range" if in_range else "out_of_range",
        "checked_by": reading.checked_by,
        "notes": reading.notes,
        # UTC, so stored times don't depend on the server's time zone or BST.
        "timestamp": datetime.now(timezone.utc),
    }
    readings_collection.insert_one(doc)  # adds the new _id to doc in place
    return to_reading_out(doc)


@app.get("/readings", response_model=list[ReadingOut])
def list_todays_readings(department: str):
    """Return today's readings for one department, newest first."""
    departments = get_departments()
    if department not in departments:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown department. Choose one of: {departments}",
        )

    # "Today" starts at local midnight, not UTC midnight.
    start_of_today = datetime.now().astimezone().replace(
        hour=0, minute=0, second=0, microsecond=0
    )

    docs = readings_collection.find(
        {"department": department, "timestamp": {"$gte": start_of_today}}
    ).sort("timestamp", DESCENDING)
    return [to_reading_out(doc) for doc in docs]
