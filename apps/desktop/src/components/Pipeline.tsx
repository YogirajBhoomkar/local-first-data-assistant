import { useEffect, useMemo, useRef } from "react";
import { animate, createMotionPath, utils } from "animejs";
import { EDGES, type EdgeState, type NodeId, type PipelineView } from "../state/pipeline";
import { nodeInfo } from "../state/explain";

// Geometry of the map (SVG user units). The laptop zone is on the left, the cloud zone on the right.
const W = 116;
const H = 54;
export const POS: Record<NodeId, { x: number; y: number }> = {
  question: { x: 80, y: 70 },
  prep: { x: 225, y: 70 },
  router: { x: 370, y: 70 },
  answer: { x: 720, y: 70 },
  local: { x: 480, y: 200 },
  exec: { x: 600, y: 200 },
  verify: { x: 720, y: 200 },
  gate: { x: 480, y: 340 },
  egress: { x: 610, y: 340 },
  remote: { x: 905, y: 340 },
};
const BOUNDARY_X = 805;

function edgePath(e: { from: NodeId; to: NodeId }): string {
  const a = POS[e.from];
  const b = POS[e.to];
  const r = (n: number) => Math.round(n);
  if (a.y === b.y) return `M ${r(a.x + W / 2)} ${a.y} L ${r(b.x - W / 2)} ${b.y}`;
  if (e.from === "router") return `M ${a.x} ${a.y + H / 2} C ${a.x} ${b.y}, ${r(b.x - W / 2 - 70)} ${b.y}, ${r(b.x - W / 2)} ${b.y}`;
  if (e.from === "verify") return `M ${a.x} ${a.y - H / 2} L ${b.x} ${b.y + H / 2}`;
  // remote -> answer: up and around the right side of the laptop zone
  return `M ${a.x} ${a.y - H / 2} C ${a.x} ${b.y + 60}, ${r(b.x + W / 2 + 90)} ${b.y}, ${r(b.x + W / 2)} ${b.y}`;
}

