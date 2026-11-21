"""Edit embedded glTF tracks and per-node materials without re-exporting other geometry."""
import copy
import json
import math
import struct


def need(ok, message):
    if not ok:
        raise ValueError(message)


def vector(value, length):
    need(isinstance(value, list) and len(value) == length and
         all(type(x) in (int, float) and math.isfinite(x) for x in value), "Invalid vector")
    return value


class Model:
    def __init__(self, path):
        data = path.read_bytes()
        magic, version, total, size, kind = struct.unpack_from("<4sIII4s", data)
        need((magic, version, total, kind) == (b"glTF", 2, len(data), b"JSON"), "Invalid GLB")
        self.doc = json.loads(data[20:20 + size])
        size2, kind2 = struct.unpack_from("<I4s", data, 20 + size)
        need(kind2 == b"BIN\x00" and size + size2 + 28 == total and len(self.doc["buffers"]) == 1,
             "Expected a single embedded GLB buffer")
        self.binary = bytearray(data[28 + size:])
        self.nodes = {n["name"]: i for i, n in enumerate(self.doc["nodes"]) if "name" in n}
        self.clips = {a["name"]: a for a in self.doc.get("animations", [])}

    def accessor(self, rows, kind):
        widths = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}
        for row in rows:
            vector(row, widths[kind])
        flat = [x for row in rows for x in row]
        data = struct.pack(f"<{len(flat)}f", *flat)
        self.binary.extend(bytes(-len(self.binary) % 4))
        offset = len(self.binary)
        self.binary.extend(data)
        views, acc = self.doc["bufferViews"], self.doc["accessors"]
        views.append(dict(buffer=0, byteOffset=offset, byteLength=len(data)))
        acc.append(dict(bufferView=len(views)-1, componentType=5126, type=kind, count=len(rows),
                        min=list(map(min, zip(*rows))), max=list(map(max, zip(*rows)))))
        return len(acc)-1

    def track(self, edit):
        clip = self.clips[edit["clip"]]
        node = self.nodes[edit["node"]]
        path = edit["path"]
        need(path in ("translation", "rotation", "scale"), "Unknown track path")
        old_path = edit.get("replace", path)
        channels = clip["channels"]
        matches = [c for c in channels if c["target"] == {"node": node, "path": old_path}]
        need(len(matches) <= 1 and ("replace" not in edit or matches), "Missing or ambiguous source track")
        need(old_path == path or not any(c["target"] == {"node": node, "path": path} for c in channels),
             "Target track already exists")
        duration = max(self.doc["accessors"][s["input"]]["max"][0] for s in clip["samplers"])
        times, rows = edit["at"], edit["values"]
        need(len(times) == len(rows) >= 2 and times[0] == 0 and times[-1] == 1 and
             all(type(x) in (int, float) and math.isfinite(x) for x in times) and
             all(a < b for a, b in zip(times, times[1:])), "Invalid normalized key times")
        if path == "rotation":
            for q in rows:
                need(abs(sum(x*x for x in vector(q, 4)) - 1) < .0001, "Quaternion is not normalized")
        sampler = dict(input=self.accessor([[v*duration] for v in times], "SCALAR"),
                       output=self.accessor(rows, "VEC4" if path == "rotation" else "VEC3"), interpolation="LINEAR")
        clip["samplers"].append(sampler)
        new = dict(sampler=len(clip["samplers"])-1, target=dict(node=node, path=path))
        if matches:
            matches[0].update(new)
        else:
            channels.append(new)
        # Samplers can be shared within a clip. Remove only unreferenced entries.
        used = sorted({c["sampler"] for c in channels})
        clip["samplers"] = [clip["samplers"][i] for i in used]
        for channel in channels:
            channel["sampler"] = used.index(channel["sampler"])

    def material(self, edit):
        color = vector(edit["rgba"], 4)
        need(all(0 <= x <= 1 for x in color), "Invalid material color")
        node = self.doc["nodes"][self.nodes[edit["node"]]]
        meshes, materials = self.doc["meshes"], self.doc["materials"]
        mesh = copy.deepcopy(meshes[node["mesh"]])
        for primitive in mesh["primitives"]:
            mat = copy.deepcopy(materials[primitive["material"]])
            mat.setdefault("pbrMetallicRoughness", {})["baseColorFactor"] = color
            mat["alphaMode"] = "BLEND" if color[3] < 1 else "OPAQUE"
            materials.append(mat)
            primitive["material"] = len(materials)-1
        meshes.append(mesh)
        node["mesh"] = len(meshes)-1

    def save(self, path):
        self.doc["buffers"][0]["byteLength"] = len(self.binary)
        header = json.dumps(self.doc, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
        header += b" " * (-len(header) % 4)
        self.binary.extend(bytes(-len(self.binary) % 4))
        path.write_bytes(struct.pack("<4sIII4s", b"glTF", 2, 28+len(header)+len(self.binary), len(header), b"JSON")
                         + header + struct.pack("<I4s", len(self.binary), b"BIN\0") + self.binary)