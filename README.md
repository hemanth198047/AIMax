# AImax
Private, local-first AI workspace (projects, people, scoped memory, guarded sandbox). See `docs/STATUS.md` for what is built and verified.

## Run
```
npm install
npm run dev            # server :3001 + client :5173
```

## Test
```
npm test               # server unit/integration tests (node:test)
npx playwright install chromium   # once
npm run test:e2e       # real-browser first-milestone walkthrough (set AIMAX_E2E_CHROME to use an installed Chrome)
```
Container sandbox isolation is only claimed when `AIMAX_TEST_DOCKER_IMAGE=<image> npm test` has passed on a machine with Docker.