const fmtMs = (ms?: number) => (ms === undefined ? "" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

export interface PipelineProps {
  view: PipelineView;
  mode: "table" | "doc";
  selected: NodeId | null;
  onSelect: (n: NodeId) => void;
  /** animation speed multiplier (0.5 = slow motion) */
  speed: number;
  /** replay or live: new packets are only drawn while something is moving */
  animateEnabled: boolean;
}

export default function Pipeline({ view, mode, selected, onSelect, speed, animateEnabled }: PipelineProps) {
  const packets = useRef<SVGGElement>(null);
  const nodeRefs = useRef<Partial<Record<NodeId, SVGGElement | null>>>({});
  const edgeRefs = useRef<Record<string, SVGPathElement | null>>({});
  const cloud = useRef<SVGRectElement>(null);
  const prevEdges = useRef<Map<string, EdgeState["state"]>>(new Map());
  const prevNodes = useRef<Map<NodeId, string>>(new Map());
  const prevCrossed = useRef(false);
  const mounted = useRef(false);

  const paths = useMemo(() => Object.fromEntries(EDGES.map((e) => [`${e.from}-${e.to}`, edgePath(e)])), []);

  // Reveal the nodes once.
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    const els = Object.values(nodeRefs.current).filter(Boolean) as SVGGElement[];
    utils.set(els, { opacity: 0 });
    animate(els, { opacity: [0, 1], translateY: [10, 0], delay: (_t, i) => (i ?? 0) * 60, duration: 500, ease: "outQuad" });
  }, []);

  // Packets travel along an edge the moment it becomes active (or completes).
  useEffect(() => {
    const layer = packets.current;
    for (const e of view.edges) {
      const key = `${e.from}-${e.to}`;
      const before = prevEdges.current.get(key);
      prevEdges.current.set(key, e.state);
      if (!animateEnabled || !layer) continue;
      const moved = (e.state === "active" || e.state === "done") && (before === undefined || before === "idle");
      if (!moved) continue;
      const path = edgeRefs.current[key];
      if (!path) continue;
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("r", e.lane === "remote" ? "7" : "6");
      dot.setAttribute("class", `packet packet--${e.lane}`);
      layer.appendChild(dot);
      const mp = createMotionPath(path);
      animate(dot, {
        translateX: mp.translateX,
        translateY: mp.translateY,
        opacity: [0, 1, 1, 0.2],
        scale: [0.6, 1.3, 1],
        duration: 900 / speed,
        ease: "inOutSine",
        onComplete: () => dot.remove(),
      });
    }
  }, [view.edges, speed, animateEnabled]);

  // A short pulse whenever a stage changes state.
  useEffect(() => {
    for (const [id, n] of Object.entries(view.nodes) as [NodeId, { status: string }][]) {
      const before = prevNodes.current.get(id);
      prevNodes.current.set(id, n.status);
      const el = nodeRefs.current[id];
      if (!animateEnabled || !el || before === undefined || before === n.status) continue;
      if (n.status === "active" || n.status === "done" || n.status === "error" || n.status === "waiting") {
        animate(el, { scale: [1, 1.1, 1], duration: 520 / speed, ease: "outBack" });
      }
    }
  }, [view.nodes, speed, animateEnabled]);

  // The laptop boundary lights up when something crosses it.
  useEffect(() => {
    if (view.crossed && !prevCrossed.current && animateEnabled && cloud.current) {
      animate(cloud.current, { strokeWidth: [2, 6, 2], opacity: [0.8, 1, 0.9], duration: 900 / speed, ease: "outQuad" });
    }
    prevCrossed.current = view.crossed;
  }, [view.crossed, speed, animateEnabled]);

  return (
    <svg className="pipe" viewBox="0 0 1000 440" role="img" aria-label="How this question moves through the system">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="pipe__arrowhead" />
        </marker>
      </defs>

      <rect className="zone zone--laptop" x="8" y="8" width={BOUNDARY_X - 16} height="424" rx="16" />
      <rect ref={cloud} className={`zone zone--cloud${view.crossed ? " is-crossed" : ""}`} x={BOUNDARY_X + 8} y="8" width={1000 - BOUNDARY_X - 16} height="424" rx="16" />
      <text className="zone__label" x="24" y="30">YOUR LAPTOP · files stay here</text>
      <text className="zone__label zone__label--cloud" x={BOUNDARY_X + 22} y="30">CLOUD</text>
      <line className={`boundary${view.crossed ? " is-crossed" : ""}`} x1={BOUNDARY_X} y1="40" x2={BOUNDARY_X} y2="430" />

      <text className="lane__label" x="400" y="170">local lane</text>
      <text className="lane__label lane__label--remote" x="400" y="310">escalation lane</text>

      {view.edges.map((e) => {
        const key = `${e.from}-${e.to}`;
        return (
          <path
            key={key}
            ref={(el) => {
              edgeRefs.current[key] = el;
            }}
            d={paths[key]}
            className={`edge edge--${e.lane} edge--${e.state}`}
            markerEnd="url(#arrow)"
            fill="none"
          />
        );
      })}

      {(Object.keys(POS) as NodeId[]).map((id) => {
        const { x, y } = POS[id];
        const n = view.nodes[id];
        const info = nodeInfo(id, mode);
        const isRemote = info.where === "cloud";
        return (
          <g
            key={id}
            className={`node node--${n.status}${isRemote ? " node--cloud" : ""}${selected === id ? " is-selected" : ""}`}
            transform={`translate(${x - W / 2}, ${y - H / 2})`}
            onClick={() => onSelect(id)}
            tabIndex={0}
            role="button"
            aria-label={`${info.label}: ${n.status}`}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(id)}
          >
            <title>{n.detail ? `${info.label}: ${n.detail}` : info.label}</title>
            <g
              className="node__body"
              ref={(el) => {
                nodeRefs.current[id] = el;
              }}
            >
              <rect className="node__box" width={W} height={H} rx="11" />
              <rect className="node__ring" width={W} height={H} rx="11" />
              <text className="node__label" x={W / 2} y="22" textAnchor="middle">
                {info.label}
              </text>
              <text className="node__sub" x={W / 2} y="38" textAnchor="middle">
                {n.status === "waiting" ? "waiting for you" : n.status === "skipped" ? "not needed" : id === "router" && n.status === "done" && view.route ? `→ ${view.route}` : n.ms !== undefined && n.status !== "idle" ? fmtMs(n.ms) : info.sub}
              </text>
              <circle className="node__dot" cx={W - 10} cy="10" r="4" />
            </g>
          </g>
        );
      })}

      <g ref={packets} className="packets" />
    </svg>
  );
}
