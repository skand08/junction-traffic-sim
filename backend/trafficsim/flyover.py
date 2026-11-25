"""Flyovers: carry a road over a junction on its own deck (grade separation).

For each deck, the approach road is split `ramp` metres before the junction and the departure road `ramp`
metres after it. The new flyover edge joins the two split points and never touches the junction node, so its
traffic has no conflict with anything at the junction; SUMO does not model crossing edges geometrically.
Turning traffic and the cross street keep the junction at street level through the "<edge>_atgrade" pieces.

Ids, chosen so the rest of the network and the demand stay valid:
  approach  A  ->  A (upstream piece, same id) + A_atgrade (ramp-down piece into the junction)
  departure B  ->  B_atgrade (piece out of the junction) + B (downstream piece, same id)
  deck         <node>_flyover_<k> from fly_<node>_<k>_up to fly_<node>_<k>_down

Explicit routes are rewritten the same way ("A B" straight through becomes "A deck B"; turns get the
_atgrade pieces), so a comparison with and without the flyover differs only by the flyover itself.
"""
import math
import xml.etree.ElementTree as ET
from pathlib import Path
from xml.sax.saxutils import quoteattr

MIN_PIECE_M = 20.0          # shortest road piece left on either side of a ramp
STRAIGHT_DEG = 35.0         # a movement within this angle of straight counts as "straight on"


class FlyoverError(ValueError):
    pass


def _heading(a, b) -> float:
    return math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))


def _turn(e_in, e_out) -> float:
    s_in, s_out = e_in.getShape(), e_out.getShape()
    d = _heading(s_in[-2], s_in[-1]) - _heading(s_out[0], s_out[1])
    return abs((d + 180) % 360 - 180)


