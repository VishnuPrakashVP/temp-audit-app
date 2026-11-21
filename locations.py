"""Made-up test locations and their safe temperature ranges (°C)."""

from enum import StrEnum

LOCATIONS = [
    {"name": "Chiller 1", "department": "Dispatch", "min_temp": 0, "max_temp": 5},
    {"name": "Chiller 2", "department": "Production", "min_temp": 0, "max_temp": 5},
    {"name": "Freezer 1", "department": "Goods In", "min_temp": -25, "max_temp": -18},
    {"name": "Ambient Store", "department": "Goods In", "min_temp": 10, "max_temp": 25},
]

# Built from LOCATIONS so there's only one list to edit when adding a location.
LocationName = StrEnum(
    "LocationName", {location["name"]: location["name"] for location in LOCATIONS}
)
