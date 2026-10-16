"""Extracción de datos de un GPX y clasificación por disciplina.

Las reglas y los nombres de campo siguen los de catalogo/catalog.py del
proyecto, para que el índice y catalogo_rutas.csv no diverjan. Lo que depende
solo del contenido del archivo se calcula en extract() y se guarda en el
índice; lo que depende de la ruta del archivo (carpeta, disciplina por
carpeta, nombre por defecto) se calcula en classify() sin volver a parsear.
"""

import math
import os
import re
import xml.etree.ElementTree as ET
from datetime import datetime

WIKI_CAT = {
    "mountain-biking-trails": "MTB", "gravel-bike-trails": "Gravel", "hiking-trails": "Senderismo",
    "mountaineering-trails": "Montañismo", "back-country-skiing-trails": "Esquí de travesía",
    "bicycle-touring-trails": "Cicloturismo", "ebike-trails": "E-bike", "via-ferrata-trails": "Vía ferrata",
    "walking-trails": "Senderismo", "trail-running-trails": "Trail running", "cycling-trails": "Ciclismo carretera",
    "running-trails": "Running",
}
# Subidas o bajadas menores que esto se consideran ruido del GPS.
ELEVATION_THRESHOLD_M = 5.0
# Distancia máxima entre inicio y fin para considerar una ruta circular.
LOOP_MAX_GAP_M = 500
EARTH_RADIUS_M = 6371008.8


def local(tag):
    return tag.rsplit("}", 1)[-1]


def haversine(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    d = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(d))


def parse_time(s):
    s = s.strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        try:
            return datetime.fromisoformat(re.sub(r"\.\d+", "", s))
        except ValueError:
            return None


def gain_loss(eles, thr=ELEVATION_THRESHOLD_M):
    """Desnivel con histéresis: solo cuenta cuando la cota se aleja thr metros de la referencia."""
    up = dn = 0.0
    ref = eles[0]
    for e in eles[1:]:
        if e - ref >= thr:
            up += e - ref
            ref = e
        elif ref - e >= thr:
            dn += ref - e
            ref = e
    return up, dn