def _compass(e) -> str:
    s = e.getShape()
    ang = (90 - _heading(s[0], s[-1])) % 360          # 0 = north, clockwise
    return ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][int((ang + 22.5) // 45) % 8]


def through_options(net, node_id: str) -> list:
    """Roads that go straight on through the junction (one entry per axis, with its opposite direction)."""
    node = net.getNode(node_id)
    out, seen = [], set()
    for e in node.getIncoming():
        if e.getFunction() == "internal" or not e.allows("passenger"):
            continue
        best = None
        for o in e.getOutgoing():
            if o.getFromNode().getID() != node_id or not o.allows("passenger") or o.getToNode() == e.getFromNode():
                continue
            t = _turn(e, o)
            if t <= STRAIGHT_DEG and (best is None or t < best[1]):
                best = (o, t)
        if not best or (e.getID(), best[0].getID()) in seen:
            continue
        o = best[0]
        rev_in = next((x for x in node.getIncoming() if x.getFromNode() == o.getToNode() and x.allows("passenger")), None)
        rev_out = next((x for x in node.getOutgoing() if x.getToNode() == e.getFromNode() and x.allows("passenger")), None)
        reverse = None
        if rev_in and rev_out and rev_out in rev_in.getOutgoing():
            reverse = dict(from_edge=rev_in.getID(), to_edge=rev_out.getID())
            seen.add((rev_in.getID(), rev_out.getID()))
        seen.add((e.getID(), o.getID()))
        out.append(dict(from_edge=e.getID(), to_edge=o.getID(), heading=_compass(o), reverse=reverse,
                        lanes=min(e.getLaneNumber(), o.getLaneNumber()),
                        max_ramp_m=round(min(e.getLength(), o.getLength()) - MIN_PIECE_M)))
    return out


def plan(net, edits: list) -> list:
    """Decks for all flyover edits, checked against the network. Raises FlyoverError with a readable message."""
    decks, used = [], {}
    for ed in edits:
        if not net.hasNode(ed.node):
            raise FlyoverError(f"Junction '{ed.node}' does not exist in this network.")
        opts = through_options(net, ed.node)
        match = next((o for o in opts if (o["from_edge"], o["to_edge"]) == (ed.from_edge, ed.to_edge)
                      or (o["reverse"] and (o["reverse"]["from_edge"], o["reverse"]["to_edge"]) == (ed.from_edge, ed.to_edge))), None)
        if not match:
            raise FlyoverError(f"At junction {ed.node} no road goes straight on from '{ed.from_edge}' to '{ed.to_edge}'.")
        pairs = [(ed.from_edge, ed.to_edge)]
        if ed.both_ways:
            other = match["reverse"] if (match["from_edge"], match["to_edge"]) == (ed.from_edge, ed.to_edge) else \
                dict(from_edge=match["from_edge"], to_edge=match["to_edge"])
            if not other:
                raise FlyoverError(f"The road through junction {ed.node} is one-way; build the flyover in one direction only.")
            pairs.append((other["from_edge"], other["to_edge"]))
        for k, (a, b) in enumerate(pairs):
            ea, eb = net.getEdge(a), net.getEdge(b)
            for x in (a, b):
                if x in used:
                    raise FlyoverError(f"Road '{x}' already carries a ramp of the flyover at junction {used[x]}.")
            ramp = float(ed.ramp_m)
            room = min(ea.getLength(), eb.getLength()) - MIN_PIECE_M
            if room < 30:
                raise FlyoverError(f"The roads at junction {ed.node} are too short for flyover ramps "
                                   f"({round(min(ea.getLength(), eb.getLength()))} m; at least {round(30 + MIN_PIECE_M)} m needed).")
            ramp = min(ramp, room)
            used[a] = used[b] = ed.node
            decks.append(dict(node=ed.node, k=k, a=a, b=b, a_len=ea.getLength(), ramp=ramp,
                              a_lanes=ea.getLaneNumber(), lanes=ed.lanes, speed=ed.speed_kmh / 3.6,
                              deck=f"{ed.node}_flyover_{k}", up=f"fly_{ed.node}_{k}_up", down=f"fly_{ed.node}_{k}_down",
                              a_at=f"{a}_atgrade", b_at=f"{b}_atgrade"))
    return decks


def patches(decks: list) -> tuple[dict, list, list]:
    """(split children per edge id, new deck edges, diverge connections) as plain-XML fragments."""
    splits, edges, cons = {}, [], []
    for d in decks:
        splits.setdefault(d["a"], []).append(
            f'<split pos="{d["a_len"] - d["ramp"]:.2f}" id={quoteattr(d["up"])} idBefore={quoteattr(d["a"])} idAfter={quoteattr(d["a_at"])}/>')
        splits.setdefault(d["b"], []).append(
            f'<split pos="{d["ramp"]:.2f}" id={quoteattr(d["down"])} idBefore={quoteattr(d["b_at"])} idAfter={quoteattr(d["b"])}/>')
        edges.append(f'  <edge id={quoteattr(d["deck"])} from={quoteattr(d["up"])} to={quoteattr(d["down"])} numLanes="{d["lanes"]}" '
                     f'speed="{d["speed"]:.2f}" priority="15"><param key="flyover" value={quoteattr(d["node"])}/></edge>\n')
        # the approach keeps its connections into the at-grade piece; every lane may also take the ramp up
        for i in range(d["a_lanes"]):
            cons.append(f'  <connection from={quoteattr(d["a"])} to={quoteattr(d["deck"])} fromLane="{i}" toLane="{min(i, d["lanes"] - 1)}"/>\n')
    return splits, edges, cons


def remap(edge: str, role: str, decks: list) -> str:
    """Ids for other edits written against the original roads: a turn out of an approach now leaves from its
    at-grade piece, and a turn into a departure road enters its at-grade piece."""
    for d in decks:
        if role == "from" and edge == d["a"]:
            return d["a_at"]
        if role == "to" and edge == d["b"]:
            return d["b_at"]
    return edge


def rewrite_route(edges: list, decks: list) -> list:
    for d in decks:
        if d["a"] not in edges and d["b"] not in edges:
            continue
        out = []
        for i, e in enumerate(edges):
            nxt = edges[i + 1] if i + 1 < len(edges) else None
            prv = edges[i - 1] if i else None
            if e == d["a"]:
                out += [e, d["deck"]] if nxt == d["b"] else ([e, d["a_at"]] if nxt is not None else [e])
            elif e == d["b"]:
                out += [e] if prv == d["a"] or prv is None else [d["b_at"], e]
            else:
                out.append(e)
        edges = out
    return edges


def rewrite_demand(src: Path, dst: Path, decks: list) -> int:
    """Copy of the demand with explicit routes adapted to the flyovers; returns the number of routes changed."""
    tree = ET.parse(src)
    changed = 0
    for el in tree.getroot().iter("route"):
        if el.get("edges"):
            old = el.get("edges").split()
            new = rewrite_route(old, decks)
            if new != old:
                el.set("edges", " ".join(new))
                changed += 1
    tree.write(dst, encoding="unicode")
    return changed
