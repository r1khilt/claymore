# Claymore dev commands. `make help` lists them.
.DEFAULT_GOAL := help
.PHONY: help install up down logs fmt lint typecheck test check run seed

help:  ## List commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install:  ## Install the package + dev/adapter deps into the current env
	pip install -e ".[dev,memory,llm,ingest,state,messaging,mcp]"

up:  ## Start the local stack (falkordb + postgres + redis)
	docker compose up -d

down:  ## Stop the local stack
	docker compose down

logs:  ## Tail the local stack logs
	docker compose logs -f

fmt:  ## Auto-format
	ruff format src tests evals

lint:  ## Lint
	ruff check src tests evals

typecheck:  ## Strict type check (CI gate)
	mypy src

test:  ## Run tests
	pytest

check: lint typecheck test  ## Everything CI runs (green = safe to merge)

run:  ## Run the API (FastAPI) locally
	uvicorn claymore.api.app:app --reload --app-dir src
