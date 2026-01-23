#!/usr/bin/env python3
"""
Chrome IndexedDB Reader

Reads IndexedDB data from Chrome's LevelDB storage for a specific origin.
Uses ccl_chromium_reader to handle Chrome's custom LevelDB format.

Usage:
    python3 read_indexeddb.py [origin_filter]

Output:
    JSON object with structure:
    {
        "origin": "https://www.amazon.com",
        "databases": [
            {
                "name": "dbName",
                "objectStores": [
                    {
                        "name": "storeName",
                        "records": [
                            {"key": "...", "value": {...}}
                        ]
                    }
                ]
            }
        ]
    }
"""

import json
import os
import sys
from typing import Any, Dict, List

def serialize_value(value: Any) -> Any:
    """Convert IndexedDB values to JSON-serializable format."""
    import math
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        # Handle special float values that aren't valid JSON
        if math.isinf(value):
            return {"__type": "Infinity", "sign": 1 if value > 0 else -1}
        if math.isnan(value):
            return {"__type": "NaN"}
        return value
    if isinstance(value, (str, int)):
        return value
    if isinstance(value, dict):
        return {k: serialize_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [serialize_value(item) for item in value]
    if isinstance(value, bytes):
        # Base64 encode bytes
        import base64
        return {"__type": "bytes", "data": base64.b64encode(value).decode("ascii")}
    # Handle ccl_chromium_reader special types
    type_name = type(value).__name__
    if type_name == "Undefined":
        return {"__type": "undefined"}
    if type_name == "IdbKey":
        return str(value)
    # Fallback: convert to string
    return str(value)


def serialize_key(key: Any) -> Any:
    """Convert IndexedDB keys to JSON-serializable format."""
    if key is None:
        return None
    if isinstance(key, (str, int, float)):
        return key
    if isinstance(key, (list, tuple)):
        return [serialize_key(k) for k in key]
    # Handle IdbKey objects
    type_name = type(key).__name__
    if type_name == "IdbKey":
        # Try to extract the raw key value
        if hasattr(key, "raw_key"):
            return serialize_key(key.raw_key)
        return str(key).replace("<IdbKey ", "").rstrip(">")
    return str(key)


def read_indexeddb(idb_path: str) -> Dict[str, Any]:
    """Read all data from a Chrome IndexedDB LevelDB folder."""
    try:
        from ccl_chromium_reader import ccl_chromium_indexeddb
    except ImportError:
        return {"error": "ccl_chromium_reader not installed. Run: pip3 install git+https://github.com/cclgroupltd/ccl_chromium_reader.git"}

    if not os.path.exists(idb_path):
        return {"error": f"Path not found: {idb_path}"}

    # Check for blob directory (same path but .blob instead of .leveldb)
    blob_path = idb_path.replace(".indexeddb.leveldb", ".indexeddb.blob")
    blob_dir = blob_path if os.path.exists(blob_path) else None

    try:
        db_wrapper = ccl_chromium_indexeddb.WrappedIndexDB(idb_path, leveldb_blob_dir=blob_dir)
    except Exception as e:
        return {"error": f"Failed to open IndexedDB: {str(e)}"}

    # Extract origin from path (format: https_www.amazon.com_0.indexeddb.leveldb)
    folder_name = os.path.basename(idb_path)
    origin_part = folder_name.replace(".indexeddb.leveldb", "")
    # Convert https_www.amazon.com_0 to https://www.amazon.com
    if origin_part.startswith("https_"):
        origin = "https://" + origin_part[6:].rsplit("_", 1)[0].replace("_", ".")
    elif origin_part.startswith("http_"):
        origin = "http://" + origin_part[5:].rsplit("_", 1)[0].replace("_", ".")
    else:
        origin = origin_part

    result = {
        "origin": origin,
        "databases": []
    }

    for db_id in db_wrapper.database_ids:
        db = db_wrapper[db_id]
        db_data = {
            "name": db.name,
            "objectStores": []
        }

        for obj_store_name in db.object_store_names:
            obj_store = db.get_object_store_by_name(obj_store_name)
            store_data = {
                "name": obj_store_name,
                "records": []
            }

            try:
                for record in obj_store.iterate_records():
                    try:
                        record_data = {
                            "key": serialize_key(record.key),
                            "value": serialize_value(record.value)
                        }
                        store_data["records"].append(record_data)
                    except FileNotFoundError:
                        # Skip records with missing blob files
                        pass
                    except Exception as e:
                        # Skip records that can't be serialized
                        store_data["records"].append({
                            "key": str(record.key) if hasattr(record, "key") else "unknown",
                            "error": str(e)
                        })
            except FileNotFoundError:
                # Skip object stores with missing blob files
                pass
            except Exception as e:
                store_data["records"].append({"error": f"Failed to iterate records: {str(e)}"})

            db_data["objectStores"].append(store_data)

        result["databases"].append(db_data)

    return result


def find_indexeddb_folders(origin_filter: str = None) -> List[str]:
    """Find all IndexedDB folders, optionally filtered by origin."""
    home = os.path.expanduser("~")
    idb_base = os.path.join(home, "Library/Application Support/Google/Chrome/Default/IndexedDB")

    if not os.path.exists(idb_base):
        return []

    folders = []
    for item in os.listdir(idb_base):
        if item.endswith(".indexeddb.leveldb"):
            if origin_filter is None or origin_filter.lower() in item.lower():
                folders.append(os.path.join(idb_base, item))

    return folders


def main():
    origin_filter = sys.argv[1] if len(sys.argv) > 1 else None

    folders = find_indexeddb_folders(origin_filter)

    if not folders:
        print(json.dumps({"error": f"No IndexedDB folders found" + (f" for filter '{origin_filter}'" if origin_filter else "")}))
        sys.exit(1)

    all_results = []
    for folder in folders:
        result = read_indexeddb(folder)
        all_results.append(result)

    print(json.dumps(all_results, indent=2))


if __name__ == "__main__":
    main()
