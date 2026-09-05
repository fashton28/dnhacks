# DNHacks drone safety platform

This repository keeps the integrated flight platform and the team's complementary planning components in clear, independent roots.

## Repository map

- [`platform/`](platform/) — companion software, ground station, simulator, site model, shared wire contracts, scripts, hardware documentation, and imported design assets.
- [`argus-core/`](argus-core/) — decision and validation component maintained as a separate Python package.
- [`contracts/`](contracts/) — the team's earlier Pydantic model contracts.
- [`mock-drone-agent/`](mock-drone-agent/) — mock-agent scenarios, schemas, and reports.
- [`docs/`](docs/) — cross-component architecture decisions, site policy, failure modes, and specifications.
- [`docs/REPOSITORY_REVIEW.md`](docs/REPOSITORY_REVIEW.md) — provenance evidence, contract discrepancies, and adapter guidance.
- [`docs/BASIC_DEMO_PENDING.md`](docs/BASIC_DEMO_PENDING.md) — basic demo gates, teammate progress, and video evidence plan.

## Platform commands

Run platform commands from the platform root so existing relative paths remain valid:

```bash
cd platform
make test
make build-ground
```

The root [CI workflow](.github/workflows/ci.yml) uses the relocated paths directly.
