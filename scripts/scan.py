#!/usr/bin/env python3
"""Mantiene el índice (codemap) de las rutas GPX de una carpeta.

Uso:
    python3 scripts/scan.py RUTA/A/TracksGps [--index catalog/index.json] [--csv catalogo.csv] [--dry-run]

Cada archivo se identifica por el SHA-256 de su contenido. Solo los GPX con un
hash que no está en el índice se parsean; los conocidos solo se rehashean para
detectar movimientos, renombrados y bajas. Los archivos idénticos en varias
carpetas comparten una entrada con varias rutas en "paths".

Con --csv exporta el catálogo con las mismas columnas que catalogo_rutas.csv,
calculadas desde el índice sin volver a leer los GPX.
"""

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from gpx_stats import classify, extract

INDEX_VERSION = 1
CSV_COLUMNS = [
    "archivo", "carpeta", "nombre", "disciplina", "fuente_disciplina", "km", "desnivel_pos_m", "desnivel_neg_m",
    "alt_max_m", "alt_min_m", "duracion_total", "tiempo_movimiento", "fecha", "tipo", "inicio_lat", "inicio_lon",
    "wikiloc_id", "wikiloc_url", "origen", "puntos", "waypoints", "duplicado_de", "posible_duplicado", "nota",
]


def load_index(path):
    if not path.exists():
        return {"version": INDEX_VERSION, "tracks": {}, "ignored": []}
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if data.get("version") != INDEX_VERSION:
        sys.exit(f"{path}: versión de índice {data.get('version')} no soportada")
    data.setdefault("tracks", {})
    data.setdefault("ignored", [])
    return data


def walk(root):
    """Devuelve ({sha256: {"paths", "size"}}, [no GPX]) con rutas relativas en formato POSIX."""
    found, ignored = {}, []
    for path in sorted(root.rglob("*")):
        rel_parts = path.relative_to(root).parts
        if not path.is_file() or any(part.startswith(".") for part in rel_parts):
            continue
        rel = "/".join(rel_parts)
        if path.suffix.lower() != ".gpx":
            ignored.append(rel)
            continue
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        entry = found.setdefault(digest, {"paths": [], "size": len(raw)})
        entry["paths"].append(rel)
    return found, ignored


def scan(root, index):
    """Actualiza index en memoria y devuelve el informe de cambios."""
    old_tracks = index["tracks"]
    old_paths = {p: h for h, t in old_tracks.items() for p in t["paths"]}
    found, ignored = walk(root)

    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    report = {"new": [], "moved": [], "modified": [], "removed": [], "errors": [], "unchanged": 0}
    tracks = {}
    for digest, entry in found.items():
        if digest in old_tracks:
            track = dict(old_tracks[digest])
            before, after = set(track["paths"]), set(entry["paths"])
            if before != after:
                report["moved"].append({"from": sorted(before - after), "to": sorted(after - before)})
            else:
                report["unchanged"] += 1
        else:
            try:
                stats = extract((root / entry["paths"][0]).read_bytes())
            except ET.ParseError as e:
                report["errors"].append({"path": entry["paths"][0], "error": str(e)})
                stats = {"error": f"XML inválido: {e}"}
            track = {"added": now, **stats}
            replaced = [p for p in entry["paths"] if old_paths.get(p, digest) != digest]
            report["modified"].extend(replaced)
            report["new"].extend(p for p in entry["paths"] if p not in replaced)
        track["paths"] = entry["paths"]
        track["size"] = entry["size"]
        tracks[digest] = track

    found_paths = {p for e in found.values() for p in e["paths"]}
    for digest, track in old_tracks.items():
        if digest not in found:
            report["removed"].extend(p for p in track["paths"] if p not in found_paths)

    report["duplicates"] = [t["paths"] for t in tracks.values() if len(t["paths"]) > 1]
    changed = any(report[k] for k in ("new", "moved", "modified", "removed")) or ignored != index["ignored"]
    index["tracks"] = dict(sorted(tracks.items(), key=lambda kv: kv[1]["paths"][0]))
    index["ignored"] = ignored
    if changed or "updated" not in index:
        index["updated"] = now
    return report


