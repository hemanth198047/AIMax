# AImax
Private, local-first AI workspace (projects, people, scoped memory, guarded sandbox). See `docs/STATUS.md` for what is built and verified.

## Run
```
npm install
./aimax.ps1            # Windows: checks/repairs packages, starts Ollama if installed, starts server + UI, opens the browser
                       #   options: -Force (free busy ports)  -Reinstall (clean node_modules)  -NoOpen  -NoOllama  -Check
npm run aimax          # same, any OS:  node scripts/aimax-start.mjs [--force --reinstall --no-open --no-ollama --check]
npm run dev            # bare server :3001 + client :5173, no checks
```

## Test
```
npm test               # server unit/integration tests (node:test)
npx playwright install chromium   # once
npm run test:e2e       # real-browser first-milestone walkthrough (set AIMAX_E2E_CHROME to use an installed Chrome)
```
Container sandbox isolation is only claimed when `AIMAX_TEST_DOCKER_IMAGE=<image> npm test` has passed on a machine with Docker.
