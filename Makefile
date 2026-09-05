UV ?= uv
FLEET ?= 3
SPEED ?= 1
ARDUPILOT ?= $(HOME)/development/ardupilot

.PHONY: sync test schema hub fake-drone fake-fleet site sim sim-all console smoke

sync:
	$(UV) sync
	cd console && pnpm install

test:
	$(UV) run pytest -q

schema:
	$(UV) run python scripts/export_schema.py

site:
	$(UV) run python sim/site/gen_site.py --fleet $(FLEET)

hub:
	ARGUS_SPEED_FACTOR=$(SPEED) $(UV) run uvicorn hub.server:app --host 0.0.0.0 --port 8000 --reload

fake-drone:
	ARGUS_SPEED_FACTOR=$(SPEED) $(UV) run python -m sim.fake_drone --id drone-1 --home -60 -60

fake-fleet:
	@for i in $$(seq 1 $(FLEET)); do \
	  ARGUS_SPEED_FACTOR=$(SPEED) $(UV) run python -m sim.fake_drone --id drone-$$i --home $$((-60 + (i-1)*8)) -60 & \
	done; wait

# ArduCopter SITL x FLEET + Bridges, connecting to a Hub you started with `make hub`.
sim: site
	ARDUPILOT=$(ARDUPILOT) $(UV) run python scripts/launch_sim.py --fleet $(FLEET) --speedup $(SPEED)

sim-all: site
	ARDUPILOT=$(ARDUPILOT) ARGUS_SPEED_FACTOR=$(SPEED) $(UV) run python scripts/launch_sim.py --fleet $(FLEET) --speedup $(SPEED) --with-hub

console:
	cd console && pnpm dev

smoke:
	ARDUPILOT=$(ARDUPILOT) $(UV) run python scripts/smoke_flight.py --fleet 1 --renderer
