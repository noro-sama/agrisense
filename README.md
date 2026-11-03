<a name="readme-top"></a>

<h1 align="center">Agrisense</h1>

# 📗 Table of Contents

- [📖 About the Project](#about-project)
  - [🛠 Built With](#built-with)
    - [Tech Stack](#tech-stack)
    - [Key Features](#key-features)
  - [🚀 Live Demo](#live-demo)
- [💻 Getting Started](#getting-started)
  - [Setup](#setup)
  - [Prerequisites](#prerequisites)
  - [Install](#install)
  - [Usage](#usage)
  - [Run tests](#run-tests)
  - [Deployment](#triangular_flag_on_post-deployment)
- [🌍 Impact](#impact)
- [👥 Authors](#authors)
- [🔭 Future Features](#future-features)
- [🤝 Contributing](#contributing)
- [⭐️ Show your support](#support)
- [🙏 Acknowledgements](#acknowledgements)
- [❓ FAQ](#faq)
- [📝 License](#license)

# 📖 About the Project <a name="about-project"></a>

> Hyper-local planting advice for Zambian smallholder farmers, grounded in live weather — never guessed.

**Agrisense** is an agricultural decision engine built for the Meta Global AI Developer Hackathon. Farmers message it on Telegram with their district and crop; it fetches the live 7-day forecast and provincial soils, computes agronomic features server-side, and asks Muse Spark to reason only over those numbers. The model never sees raw API payloads and never invents figures — every output is validated against its input before it reaches the farmer, who always makes the final call.

The problem is personal: planting in the wrong window drowns seedlings, stunts growth, and not knowing how to manage dry spells when fertilising can burn roots — a mistake this project has watched happen firsthand.

## 🛠 Built With <a name="built-with"></a>

### Tech Stack <a name="tech-stack"></a>

<details>
  <summary>Client</summary>
  <ul>
    <li>Telegram bot (<a href="https://github.com/yagop/node-telegram-bot-api">node-telegram-bot-api</a>, long polling)</li>
    <li>Plain HTML/CSS/JS web app (no framework)</li>
  </ul>
</details>

<details>
  <summary>AI models</summary>
  <ul>
    <li>Muse Spark series (<a href="https://api.meta.ai">Meta Model API</a> — advisories, vision, translation, plans)</li>
    <li>Muse code</li>
    <li>Muse Image, for image generation</li>
  </ul>
</details>

<details>
  <summary>Server</summary>
  <ul>
    <li><a href="https://expressjs.com/">Express.js</a> (Node.js 18+, CommonJS)</li>
    <li><a href="https://api.meta.ai">Meta Model API</a> — <code>muse-spark-1.3</code> (advisories, crop-health vision, translation, farming plans)</li>
    <li><a href="https://rigo.agririgo.com/api/v1">AgriRigo API</a> (live weather relay, soils, districts, historical drought)</li>
  </ul>
</details>

### Key Features <a name="key-features"></a>

- **Plant-or-wait advisories** — effective-rain detection per crop, with timing, risks, and honest WAITs.
- **📷 Crop health from photos** — disease/pest verdicts (HEALTHY/SUSPECT) with action steps.
- **Local languages** — every answer re-renderable in Bemba, Nyanja, Tonga, or English.
- **Season farming plans** — 3-agent pipeline (Agronomist → Risk Assessor → Editor) on the web app, printable.
- **Learn page** — plain-language guides: El Niño/La Niña, dry spells, per-crop dry-spell management, fertiliser timing.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## 🚀 Live Demo <a name="live-demo"></a>

- [Telegram bot](https://t.me/agrisense_zed_bot) — chat with Agrisense now.
- [Live web app](https://agrisense-f5ky.onrender.com) - go and make a crop or livestock farming plan

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## 💻 Getting Started <a name="getting-started"></a>

To get a local copy up and running, follow these steps.

### Prerequisites

In order to run this project you need:

- Node.js 18+
- A Telegram bot token (via [@BotFather](https://t.me/BotFather))
- A Meta Model API key (`MODEL_API_KEY`)

### Setup

Clone this repository to your desired folder:

```sh
git clone https://github.com/noro-sama/agrisense.git
cd agrisense
```

### Install

Install this project with:

```sh
npm install
cp .env.example .env
```

Then fill in `.env`: `TELEGRAM_BOT_TOKEN`, `MODEL_API_KEY`, `MODEL_API_BASE_URL` (`https://api.meta.ai`), `MODEL_ID` (`muse-spark-1.3`), `AGRIRIGO_BASE_URL` (`https://rigo.agririgo.com/api/v1`), `PORT`.

### Usage

To run the project, execute the following command:

```sh
npm start
```

- Web app: `http://localhost:3000` (plan form, learn page)
- Health: `http://localhost:3000/api/health`
- Telegram: message your bot (`/start`, then tap Plant, 📷 Crop health, or Farming plan)

### Run tests

To run tests, run the following command:

```sh
npm test                    # unit checks (features, cache, parsers)
npm run validate:districts  # district coordinate sanity
node scripts/verify-translations.js  # live advisory + 3 translations (uses API key)
node scripts/verify-vision.js        # live crop-health verdicts (uses API key)
```

### Deployment <a name="triangular_flag_on_post-deployment"></a>

You can deploy this project using any Node.js host (Render, Railway, Fly.io, VPS):

```sh
npm install --production
node server/index.js
```

Set the same env vars in production. Note: Telegram uses long polling, so run exactly one instance.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## 🌍 Impact <a name="impact"></a>

Target: smallholder farmers across ~40 Zambian agricultural districts, advised in 4 languages, grounded in live AgriRigo weather and soils. Success looks like fewer mistimed plantings, earlier disease catches from photos, and advice farmers can read in their own language.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## 👥 Authors <a name="authors"></a>

👤 **Author**

- GitHub: [@noro-sama](https://github.com/noro-sama)
- LinkedIn: [@tracy-muso](https://linkedin.com/in/tracy-muso)
- X: [@tracy-muso](https://x.com/tracy-muso)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## 🔭 Future Features <a name="future-features"></a>

- [ ] **Agrisense chatbot** — a chatbot that converses only on agriculture-related topics.
- [ ] **Voice notes** — spoken questions and answers for low-literacy farmers.
- [ ] **Fertiliser & tillage advisories** — engine built, re-enable behind the action gate.
- [ ] **Whatsapp Integration** — once funding is available, we will use whatsapp, one of the most widely used messaging platforms.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## 🤝 Contributing <a name="contributing"></a>

Contributions, issues, and feature requests are welcome!

Feel free to check the [issues page](https://github.com/noro-sama/agrisense/issues/).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## ⭐️ Show your support <a name="support"></a>

If you like this project, give it a star — and if you farm in Zambia, try the bot and tell us what it got right and wrong.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## 🙏 Acknowledgements <a name="acknowledgements"></a>

- [AgriRigo](https://rigo.agririgo.com) for the open agricultural data engine (ZamStats, FAOSTAT, ISRIC SoilGrids, CHIRPS sources underneath).
- Meta, Cerebral Valley for hosting the Global AI Developer Hackathon.
- Zambia's extension officers — the human layer no bot replaces.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## ❓ FAQ <a name="faq"></a>

- **Why does the bot say WAIT so often?**
  - It only says PLANT when the forecast shows effective rain for your specific crop inside the 7-day window. A cautious no beats a wrong yes when seed is on the line.
- **Can the model invent rainfall numbers?**
  - No. It receives only pre-computed features (totals, dates, counts) and every reply is validated against them — a rain date with no effective rain in the features gets overridden to WAIT.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## 📝 License <a name="license"></a>

This project is [MIT](./LICENSE) licensed.

<p align="right">(<a href="#readme-top">back to top</a>)</p>
