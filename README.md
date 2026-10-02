# NighGlow 5.0

Private, password-protected chat rooms. Node.js + Express + SQL.js.

## Run
```cmd
npm install
npm start
```
Open http://localhost:5000

## What's included
- 12+ sign-in check (username + date of birth)
- private password rooms with a **custom retention period** (choose 48 to 120 hours, plus minutes; default 48 hours), then they are deleted automatically
- text and file messages (member-only file access)
- **Roles**: the creator is the room's **alpha** (main owner). The alpha can make members **admins**, remove people (removed people cannot rejoin until the alpha allows them back) and delete the room. Admins can delete messages.
- **Mentions**: type `#` and pick a member; `#username` is highlighted in the chat (stronger highlight for the person mentioned)
- **AI commands** (start a message with the tag): `@gemini`, `@groq`, `@openr` (OpenRouter). Answers use paragraphs and points, never tables.
- security headers, rate limits, `/healthz`
- works on phones and tablets (single-pane layout)

## AI setup (add keys in `.env`, or in Railway → Variables)
| Tag | Variable | Default model | Max reply |
|---|---|---|---|
| `@gemini` | `GEMINI_API_KEY` (free key: https://aistudio.google.com/apikey) | `gemini-3.8-flash` | 65,536 tokens |
| `@groq` | `GROQ_API_KEY` | `openai/gpt-oss-120b` | 65,536 tokens |
| `@openr` | `OPENROUTER_API_KEY` | `openai/gpt-oss-120b` | 131,072 tokens |

If a provider's free plan can't allow the maximum, the server automatically retries with the biggest size it accepts.

## Hosting (Railway)
Use a persistent volume, otherwise the database (users, rooms, messages) is wiped on every redeploy:
`DB_PATH=/data/nightline.sqlite`
`UPLOAD_DIR=/data/uploads`

Never commit `.env` or real API keys.
