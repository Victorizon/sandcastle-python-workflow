# Sandcastle Workflow Diagrams (Single-Slice & Multi-Slice)

Visual reference for how agents, Docker containers, deterministic gates, and the **Proof-of-Work Verifier** execute across single-slice and multi-slice runs.

---

## 1. Single-Slice Lifecycle

```mermaid
flowchart TD
    P1["1. Planner Container<br/>(medium · picks slice 01)"] --> I1["2. Implementer Container<br/>(medium · isolated branch + check.py)"]
    I1 -->|check.py fails| F1["Fixer Container<br/>(up to 2 retries)"]
    F1 --> I1
    I1 -->|DriftWatchdog trips| D1["Decomposer Container<br/>(splits into 2-3 child slices)"]
    I1 -->|check.py passes| POW1["3. Proof-of-Work Verifier Container<br/>(medium · domain-grounded synthetic scenarios)"]
    POW1 --> R1["4. Fresh Adversarial Reviewer Container<br/>(high · review + PoW evidence + check.py + adversarial_scan.py)"]
    R1 -->|blocking finding| F2["Fixer Container<br/>(round 1 -> round 2)"]
    F2 --> R1
    R1 -->|approved| M1["5. Merger Container<br/>(medium · merges branch into main)"]
    M1 --> H1["Host Post-Merge Gates (0 containers)<br/>check.py + test_guard --base preMergeSha + adversarial_scan"]
    H1 -->|PASS| P2["6. Planner Container (Cycle 2)<br/>(sees 0 ready slices -> DONE)"]
    H1 -->|FAIL| RB["Atomic Rollback to preMergeSha<br/>+ escalate to ready-for-human"]
```

---

## 2. Multi-Slice Parallel Lifecycle (`MAX_PARALLEL = 2`)

```mermaid
flowchart TD
    P1["Planner Container<br/>(top 15 unblocked summaries -> selects 2 non-overlapping slices)"] --> IA["Implementer A<br/>(branch sandcastle/feat/01)"]
    P1 --> IB["Implementer B<br/>(branch sandcastle/feat/02)"]
    IA --> POWA["Proof-of-Work Verifier A<br/>(slice-level synthetic scenarios)"]
    IB --> POWB["Proof-of-Work Verifier B<br/>(slice-level synthetic scenarios)"]
    POWA --> RA["Fresh Adversarial Reviewer A<br/>(+ hard check.py & adversarial_scan)"]
    POWB --> RB["Fresh Adversarial Reviewer B<br/>(+ hard check.py & adversarial_scan)"]
    RA --> M["Merger Container<br/>(combines approved branches onto main)"]
    RB --> M
    M --> H["Host Post-Merge Gates (0 containers)<br/>check.py + test_guard --base preMergeSha + adversarial_scan"]
    H -->|FAIL| ROLL["Atomic Rollback to preMergeSha<br/>+ escalate batch to ready-for-human"]
    H -->|PASS| POWM["Cross-Slice Proof-of-Work Verifier<br/>(synthetic A+B interaction scenarios on main)"]
    POWM --> AUD["Post-Merge Cross-Slice Auditor<br/>(high · verifies combined diff + PoW evidence)"]
    AUD -->|blocking conflict| ROLL
    AUD -->|approved| NEXT["Next Cycle Planner<br/>(repeats until queue empty or SANDCASTLE_MAX_CYCLES)"]
```

---

## 3. Container & Agent Count Summary (Happy Path)

| Scenario | Containers / Agent Runs (PoW On, Default) | Max Concurrent Containers | Notes |
| --- | --- | --- | --- |
| **1 Slice** | **6** (Planner c1 → Implementer → PoW Verifier → Reviewer → Merger → Planner c2) | **1** | Cross-slice PoW & Post-Merge Auditor are skipped for 1 slice. |
| **10 Slices** (5 cycles × 2 parallel) | **46** (`5 × [1 Planner + 2 Implementers + 2 PoW + 2 Reviewers + 1 Merger + 1 Cross-Slice PoW + 1 Post-Merge Auditor]` + `1` final empty Planner) | **2** (`MAX_PARALLEL = 2`) | Set `SANDCASTLE_MAX_CYCLES=15` for headroom; disable PoW via `SANDCASTLE_POW_QA=0` if needed. |

*(Host post-merge gates — `check.py`, `test_guard.py`, `adversarial_scan.py` — run directly on the host with 0 containers.)*
