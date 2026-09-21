"""Read-only, content-free summary of real Responses input snapshots.

Run with the path to responses-state.json; prints no IDs, text or image bytes.
"""

import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


def summary(item):
    if not isinstance(item, dict):
        return {"shape": type(item).__name__}
    blocks = item.get("content", item.get("output", []))
    if not isinstance(blocks, list):
        blocks = []
    kinds = Counter(block.get("type", "?") for block in blocks if isinstance(block, dict))
    return {
        "type": item.get("type", "?"),
        "role": item.get("role", "?"),
        "blocks": dict(kinds),
        "outputShape": type(blocks).__name__,
    }


def main():
    state = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    entries = state["states"]
    print(f"snapshot entries={len(entries)}")
    for index, (_id, entry) in enumerate(entries):
        items = entry["items"]
        timestr = datetime.fromtimestamp(entry["createdAt"] / 1000, timezone.utc).isoformat()
        notable = [(i, summary(x)) for i, x in enumerate(items) if summary(x)["blocks"].get("input_image", 0)]
        if index < 2 or notable or index >= len(entries) - 3:
            print(f"entry={index} utc={timestr} items={len(items)} imageItems={json.dumps(notable, ensure_ascii=False)} tail={json.dumps([summary(x) for x in items[-4:]], ensure_ascii=False)}")


if __name__ == "__main__":
    main()
