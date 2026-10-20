"""Conservative display grouping of overlapping detections, raw outputs unchanged.

Groups compare against their original anchor, never a growing union: a chain of
overlaps must not collapse a row of neighbouring machines. The highest score
keeps its label/score/box; weaker boxes never enlarge its geometry.
This is a reversible heuristic, not proof of physical object identity.
"""

from copy import deepcopy

POLICY = {
    "version": 2,
    "same_class_iou": 0.5,
    "cross_machine_iou": 0.6,
    "containment_fraction": 0.9,
    "generic_containment_area_ratio": 0.5,
    "family_containment_area_ratio": 0.12,
    "loader_part_area_ratio": 0.04,
    "confidence": "maximum observed score; never a summed or averaged probability",
    "geometry": (
        "keep highest-score anchor box unchanged; "
        "compare members only to original anchor"
    ),
}
MACHINERY = frozenset(
    {
        "backhoe_loader",
        "bulldozer",
        "cleaning_equipment",
        "concrete_mixer",
        "concrete_pump",
        "crane_manipulator",
        "crawler_crane",
        "dump_truck",
        "excavator",
        "forklift_giraffe",
        "forklift_standart",
        "gazelle",
        "grader",
        "loader",
        "mobile_crane",
        "other_vehicle",
        "pile_driving",
        "roller",
        "tanker",
        "tower_crane",
        "trailer",
        "truck",
        "truck_crane",
    }
)
FAMILIES = (
    frozenset({"loader", "backhoe_loader"}),
    frozenset(
        {
            "mobile_crane",
            "truck_crane",
            "crawler_crane",
            "tower_crane",
            "crane_manipulator",
        }
    ),
    frozenset({"truck", "dump_truck", "tanker", "concrete_mixer", "gazelle"}),
)


def overlap(a, b):
    aa = max(0, a[2] - a[0]) * max(0, a[3] - a[1])
    bb = max(0, b[2] - b[0]) * max(0, b[3] - b[1])
    inter = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(
        0, min(a[3], b[3]) - max(a[1], b[1])
    )
    return (
        inter / (aa + bb - inter) if aa + bb - inter else 0,
        inter / min(aa, bb) if min(aa, bb) > 0 else 0,
        min(aa, bb) / max(aa, bb) if max(aa, bb) > 0 else 0,
    )


def duplicate_reason(anchor, candidate):
    a, b = anchor["class"], candidate["class"]
    iou, inside, ratio = overlap(anchor["xyxy"], candidate["xyxy"])
    if a == b and iou >= POLICY["same_class_iou"]:
        return "same_class_overlap"
    # Never swallow a worker/hook into a machine merely because its box is inside.
    if a not in MACHINERY or b not in MACHINERY:
        return None
    if iou >= POLICY["cross_machine_iou"]:
        return "conflicting_machine_labels_same_extent"
    if inside < POLICY["containment_fraction"]:
        return None
    if ratio >= POLICY["generic_containment_area_ratio"]:
        return "contained_machine_hypothesis_similar_extent"
    if {a, b} == {"loader", "backhoe_loader"} and ratio >= POLICY[
        "loader_part_area_ratio"
    ]:
        return "loader_component_within_backhoe"
    if (
        any(a in family and b in family for family in FAMILIES)
        and ratio >= POLICY["family_containment_area_ratio"]
    ):
        return "contained_same_family_hypothesis"
    return None


def consolidate_detections(rows):
    groups = []
    for row in sorted(rows, key=lambda d: -d["confidence"]):
        match = None
        for group in groups:
            reason = duplicate_reason(group["_anchor"], row)
            if reason:
                match = (group, reason)
                break
        member = {
            "class": row["class"],
            "confidence": row["confidence"],
            "xyxy": list(row["xyxy"]),
        }
        if match is None:
            group = deepcopy(row)
            group["_anchor"] = deepcopy(row)
            group["merged_from"] = [member]
            group["merge_reasons"] = []
            groups.append(group)
        else:
            group, reason = match
            group["merged_from"].append(member)
            group["merge_reasons"].append(reason)
    for group in groups:
        del group["_anchor"]
    return groups
