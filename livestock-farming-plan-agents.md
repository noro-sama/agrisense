# Role: Senior Full-Stack Engineer & AI Architect

## Objective

Build a **Multi-Agent Pipeline** for **Smallholder Livestock Management**. The system generates customized rearing plans, housing blueprints, and health schedules for small animals (poultry, guinea pigs, rabbits, goats, and small pigs).

**Unique Feature:** The final output includes **AI-generated visual blueprints** of the housing structure (e.g., a 2D/3D render of a brick coop vs. a wooden run) tailored to the user's specific space and animal count.

---

## Architecture Overview

`User Input (Animal, Count, Space Type/Size)` → `[Livestock Planner Agent]` → `[Health & Risk Agent]` → `[Visual Content Editor Agent]` → `Final Output`

---

## 1. Agent Definitions & Responsibilities

### Agent A: The Livestock Planner (Architect)

**Role:** Designs the rearing plan and calculates resource requirements based on the animal type and available space.
**Inputs:**

- Animal Type (e.g., Guinea Pigs, Broiler Chickens, Dwarf Pigs, Goats)
- Quantity (Number of heads/birds)
- Space Type (e.g., Wooden Barn, Brick & Mortar, Free-range, Indoor Corner)
- Space Dimensions (Length x Width x Height, or sq. meters)

**Logic Requirements:**

- **Space Calculation:** Calculate stocking density (e.g., sq. meters per bird/head). If the user's space is too small for the requested quantity, flag this as an error.
- **Infrastructure Design:** Recommend specific housing materials (local vs. imported) suitable for smallholder budgets.
- **Resource Planning:** Generate daily feed, water, and bedding requirements based on the animal's weight and growth stage.

### Agent B: The Health & Risk Assessor (Veterinary Critic)

**Role:** Reviews the plan for biosecurity risks, disease outbreaks, and seasonal hazards.
**Inputs:**

- The rearing plan from Agent A.
- Local Disease Prevalence Data (e.g., Newcastle Disease in poultry, Coccidiosis in rabbits).
- Seasonal Weather Data.

**Logic Requirements:**

- **Biosecurity:** Inject warnings about predator protection (snakes, dogs, birds of prey) based on the housing type (e.g., "Wooden barns need mesh reinforcement against snakes").
- **Vaccination Schedule:** Generate a strict vaccination and deworming timeline.
- **Seasonal Mitigation:**
  - _Rainy Season:_ Warning about dampness and respiratory issues. Recommend raised flooring.
  - _Dry Season:_ Warning about heat stress and water scarcity. Recommend shade structures.

### Agent C: The Visual Content Editor (Translator/Formatter/Designer)

**Role:** Transforms the technical plan into a visual, human-readable guide and generates **Image Assets**.
**Inputs:**

- The risk-adjusted plan from Agent B.

**Logic Requirements:**

- **Text Formatting:** Use markdown, emojis, and simple language suitable for smallholder farmers.
- **Translation:** Support Bemba, Nyanja, and English.
- **Image Generation (CRITICAL):**
  - Generate a **Housing Blueprint Image** showing the exact layout of the barn/run based on the user's dimensions.
  - Generate **Iconographic Guides** for key tasks (e.g., an image of "Correct Feeding Posture" or "Signs of Sickness").
  - _Prompt for Image Model:_ "Create a clear, instructional 3D render or technical blueprint of a [Animal Type] housing unit for smallholder farmers. Materials: [Material Type]. Dimensions: [Dimensions]. Style: Clean, bright, educational."

---

## 2. Standardized Output Schema

The final output must follow this structure:

```text
🐾 SMALLHOLDER LIVESTOCK PLAN: [Animal Type] - [Quantity] - [Space Type]

📐 1. Housing & Space Design
• [Recommended Layout: e.g., "Stacked Cage System" or "Floor Pen"]
• [Material List: Local alternatives (bamboo, timber, bricks)]
• [Space Check: "Your 2m x 2m space fits 20 guinea pigs comfortably."]
🖼️ [IMAGE: Generated Blueprint of the Housing Unit]

🍽️ 2. Feeding & Nutrition
• [Daily Feed Requirements: Type and Quantity per animal]
• [Cost-Effective Local Feed Alternatives]
• [Water Access Points]

🏥 3. Health & Biosecurity
• [Vaccination Schedule: Dates and Diseases]
• [Daily Health Check Checklist]
• ⚠️ [Risk Flag: e.g., "High predator risk in wooden barns; install wire mesh"]

🌦️ 4. Seasonal Management
• [Rainy Season Tips: e.g., "Use deep litter method to absorb moisture"]
• [Dry Season Tips: e.g., "Provide shade to prevent heat stress"]

📅 5. Routine Schedule
• [Morning: Cleaning, Feeding, Health Check]
• [Afternoon: Water Refill, Egg Collection/Grazing]
```
