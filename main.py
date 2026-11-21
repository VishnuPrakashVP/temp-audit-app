"""Temperature audit API. Run with: uvicorn main:app --reload"""

from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from bson import ObjectId
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator, model_validator
from pymongo import DESCENDING, ReturnDocument

from db import audits_collection
from locations import LOCATIONS, LocationName

# Relative to this file, so the app works whichever folder uvicorn is started from.
STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="Temperature Audit API")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    """Serve the frontend page."""
    return FileResponse(STATIC_DIR / "index.html")


class AuditStart(BaseModel):
    """Request body for POST /audits."""

    checked_by: str = Field(min_length=1)

    @field_validator("checked_by")
    @classmethod
    def checked_by_not_blank(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("checked_by can't be blank")
        return value


class ReadingUpdate(BaseModel):
    """Request body for PUT /audits/{id}/readings/{location}."""

    temperature: float | None = None
    skip_reason: str | None = None

    @field_validator("skip_reason")
    @classmethod
    def blank_reason_is_none(cls, value):
        if value is None:
            return None
        return value.strip() or None

    @model_validator(mode="after")
    def not_both(self):
        if self.temperature is not None and self.skip_reason is not None:
            raise ValueError("Send a temperature or a skip_reason, not both")
        return self


class ReadingSlot(BaseModel):
    """One location's entry inside an audit."""

    location: str
    department: str
    min_temp: float
    max_temp: float
    temperature: float | None
    status: Literal["pending", "in_range", "out_of_range", "skipped"]
    skip_reason: str | None
    checked_at: datetime | None


class AuditOut(BaseModel):
    """An audit, as returned by the API."""

    id: str
    checked_by: str
    status: Literal["in_progress", "submitted"]
    started_at: datetime
    submitted_at: datetime | None
    readings: list[ReadingSlot]


def to_audit_out(doc):
    """Convert a MongoDB document into an AuditOut."""
    # ObjectId can't be sent as JSON, so expose it as a plain string.
    doc["id"] = str(doc.pop("_id"))
    return AuditOut(**doc)


def to_object_id(audit_id):
    """Return audit_id as an ObjectId, or raise 404 if it isn't a valid one."""
    if not ObjectId.is_valid(audit_id):
        raise HTTPException(status_code=404, detail="Audit not found")
    return ObjectId(audit_id)


def find_audit_or_404(object_id):
    """Return the audit document, or raise 404."""
    audit = audits_collection.find_one({"_id": object_id})
    if audit is None:
        raise HTTPException(status_code=404, detail="Audit not found")
    return audit


def require_in_progress(audit):
    """Raise 409 if the audit has already been submitted."""
    if audit["status"] != "in_progress":
        raise HTTPException(
            status_code=409, detail="This audit is submitted and can't be changed"
        )


@app.get("/locations")
def list_locations():
    """Return all locations with their department and safe range."""
    return LOCATIONS


@app.post("/audits", response_model=AuditOut, status_code=201)
def start_audit(body: AuditStart):
    """Start an audit with an empty slot for every location."""
    # Copy each range in, so old audits stay correct if limits change later.
    readings = [
        {
            "location": location["name"],
            "department": location["department"],
            "min_temp": location["min_temp"],
            "max_temp": location["max_temp"],
            "temperature": None,
            "status": "pending",
            "skip_reason": None,
            "checked_at": None,
        }
        for location in LOCATIONS
    ]
    doc = {
        "checked_by": body.checked_by,
        "status": "in_progress",
        "started_at": datetime.now(timezone.utc),
        "submitted_at": None,
        "readings": readings,
    }
    audits_collection.insert_one(doc)  # adds the new _id to doc in place
    return to_audit_out(doc)


@app.get("/audits", response_model=list[AuditOut])
def list_todays_audits():
    """Return today's audits, newest first."""
    # "Today" starts at local midnight, not UTC midnight.
    start_of_today = datetime.now().astimezone().replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    docs = audits_collection.find({"started_at": {"$gte": start_of_today}}).sort(
        "started_at", DESCENDING
    )
    return [to_audit_out(doc) for doc in docs]


@app.get("/audits/{audit_id}", response_model=AuditOut)
def get_audit(audit_id: str):
    """Return one audit."""
    return to_audit_out(find_audit_or_404(to_object_id(audit_id)))


@app.put("/audits/{audit_id}/readings/{location}", response_model=AuditOut)
def update_reading(
    audit_id: str,
    location: LocationName,  # pyright: ignore[reportInvalidTypeForm]
    update: ReadingUpdate,
):
    """Set a temperature, mark skipped, or clear (send neither) one location."""
    object_id = to_object_id(audit_id)
    audit = find_audit_or_404(object_id)
    require_in_progress(audit)

    slot = next((s for s in audit["readings"] if s["location"] == location.value), None)
    if slot is None:
        raise HTTPException(status_code=404, detail="Location isn't part of this audit")

    # Judge against the range stored in the audit, not today's LOCATIONS.
    if update.temperature is not None:
        in_range = slot["min_temp"] <= update.temperature <= slot["max_temp"]
        status = "in_range" if in_range else "out_of_range"
    elif update.skip_reason is not None:
        status = "skipped"
    else:
        status = "pending"

    slot_filter = {
        "_id": object_id,
        # Re-checking status here stops a save sneaking in after a submit.
        "status": "in_progress",
        "readings.location": location.value,
    }
    updated = audits_collection.find_one_and_update(
        slot_filter,
        {
            "$set": {
                "readings.$.temperature": update.temperature,
                "readings.$.skip_reason": update.skip_reason,
                "readings.$.status": status,
                "readings.$.checked_at": (
                    None if status == "pending" else datetime.now(timezone.utc)
                ),
            }
        },
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        require_in_progress(find_audit_or_404(object_id))
    return to_audit_out(updated)


@app.post("/audits/{audit_id}/submit", response_model=AuditOut)
def submit_audit(audit_id: str):
    """Submit the audit, if every location has a temperature or a skip reason."""
    object_id = to_object_id(audit_id)
    # One atomic step: matches only if no slot is still pending, so a reading
    # cleared at the same moment can't slip through.
    updated = audits_collection.find_one_and_update(
        {
            "_id": object_id,
            "status": "in_progress",
            "readings.status": {"$ne": "pending"},
        },
        {"$set": {"status": "submitted", "submitted_at": datetime.now(timezone.utc)}},
        return_document=ReturnDocument.AFTER,
    )
    if updated is not None:
        return to_audit_out(updated)

    audit = find_audit_or_404(object_id)
    require_in_progress(audit)
    missing = [s["location"] for s in audit["readings"] if s["status"] == "pending"]
    raise HTTPException(
        status_code=409,
        detail={
            "message": f"Audit not complete. Still to do: {', '.join(missing)}",
            "missing": missing,
        },
    )