def hms(seconds):
    return "%d:%02d" % (int(seconds // 3600), int(seconds % 3600 // 60))


def find_wikiloc(links, raw):
    for link in links:
        m = re.search(r'wikiloc\.com/([a-z-]+-trails)/[^\s"]*?-(\d+)(?:$|[/?#])', link)
        if m:
            return m.group(1), m.group(2), link
    m = re.search(rb'wikiloc\.com/([a-z-]+-trails)/[^\s"<]*?-(\d+)', raw)
    if m:
        return m.group(1).decode(), m.group(2).decode(), m.group(0).decode()
    m = re.search(rb"wikiloc\.com/wikiloc/view\.do\?id=(\d{5,})", raw)
    if m:
        wid = m.group(1).decode()
        return "", wid, "https://www.wikiloc.com/wikiloc/view.do?id=" + wid
    return "", "", ""


def extract(raw):
    """Datos de un GPX que dependen solo de su contenido. Lanza ET.ParseError si el XML es inválido."""
    root = ET.fromstring(raw)
    creator = root.get("creator", "")
    name = meta_time = None
    links = []
    for el in root.iter():
        t = local(el.tag)
        if t == "link" and el.get("href"):
            links.append(el.get("href"))
        if t == "url" and el.text:
            links.append(el.text.strip())
    md = [c for c in root if local(c.tag) == "metadata"]
    for c in (md[0] if md else root):
        if local(c.tag) == "name" and c.text and not name:
            name = c.text.strip()
        if local(c.tag) == "time" and c.text and not meta_time:
            meta_time = parse_time(c.text)
    trknames, segs = [], []
    for el in root:
        t = local(el.tag)
        if t not in ("trk", "rte"):
            continue
        for c in el:
            if local(c.tag) == "name" and c.text:
                trknames.append(c.text.strip())
        if t == "trk":
            segs.extend([p for p in s if local(p.tag) == "trkpt"] for s in el if local(s.tag) == "trkseg")
        else:
            segs.append([p for p in el if local(p.tag) == "rtept"])
    if not name and trknames:
        name = trknames[0]
    if name:
        name = re.sub(r"^Wikiloc - ", "", name)
    nwpt = sum(1 for el in root if local(el.tag) == "wpt")

    dist = moving = 0.0
    eles, times = [], []
    npts = 0
    first = last = None
    for seg in segs:
        prev = pt_prev = None
        for p in seg:
            try:
                ll = (float(p.get("lat")), float(p.get("lon")))
            except (TypeError, ValueError):
                continue
            npts += 1
            e = tm = None
            for c in p:
                tt = local(c.tag)
                if tt == "ele" and c.text:
                    try:
                        e = float(c.text)
                    except ValueError:
                        pass
                elif tt == "time" and c.text:
                    tm = parse_time(c.text)
            if e is not None and -500 < e < 9000:
                eles.append(e)
            if tm:
                times.append(tm)
            if first is None:
                first = ll
            last = ll
            if prev:
                d = haversine(prev, ll)
                dist += d
                if tm and pt_prev and d > 0:
                    dt = (tm - pt_prev).total_seconds()
                    if 0 < dt < 120 and d / dt > 0.5:
                        moving += dt
            prev, pt_prev = ll, tm

    wcat, wid, wurl = find_wikiloc(links, raw)
    up, dn = gain_loss(eles) if len(eles) >= 2 else (None, None)
    dur = fecha = dur_note = ""
    if len(times) >= 2:
        try:
            span = (max(times) - min(times)).total_seconds()
        except TypeError:  # mezcla de horas con y sin zona
            span = 0
        if span > 86400:
            dur_note = "tiempos de varios días o unidos"
        elif span > 60:
            dur = hms(span)
        fecha = min(times, key=lambda t: t.replace(tzinfo=None)).date().isoformat()
    elif meta_time:
        fecha = meta_time.date().isoformat()
    mov = hms(moving) if moving > 60 and dur else ""
    loop = first and last and haversine(first, last) < LOOP_MAX_GAP_M and dist > 1000

    notes = []
    if npts == 0:
        notes.append("sin puntos de track")
    if not eles:
        notes.append("sin altitud")
    if dur_note:
        notes.append(dur_note)
    elif len(times) < 2 or not dur:
        notes.append("sin tiempos reales")

    return {
        "nombre_gpx": name or "",
        "km": round(dist / 1000, 1) if npts else "",
        "desnivel_pos_m": round(up) if up is not None else "",
        "desnivel_neg_m": round(dn) if dn is not None else "",
        "alt_max_m": round(max(eles)) if eles else "",
        "alt_min_m": round(min(eles)) if eles else "",
        "duracion_total": dur,
        "tiempo_movimiento": mov,
        "fecha": fecha,
        "tipo": ("Circular" if loop else "Lineal") if npts else "",
        "inicio_lat": round(first[0], 5) if first else "",
        "inicio_lon": round(first[1], 5) if first else "",
        "wikiloc_cat": wcat,
        "wikiloc_id": wid,
        "wikiloc_url": wurl,
        "origen": creator.split(" - ")[0][:40],
        "creator": creator,
        "velocidad_mov_kmh": round(dist / 1000 / (moving / 3600), 2) if moving > 600 else "",
        "puntos": npts,
        "waypoints": nwpt,
        "nota": ", ".join(notes),
    }


def discipline_from_path(rel, name):
    p = rel.lower()
    n = (name or "").lower() + " " + os.path.basename(p)
    if "ferrata" in n:
        return "Vía ferrata"
    if "esqui" in n or "esquí" in n or "skimo" in n or p.startswith("travesia/"):
        return "Esquí de travesía"
    if p.startswith("bikepacking/"):
        return "Bikepacking"
    if p.startswith("gravel/"):
        return "Gravel"
    if p.startswith("mtb") or "mtb" in n or "btt" in n or "enduro" in n:
        return "MTB"
    if p.startswith("trail/"):
        return "Trail / montaña"
    if p.startswith("picoseuropa/") or p.startswith("findepirineos/") or "aneto" in n:
        return "Montañismo"
    return ""


def classify(rel, track):
    """Disciplina y su fuente para un archivo del índice en la ruta rel."""
    if "error" in track:
        return "", ""
    name = track.get("nombre_gpx")
    wcat = track.get("wikiloc_cat", "")
    if wcat in WIKI_CAT:
        return WIKI_CAT[wcat], "Wikiloc"
    disc = discipline_from_path(rel, name)
    if disc:
        return disc, "carpeta/nombre"
    if "trailforks" in (track.get("creator", "") + rel).lower():
        return "MTB", "Trailforks"
    v = track.get("velocidad_mov_kmh")
    if v != "" and v is not None:
        if v >= 9:
            return "MTB", "velocidad (%.0f km/h)" % v
        if v <= 6.5:
            return "Senderismo", "velocidad (%.0f km/h)" % v
    return "Sin clasificar", ""
