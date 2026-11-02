# Role: Senior Full-Stack Engineer & AI Architect

## Objective

Build a **Multi-Agent Pipeline** that generates hyper-localized, risk-aware agricultural farming plans. The system must process raw user inputs through three specialized agents to produce a structured, human-readable, and multilingual output.

## Architecture Overview

The system follows a linear "Assembly Line" pattern:
`Input Data` → `[Agronomist Agent]` → `[Risk Assessment Agent]` → `[Content Editor Agent]` → `Final Output`

---

## 1. Agent Definitions & Responsibilities

### Agent A: The Agronomist (Planner)

**Role:** Generates the raw, linear agricultural timeline based on agronomic best practices.
**Inputs:**

- Location (Geo-coordinates or Region)
- Soil Data (Texture, pH, Nutrient levels)
- Crop Type (e.g., Maize, Soybeans)
- Seed Variety (e.g., Early Maturity vs. Late Maturity)
- Water Availability (Rain-fed vs. Irrigated)
- Field Size (Hectares/Acres)

**Logic Requirements:**

- Must account for crop lifecycle stages: Field Prep → Planting → Weeding → Fertilization → Harvest.
- Must adjust recommendations based on seed maturity type (e.g., Early maturity seeds require earlier planting windows).

### Agent B: The Risk Assessor (Critic)

**Role:** Reviews the Agronomist’s plan against historical climate data and local hazards to inject mitigation strategies.
**Inputs:**

- The raw timeline from Agent A.
- Historical Weather Patterns (e.g., 2023/24 drought trends, seasonal rainfall windows).
- Local Pests/Diseases data.

**Logic Requirements:**

- **Temporal Logic:** If planting date is late December, flag that "Late Maturity" seeds may not mature before dry season ends. Recommend "Early Maturity" seeds instead.
- **Weather Logic:** Inject warnings for extreme weather windows (drought, excessive rain, frost).
- **Output:** Append "Warning Flags" and "Mitigation Tips" to specific timeline stages.

### Agent C: The Content Editor (Translator/Formatter)

**Role:** Transforms the verified technical plan into a polished, human-readable format.
**Inputs:**

- The risk-adjusted plan from Agent B.

**Logic Requirements:**

- **Formatting:** Apply markdown structure, visual anchors (emojis), and clean bullet points.
- **Localization:** Support translation into local languages (specifically **Bemba** and **Nyanja**) if requested by the user.
- **Tone:** Professional yet accessible to smallholder farmers.

---

## 2. Standardized Output Schema

The final output must strictly follow this chronological layout. Do not deviate from this structure.

```text
📅 SEASONAL FARMING PLAN: [Crop Type] - [Location] - [Field Size]

🛠️ 1. Field Preparation
• [Actionable step for land clearing/tilling based on soil texture]
• [Base dressing/organic matter integration advice]

🌱 2. Planting & Spacing
• [Optimal planting depth and seed spacing targets]
• [Population density recommendations per hectare]
• ⚠️ [Risk Flag: e.g., "Planting late December requires Early Maturity seeds"]

🌿 3. Weeding & Crop Protection
• [Timing for early-stage weed interventions]
• [Scouting markers for common local pests/diseases]

🧪 4. Fertilizer Application
• [Split-application timelines: Basal vs. Top Dressing]
• [Placement technique advice to minimize nitrogen loss]

⚠️ 5. Critical Risks & Mitigation
• [Weather, drought, or soil acidity hazards specific to the zone]
• [Actionable backup plans if rain windows fail]

🌾 6. Harvest & Post-Harvest Tips
• [Visual indicators for physiological maturity and readiness]
• [Drying methods and moisture checks]
```
