"""LLM layer for the autonomous drone ISR agent.

Layers, in dependency order — each one only knows about the ones above it:

    facility / types / geo     plain data and geometry, no I/O
    events                     append-only JSONL log (the dashboard's input)
    anomaly                    mock satellite change-detection layer
    llm                        the only file that talks to the Claude API
    planner                    anomaly + constraints -> mission plan
    verifier                   the trust layer: no model, only hard rules
    executor                   the seam with drone control / PX4 SITL
    triage                     observations -> decision + incident report
    orchestrator               the loop that wires all of the above together
"""

__all__ = [
    "anomaly",
    "events",
    "executor",
    "facility",
    "geo",
    "llm",
    "orchestrator",
    "planner",
    "triage",
    "types",
    "verifier",
]
