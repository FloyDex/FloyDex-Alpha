# ClawPump wiring (no token launch)

The FloyDex agent already exists on ClawPump. This skill is the perps desk.

## Do

- Enable: `portfolio`, `market-intelligence`, `wallet`, `perps`
- Point chat at this `SKILL.md`
- Call the product desk `POST /api/desk/brief` for UsePod-backed session briefs

## Do not

- Do not enable `token-launch`
- Do not run `npx clawpump launch`
- Do not POST `/api/v1/launch`

The operator will say when to tokenize. Until then this is an agent + skill, not a coin.