def catalog_rows(index):
    """Filas por archivo con las columnas de catalogo_rutas.csv."""
    rows = []
    for digest, track in index["tracks"].items():
        for rel in track["paths"]:
            disc, source = classify(rel, track)
            row = {k: track.get(k, "") for k in CSV_COLUMNS}
            row.update({
                "archivo": rel,
                "carpeta": os.path.dirname(rel),
                "nombre": track.get("nombre_gpx") or os.path.splitext(os.path.basename(rel))[0],
                "disciplina": disc,
                "fuente_disciplina": source,
                "nota": track.get("error", track.get("nota", "")),
                "_hash": digest,
            })
            rows.append(row)
    rows.sort(key=lambda r: r["archivo"])

    by_wikiloc, by_name = defaultdict(list), defaultdict(list)
    norm = lambda a: re.sub(r"\s*\(\d+\)$", "", os.path.splitext(os.path.basename(a))[0]).strip().lower()
    for r in rows:
        if r["wikiloc_id"]:
            by_wikiloc[r["wikiloc_id"]].append(r["archivo"])
        by_name[norm(r["archivo"])].append(r["archivo"])
    by_row = {r["archivo"]: r for r in rows}
    for r in rows:
        same = [a for a in index["tracks"][r["_hash"]]["paths"] if a != r["archivo"]]
        maybe = [a for a in by_wikiloc.get(r["wikiloc_id"], []) + by_name[norm(r["archivo"])]
                 if a != r["archivo"] and a not in same]
        r["duplicado_de"] = " | ".join(same)
        r["posible_duplicado"] = " | ".join(dict.fromkeys(maybe))
        if r["disciplina"] == "Sin clasificar":
            for a in same:
                if by_row[a]["disciplina"] not in ("Sin clasificar", ""):
                    r["disciplina"], r["fuente_disciplina"] = by_row[a]["disciplina"], "duplicado"
                    break
    return rows


def write_csv(index, path):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        w.writeheader()
        w.writerows(catalog_rows(index))


def print_report(report, index):
    files = sum(len(t["paths"]) for t in index["tracks"].values())
    print(f"{len(index['tracks'])} rutas distintas en {files} archivos GPX; {report['unchanged']} sin cambios.")
    for label, key in (("Nuevas", "new"), ("Modificadas", "modified"), ("Eliminadas", "removed")):
        if report[key]:
            print(f"\n{label} ({len(report[key])}):")
            for p in report[key]:
                print(f"  {p}")
    if report["moved"]:
        print(f"\nMovidas, renombradas o copiadas ({len(report['moved'])}):")
        for m in report["moved"]:
            print(f"  {', '.join(m['from']) or '(nueva copia)'} -> {', '.join(m['to']) or '(copia eliminada)'}")
    if report["errors"]:
        print(f"\nNo se pudieron leer ({len(report['errors'])}):")
        for e in report["errors"]:
            print(f"  {e['path']}: {e['error']}")
    if index["ignored"]:
        print(f"\nIgnorados por no ser GPX: {len(index['ignored'])}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("root", type=Path, help="carpeta con las rutas (TracksGps)")
    parser.add_argument("--index", type=Path,
                        default=Path(__file__).resolve().parent.parent / "catalog" / "index.json")
    parser.add_argument("--csv", type=Path, help="exporta el catálogo en CSV a esta ruta")
    parser.add_argument("--dry-run", action="store_true", help="muestra los cambios sin guardar nada")
    args = parser.parse_args(argv)

    if not args.root.is_dir():
        sys.exit(f"{args.root}: no es una carpeta")
    index = load_index(args.index)
    report = scan(args.root, index)
    if not args.dry_run:
        args.index.parent.mkdir(parents=True, exist_ok=True)
        with open(args.index, "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=1)
            f.write("\n")
        if args.csv:
            write_csv(index, args.csv)
    print_report(report, index)
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
