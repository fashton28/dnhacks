# DNHacks drone safety platform

This repository keeps the integrated flight platform and the team's complementary planning components in clear, independent roots.

## Repository map

- [`platform/`](platform/) — companion software, ground station, simulator, site model, shared wire contracts, scripts, hardware documentation, and imported design assets.
- [`argus-core/`](argus-core/) — decision, validation, and vision component maintained as a separate Python package.
- [`mock-drone-agent/`](mock-drone-agent/) — mock-agent scenarios, schemas, and reports.
- [`docs/`](docs/) — cross-component architecture decisions, site policy, and failure modes.
- [`docs/REPOSITORY_REVIEW.md`](docs/REPOSITORY_REVIEW.md) — provenance evidence, contract discrepancies, and adapter guidance.
- [`docs/BASIC_DEMO_PENDING.md`](docs/BASIC_DEMO_PENDING.md) — basic demo gates, teammate progress, and video evidence plan.

### Removed roots

The pre-retrofit design (`ARCHITECTURE.md`, `CONTEXT.md`, the root `contracts/`
Pydantic package, and `docs/specs/0001`) targeted Webots and a fictional site, and
was superseded by the platform retrofit. It was deleted rather than kept in
parallel so the repository carries one runtime description. Nothing was rewritten
— recover any of it from Git history, and see
[`docs/adr/0001`](docs/adr/0001-webots-over-px4-gazebo.md) for why that design was
chosen and what replaced it.

## Platform commands

Run platform commands from the platform root so existing relative paths remain valid:

```bash
cd platform
make test
make build-ground
```

The root [CI workflow](.github/workflows/ci.yml) uses the relocated paths directly.
